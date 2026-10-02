// Annotations : un canvas par page. Objets en coordonnées normalisées (x,y en 0..1 de la page).
//   trait  : { t:'pen'|'hl', c, w, p:[[x,y,pression]...], pr }
//   texte  : { t:'text', c, x, y (centre), s (taille / largeur page), r (rotation rad), text }

const FONT = (px) => `600 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`

export class Ink {
  constructor(scroller, onChange) {
    this.scroller = scroller
    this.onChange = onChange
    this.pages = []
    this.enabled = false
    this.tool = 'pen'          // pen | hl | eraser | text | emoji
    this.emoji = '〰️'
    this.shape = 'ellipse'     // ellipse | rect | line | arrow | cresc | decresc
    this.color = '#138a4a'
    this.size = 2
    this.fingerDraws = false
    this.undoStack = []
    this.redoStack = []
    this.current = null
    this._touch = null
    this.sel = null            // {pg, o}
    this.onEditText = null     // (initialText, cb(text|null)) fourni par l'appli
    this._measure = document.createElement('canvas').getContext('2d')
    this.lastActivity = 0
    this.touches = new Map()
    this._pan = null
  }

  // calque en lecture seule (annotations de quelqu'un d'autre), dessiné sous les siennes
  setUnder(data, who) {
    this.under = data || null
    if (who !== undefined) this.underWho = who
    for (const pg of this.pages) this.redraw(pg)
  }
  setUnderVisible(on) { this.underVisible = on; for (const pg of this.pages) this.redraw(pg) }

  // wins (facultatif, ligne continue) : pour chaque page, la fenêtre visible { y0, y1 } (0..1) :
  // la toile ne couvre que cette fenêtre, et n'existe que près de l'écran (mémoire de la tablette)
  attach(pageEls, data, under, wins) {
    this.deselect()
    if (under !== undefined) this.under = under
    if (this._io) this._io.disconnect()
    this._io = wins ? new IntersectionObserver(ents => {
      for (const e of ents) { const pg = this.pages.find(p => p.el === e.target || p.el.parentElement === e.target); if (pg && pg.live !== e.isIntersecting) { pg.live = e.isIntersecting; this._size(pg) } }
    }, { root: this.scroller || null, rootMargin: '0px 150% 0px 150%' }) : null
    this.pages = pageEls.map((el, i) => {
      const canvas = document.createElement('canvas')
      canvas.className = 'ink'
      el.appendChild(canvas)
      const win = wins && wins[i]
      if (win) Object.assign(canvas.style, { top: win.y0 * 100 + '%', height: (win.y1 - win.y0) * 100 + '%' })
      const pg = { el, canvas, strokes: (data && data[i]) ? data[i] : [], i, win, live: !wins }
      this._bind(pg)
      if (this._io) this._io.observe(el.parentElement || el)
      return pg
    })
    if (this._io) { this._io.disconnect(); for (const pg of this.pages) this._io.observe(pg.el.parentElement || pg.el); }
    this.undoStack = []; this.redoStack = []
    this.resize()
  }
  // taille logique (page entière) et décalage de la toile
  _dims(pg) {
    const c = pg.canvas, w = pg.win
    if (!w) return { W: c.width, H: c.height, oy: 0 }
    const H = c.height / Math.max(0.0001, w.y1 - w.y0)
    return { W: c.width, H, oy: w.y0 * H }
  }
  _size(pg) {
    const w = pg.el.clientWidth, h = pg.el.clientHeight
    if (!w) return
    if (pg.win && !pg.live) { if (pg.canvas.width !== 1) { pg.canvas.width = 1; pg.canvas.height = 1 } return }
    const frac = pg.win ? (pg.win.y1 - pg.win.y0) : 1
    // au plus ~5 millions de pixels par toile
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(5e6 / Math.max(1, w * h * frac)))
    pg.canvas.width = Math.max(1, Math.round(w * dpr)); pg.canvas.height = Math.max(1, Math.round(h * frac * dpr))
    this.redraw(pg)
  }

  serialize() { return this.pages.map(p => p.strokes) }

  resize() {
    for (const pg of this.pages) this._size(pg)
    if (this.sel) this._placeSel()
  }

  setEnabled(on) {
    this.enabled = on
    if (!on) this.deselect()
    for (const pg of this.pages) pg.canvas.classList.toggle('active', on)
  }

  setTool(t) { this.tool = t; if (t !== 'text' && t !== 'emoji' && t !== 'shape') this.deselect() }

  redraw(pg) {
    const c = pg.canvas, ctx = c.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    if (c.width <= 1) return
    const { W, H, oy } = this._dims(pg)
    ctx.setTransform(1, 0, 0, 1, 0, -oy)
    const u = this.underVisible !== false && this.under && this.under[pg.i]
    if (u && u.length) {
      // calque de l'autre personne : halo violet pour le distinguer de ses propres annotations
      ctx.save(); ctx.shadowColor = hexA(this.underColor || '#9b3fc0', 0.45); ctx.shadowBlur = Math.max(3, W / 300)
      for (const s of u) draw(ctx, s, W, H)
      ctx.restore()
      if (this.underWho) drawBadges(ctx, u, this.underWho, W, H, this.underColor)
    }
    for (const s of pg.strokes) draw(ctx, s, W, H)
    if (this.current && this.current.pg === pg && this.current.s) draw(ctx, this.current.s, W, H)
  }

  // ---------- géométrie texte ----------
  textBox(o, W) {
    const px = o.s * W
    this._measure.font = FONT(px)
    const lines = String(o.text).split('\n')
    const w = Math.max(...lines.map(l => this._measure.measureText(l).width), px * 0.5)
    return { w: w + px * 0.3, h: lines.length * px * 1.25 + px * 0.15 }
  }
  _hitText(pg, x, y) {
    const W = pg.el.clientWidth, H = pg.el.clientHeight
    for (let k = pg.strokes.length - 1; k >= 0; k--) {
      const o = pg.strokes[k]
      if (o.t !== 'text') continue
      const b = this.textBox(o, W)
      const dx = x * W - o.x * W, dy = y * H - o.y * H
      const lx = dx * Math.cos(-o.r) - dy * Math.sin(-o.r), ly = dx * Math.sin(-o.r) + dy * Math.cos(-o.r)
      const pad = 10
      if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad) return o
    }
    return null
  }

  // ---------- sélection d'un texte (poignées DOM) ----------
  // forme (ou trait) touchée : distance au contour, en pixels
  _hitShape(pg, x, y, tolPx = 14) {
    const W = pg.el.clientWidth, H = pg.el.clientHeight, X = x * W, Y = y * H
    for (let k = pg.strokes.length - 1; k >= 0; k--) {
      const o = pg.strokes[k]
      if (!o.sh || !o.p) continue
      const tol = tolPx + o.w * W
      for (let i = 1; i < o.p.length; i++) {
        const ax = o.p[i - 1][0] * W, ay = o.p[i - 1][1] * H, bx = o.p[i][0] * W, by = o.p[i][1] * H
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1
        const t = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / L))
        if (Math.hypot(X - ax - t * dx, Y - ay - t * dy) <= tol) return o
      }
    }
    return null
  }
  _bbox(o) {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9
    for (const q of o.p) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]) }
    return { x: a, y: b, w: c - a, h: d - b }
  }
  // sélection d'une forme : déplacer (glisser dedans), redimensionner (coin), supprimer, recolorer (pastille)
  _selectShape(pg, o) {
    this.deselect()
    const box = document.createElement('div')
    box.className = 'tsel ssel'
    box.innerHTML = '<button class="th del" title="Supprimer">×</button><button class="th rsz" title="Redimensionner"></button>'
    pg.el.appendChild(box)
    this.sel = { pg, o, box, shape: true }
    this._placeSel()
    const pos = e => { const r = pg.el.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } }
    let drag = null
    box.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation()
      try { box.setPointerCapture(e.pointerId) } catch { }
      if (e.target.classList.contains('del')) { this._remove(pg, o); return }
      drag = { id: e.pointerId, mode: e.target.classList.contains('rsz') ? 'rsz' : 'move', p0: pos(e), pts: o.p.map(q => q.slice()), b0: this._bbox(o) }
    })
    box.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return
      const p = pos(e), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y, b = drag.b0
      if (drag.mode === 'move') o.p = drag.pts.map(q => [+(q[0] + dx).toFixed(4), +(q[1] + dy).toFixed(4), q[2]])
      else {
        const sx = Math.max(0.15, (b.w + dx) / Math.max(b.w, 0.004)), sy = Math.max(0.15, (b.h + dy) / Math.max(b.h, 0.004))
        o.p = drag.pts.map(q => [+(b.x + (q[0] - b.x) * sx).toFixed(4), +(b.y + (q[1] - b.y) * sy).toFixed(4), q[2]])
      }
      this.redraw(pg); this._placeSel()
    })
    const up = e => {
      if (!drag || e.pointerId !== drag.id) return
      if (JSON.stringify(o.p) !== JSON.stringify(drag.pts)) {
        this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before: { p: drag.pts }, after: { p: o.p.map(q => q.slice()) } }); this.redoStack = []
        this.onChange && this.onChange()
      }
      drag = null
    }
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up)
  }
  setSelectedSize(size) {
    if (!this.sel || !this.sel.shape) return false
    const { pg, o } = this.sel, w = 0.0012 * size
    this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before: { w: o.w }, after: { w } }); this.redoStack = []
    o.w = w; this.redraw(pg); this._placeSel(); this.onChange && this.onChange()
    return true
  }

  select(pg, o) {
    if (o.sh) return this._selectShape(pg, o)
    this.deselect()
    const box = document.createElement('div')
    box.className = 'tsel'
    box.innerHTML = '<button class="th rot" title="Tourner / redimensionner"></button><button class="th del" title="Supprimer">×</button><button class="th edit" title="Modifier">✎</button>'
    pg.el.appendChild(box)
    this.sel = { pg, o, box }
    this._placeSel()
    const pos = e => { const r = pg.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height } }
    let drag = null
    box.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation()
      try { box.setPointerCapture(e.pointerId) } catch { }
      const p = pos(e)
      const before = { x: o.x, y: o.y, s: o.s, r: o.r }
      if (e.target.classList.contains('del')) { this._remove(pg, o); return }
      if (e.target.classList.contains('edit')) { this._edit(pg, o); return }
      const cx = o.x * p.W, cy = o.y * p.H
      if (e.target.classList.contains('rot')) {
        drag = { mode: 'rot', before, a0: Math.atan2(p.y - cy, p.x - cx) - o.r, d0: Math.hypot(p.x - cx, p.y - cy), s0: o.s }
      } else {
        drag = { mode: 'move', before, dx: p.x - cx, dy: p.y - cy }
      }
      drag.id = e.pointerId
    })
    box.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return
      const p = pos(e)
      if (drag.mode === 'move') {
        o.x = Math.min(1, Math.max(0, (p.x - drag.dx) / p.W)); o.y = Math.min(1, Math.max(0, (p.y - drag.dy) / p.H))
      } else {
        const cx = o.x * p.W, cy = o.y * p.H
        let r = Math.atan2(p.y - cy, p.x - cx) - drag.a0
        // aimante à 0 / 90 / 180 / 270°
        const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2)
        if (Math.abs(r - snap) < 0.06) r = snap
        o.r = r
        o.s = Math.min(0.2, Math.max(0.008, drag.s0 * Math.hypot(p.x - cx, p.y - cy) / Math.max(1, drag.d0)))
      }
      this.redraw(pg); this._placeSel()
    })
    const up = e => {
      if (!drag || e.pointerId !== drag.id) return
      const after = { x: o.x, y: o.y, s: o.s, r: o.r }
      if (JSON.stringify(after) !== JSON.stringify(drag.before)) {
        this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before: drag.before, after }); this.redoStack = []
        this.onChange && this.onChange()
      }
      drag = null
    }
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up)
  }
  _placeSel() {
    const { pg, o, box } = this.sel
    const W = pg.el.clientWidth, H = pg.el.clientHeight
    if (this.sel.shape) {
      const b = this._bbox(o), pad = 10 + o.w * W
      Object.assign(box.style, { left: b.x * W - pad + 'px', top: b.y * H - pad + 'px', width: b.w * W + pad * 2 + 'px', height: b.h * H + pad * 2 + 'px', transform: 'none' })
      return
    }
    const b = this.textBox(o, W)
    Object.assign(box.style, { width: b.w + 16 + 'px', height: b.h + 12 + 'px', left: o.x * W + 'px', top: o.y * H + 'px', transform: `translate(-50%,-50%) rotate(${o.r}rad)` })
  }
  deselect() { if (this.sel) { this.sel.box.remove(); this.sel = null } }

  _edit(pg, o) {
    if (o.emoji) { if (this.onPickEmoji) this.onPickEmoji(em => { if (!em) return; const before = { text: o.text }; o.text = em; this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before, after: { text: em } }); this.redraw(pg); if (this.sel) this._placeSel(); this.onChange && this.onChange() }); return }
    if (!this.onEditText) return
    this.onEditText(o.text, t => {
      if (t == null) return
      if (!t.trim()) { this._remove(pg, o); return }
      const before = { text: o.text }
      o.text = t
      this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before, after: { text: t } }); this.redoStack = []
      this.redraw(pg); if (this.sel) this._placeSel(); this.onChange && this.onChange()
    })
  }
  _remove(pg, o) {
    pg.strokes = pg.strokes.filter(s => s !== o)
    this.undoStack.push({ op: 'del', pg: pg.i, s: o }); this.redoStack = []
    this.deselect(); this.redraw(pg); this.onChange && this.onChange()
  }
  setSelectedColor(c) {
    if (!this.sel) return false
    const { pg, o } = this.sel
    this.undoStack.push({ op: 'mod', pg: pg.i, s: o, before: { c: o.c }, after: { c } }); this.redoStack = []
    o.c = c; this.redraw(pg); this.onChange && this.onChange()
    return true
  }

  // ---------- saisie ----------
  _bind(pg) {
    const c = pg.canvas
    const pt = e => {
      const r = pg.el.getBoundingClientRect()
      return [+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4), +(e.pressure || 0.5).toFixed(2)]
    }
    c.addEventListener('pointerdown', e => {
      if (!this.enabled) return
      const isTouch = e.pointerType === 'touch'
      if (isTouch) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.touches.size >= 2) {
          // 2 doigts = défiler (on abandonne le trait commencé au doigt)
          if (this.current && this.current.touch) { const pg0 = this.current.pg; this.current = null; this.redraw(pg0) }
          this._touch = null
          const m = centroid(this.touches)
          this._pan = { x: m.x, y: m.y, st: this.scroller.scrollTop, sl: this.scroller.scrollLeft }
          return
        }
      }
      if (this.tool === 'text' || this.tool === 'emoji') {
        // texte : stylet ou doigt (tap). Le doigt qui glisse fait défiler.
        const p = pt(e)
        const hit = this._hitText(pg, p[0], p[1])
        if (hit) { e.preventDefault(); this.select(pg, hit); return }
        if (this.sel) { this.deselect(); return }
        if (isTouch && !this.fingerDraws) {
          this._touch = { id: e.pointerId, y: e.clientY, x: e.clientX, st: this.scroller.scrollTop, sl: this.scroller.scrollLeft, tapText: p, moved: false }
          return
        }
        e.preventDefault()
        this._newText(pg, p)
        return
      }
      if (this.tool === 'shape') {
        const p = pt(e)
        const hit = this._hitShape(pg, p[0], p[1], isTouch ? 20 : 12)
        if (hit && !(isTouch && !this.fingerDraws)) { e.preventDefault(); this.select(pg, hit); return }
        if (this.sel) { this.deselect(); return }
        if (isTouch && !this.fingerDraws) {   // le doigt : glisser = défiler, toucher = sélectionner une forme
          this._touch = { id: e.pointerId, y: e.clientY, x: e.clientX, st: this.scroller.scrollTop, sl: this.scroller.scrollLeft, tapShape: p, moved: false }
          return
        }
      }
      if (isTouch && !this.fingerDraws) {
        this._touch = { id: e.pointerId, y: e.clientY, x: e.clientX, st: this.scroller.scrollTop, sl: this.scroller.scrollLeft }
        return
      }
      if (e.button > 0 && e.pointerType === 'mouse') return
      e.preventDefault()
      this.lastActivity = performance.now()
      try { c.setPointerCapture(e.pointerId) } catch { }
      const erasing = this.tool === 'eraser' || (e.buttons & 32) || e.button === 5
      if (erasing) { this.current = { pg, erase: true, id: e.pointerId }; this._erase(pg, pt(e)); return }
      if (this.tool === 'shape') {   // forme : trait « stylo » dont les points sont calculés
        const a = pt(e)
        const s = { t: 'pen', sh: this.shape, c: this.color, w: 0.0012 * this.size, p: [a, a], pr: false }
        this.current = { pg, s, id: e.pointerId, touch: isTouch, a }
        return
      }
      const s = { t: this.tool, c: this.tool === 'hl' ? '#ffd400' : this.color, w: this.tool === 'hl' ? 0.018 : 0.0012 * this.size, p: [pt(e)], pr: e.pointerType === 'pen' }
      this.current = { pg, s, id: e.pointerId, touch: isTouch }
    })
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this._pan) {
        if (this.touches.size >= 2) {
          const m = centroid(this.touches)
          this.scroller.scrollTop = this._pan.st - (m.y - this._pan.y)
          this.scroller.scrollLeft = this._pan.sl - (m.x - this._pan.x)
        }
        return
      }
      if (this._touch && e.pointerId === this._touch.id) {
        const dx = e.clientX - this._touch.x, dy = e.clientY - this._touch.y
        if (Math.hypot(dx, dy) > 8) this._touch.moved = true
        this.scroller.scrollTop = this._touch.st - dy
        this.scroller.scrollLeft = this._touch.sl - dx
        return
      }
      if (!this.current || this.current.id !== e.pointerId) return
      e.preventDefault()
      this.lastActivity = performance.now()
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null
      if (!evs || !evs.length) evs = [e]
      if (this.current.erase) { for (const ev of evs) this._erase(pg, pt(ev)); return }
      const s = this.current.s, from = s.p.length - 1
      if (this.current.a) { s.p = shapePoints(s.sh, this.current.a, pt(evs[evs.length - 1]), pg.el.clientHeight / Math.max(1, pg.el.clientWidth)); this.redraw(pg); return }
      for (const ev of evs) s.p.push(pt(ev))
      if (s.t === 'hl') this.redraw(pg)
      else drawSegments(pg.canvas, s, from, this._dims(pg))   // dessin incrémental : fluide même avec beaucoup d'annotations
    })
    const end = e => {
      if (e.pointerType === 'touch') {
        this.touches.delete(e.pointerId)
        if (this._pan) { if (this.touches.size === 0) this._pan = null; return }
      }
      if (this._touch && e.pointerId === this._touch.id) {
        const t = this._touch; this._touch = null
        if (t.tapText && !t.moved && e.type === 'pointerup') this._newText(pg, t.tapText)
        if (t.tapShape && !t.moved && e.type === 'pointerup') { const h = this._hitShape(pg, t.tapShape[0], t.tapShape[1], 20); if (h) this.select(pg, h) }
        return
      }
      if (!this.current || this.current.id !== e.pointerId) return
      const cur = this.current; this.current = null
      if (cur.a) {   // forme trop petite = ignorée (sauf coups d'archet : un simple toucher pose le signe)
        const q = cur.s.p, xs = q.map(v => v[0]), ys = q.map(v => v[1])
        const big = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) > 0.008
        if (!big && (cur.s.sh === 'downbow' || cur.s.sh === 'upbow')) {
          const asp = pg.el.clientHeight / Math.max(1, pg.el.clientWidth), w = 0.009 + 0.005 * this.size, h = w * 1.1 / asp
          cur.s.p = shapePoints(cur.s.sh, [cur.a[0] - w / 2, cur.a[1] - h / 2], [cur.a[0] + w / 2, cur.a[1] + h / 2], asp)
          this._add(pg, cur.s)
        } else if (big) this._add(pg, cur.s)
      } else if (!cur.erase && cur.s.p.length) {
        if (cur.s.p.length === 1) cur.s.p.push([cur.s.p[0][0] + 0.0005, cur.s.p[0][1], cur.s.p[0][2]])
        this._add(pg, cur.s)
      }
      this.redraw(pg)
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
  }

  _add(pg, s) {
    pg.strokes.push(s)
    this.undoStack.push({ op: 'add', pg: pg.i, s }); this.redoStack = []
    this.onChange && this.onChange()
  }

  _newText(pg, p) {
    if (this.tool === 'emoji') {
      if (!this.emoji) return
      const sz = { 1: 0.022, 2: 0.032, 4: 0.045, 6: 0.065 }[this.size] || 0.032
      const o = { t: 'text', c: '#000000', x: p[0], y: p[1], s: sz, r: 0, text: this.emoji, emoji: true }
      this._add(pg, o); this.redraw(pg)   // pas de sélection : on peut en poser plusieurs à la suite
      return
    }
    if (!this.onEditText) return
    this.onEditText('', t => {
      if (!t || !t.trim()) return
      const o = { t: 'text', c: this.color, x: p[0], y: p[1], s: 0.012 + 0.006 * this.size, r: 0, text: t }
      this._add(pg, o)
      this.redraw(pg)
      this.select(pg, o)
    })
  }

  _erase(pg, [x, y]) {
    const r = 0.012
    const aspect = pg.el.clientHeight / pg.el.clientWidth
    const before = pg.strokes.length
    const hitText = this._hitText(pg, x, y)
    pg.strokes = pg.strokes.filter(s => {
      const hit = s.t === 'text' ? s === hitText : s.p.some(q => Math.hypot(q[0] - x, (q[1] - y) * aspect) < r + s.w)
      if (hit) this.undoStack.push({ op: 'del', pg: pg.i, s })
      return !hit
    })
    if (pg.strokes.length !== before) { this.redoStack = []; this.deselect(); this.redraw(pg); this.onChange && this.onChange() }
  }

  _apply(a, reverse) {
    const pg = this.pages[a.pg]
    if (a.op === 'mod') Object.assign(a.s, reverse ? a.before : a.after)
    else if ((a.op === 'add') !== reverse) pg.strokes.push(a.s)
    else pg.strokes = pg.strokes.filter(s => s !== a.s)
    this.deselect(); this.redraw(pg); this.onChange && this.onChange()
  }
  undo() { const a = this.undoStack.pop(); if (!a) return; this._apply(a, true); this.redoStack.push(a) }
  redo() { const a = this.redoStack.pop(); if (!a) return; this._apply(a, false); this.undoStack.push(a) }
  clearPage(i) {
    const pg = this.pages[i]; if (!pg || !pg.strokes.length) return
    for (const s of pg.strokes) this.undoStack.push({ op: 'del', pg: i, s })
    pg.strokes = []; this.deselect(); this.redraw(pg); this.onChange && this.onChange()
  }
  count() { return this.pages.reduce((a, p) => a + p.strokes.length, 0) }
}

function drawSegments(canvas, s, from, d) {
  const ctx = canvas.getContext('2d'), W = d ? d.W : canvas.width, H = d ? d.H : canvas.height, pts = s.p
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, -(d ? d.oy : 0))
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c
  for (let i = Math.max(1, from); i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    ctx.lineWidth = s.pr ? s.w * W * (0.4 + 1.2 * (a[2] + b[2]) / 2) : s.w * W
    ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke()
  }
  ctx.restore()
}

function draw(ctx, s, W, H) {
  if (s.t === 'text') return drawText(ctx, s, W, H)
  const pts = s.p
  if (!pts || !pts.length) return
  ctx.save()
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.strokeStyle = s.c
  if (s.t === 'hl') {
    ctx.globalAlpha = 0.38
    ctx.globalCompositeOperation = 'multiply'
    ctx.lineWidth = s.w * W
    ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * H)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H)
    ctx.stroke()
  } else if (s.sh && s.sh !== 'ellipse') {   // formes : segments droits, angles nets
    ctx.lineWidth = s.w * W; ctx.lineJoin = 'miter'
    ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * H)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H)
    ctx.stroke()
  } else if (!s.pr) {
    ctx.lineWidth = s.w * W
    ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * H)
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2 * W, my = (pts[i][1] + pts[i + 1][1]) / 2 * H
      ctx.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, mx, my)
    }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0] * W, l[1] * H)
    ctx.stroke()
  } else {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      ctx.lineWidth = s.w * W * (0.4 + 1.2 * (a[2] + b[2]) / 2)
      ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke()
    }
  }
  ctx.restore()
}

function drawText(ctx, o, W, H) {
  const px = o.s * W
  const lines = String(o.text).split('\n')
  ctx.save()
  ctx.translate(o.x * W, o.y * H)
  ctx.rotate(o.r || 0)
  ctx.font = FONT(px)
  ctx.fillStyle = o.c
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lh = px * 1.25
  lines.forEach((l, k) => ctx.fillText(l, 0, (k - (lines.length - 1) / 2) * lh))
  ctx.restore()
}

function centroid(m) {
  let x = 0, y = 0
  for (const p of m.values()) { x += p.x; y += p.y }
  return { x: x / m.size, y: y / m.size }
}

// petites bulles « auteur » : une par groupe d'annotations proches
function bbox(o, W, H) {
  if (o.t === 'text') { const h = o.s * 1.3, w = o.s * Math.max(1, String(o.text).length) * 0.6; return [o.x - w / 2, o.y - h * W / H / 2, o.x + w / 2, o.y + h * W / H / 2] }
  if (!o.p || !o.p.length) return null
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9
  for (const q of o.p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c) c = q[0]; if (q[1] > d) d = q[1] }
  return [a, b, c, d]
}
function hexA(h, a) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return `rgba(176,64,208,${a})`; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }
function drawBadges(ctx, objs, who, W, H, color) {
  const gap = 0.03, boxes = []
  for (const o of objs) {
    const bb = bbox(o, W, H); if (!bb) continue
    let m = boxes.find(x => bb[0] < x[2] + gap && bb[2] > x[0] - gap && bb[1] < x[3] + gap * W / H && bb[3] > x[1] - gap * W / H)
    if (m) { m[0] = Math.min(m[0], bb[0]); m[1] = Math.min(m[1], bb[1]); m[2] = Math.max(m[2], bb[2]); m[3] = Math.max(m[3], bb[3]) }
    else boxes.push(bb.slice())
  }
  const px = Math.max(9, Math.round(W * 0.011))
  ctx.save()
  ctx.font = `700 ${px}px system-ui, sans-serif`; ctx.textBaseline = 'middle'
  const label = String(who).slice(0, 14)
  const tw = ctx.measureText(label).width, bw = tw + px * 1.1, bh = px * 1.55
  for (const bb of boxes) {
    let x = bb[2] * W + px * 0.3, y = bb[1] * H - bh * 0.6
    if (x + bw > W) x = Math.max(0, bb[0] * W - bw - px * 0.3)
    if (y < 0) y = 0
    ctx.globalAlpha = 0.92; ctx.fillStyle = color || '#9b3fc0'
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, bh / 2); else ctx.rect(x, y, bw, bh); ctx.fill()
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(label, x + px * 0.55, y + bh / 2 + 0.5)
  }
  ctx.restore()
}

// points d'une forme entre a (départ) et b (arrivée) ; asp = hauteur / largeur de la page
export function shapePoints(kind, a, b, asp) {
  const r4 = v => +v.toFixed(4), P = (x, y) => [r4(x), r4(y), 0.5]
  const [x1, y1] = a, [x2, y2] = b
  if (kind === 'rect') return [P(x1, y1), P(x2, y1), P(x2, y2), P(x1, y2), P(x1, y1)]
  if (kind === 'line') return [P(x1, y1), P(x2, y2)]
  const L = Math.min(x1, x2), R = Math.max(x1, x2), T = Math.min(y1, y2), B = Math.max(y1, y2)
  if (kind === 'downbow') return [P(L, B), P(L, T), P(R, T), P(R, B)]          // tiré  ⊓
  if (kind === 'upbow') return [P(L, T), P((L + R) / 2, B), P(R, T)]          // poussé  V
  if (kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, out = []
    for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; out.push(P(cx + rx * Math.cos(t), cy + ry * Math.sin(t))) }
    return out
  }
  if (kind === 'arrow') {
    const dx = x2 - x1, dy = (y2 - y1) * asp, L = Math.hypot(dx, dy) || 1e-6
    const h = Math.min(0.025, L * 0.35), ux = dx / L, uy = dy / L
    const head = s => P(x2 - h * (ux * Math.cos(0.45) - s * uy * Math.sin(0.45)), y2 - h * (uy * Math.cos(0.45) + s * ux * Math.sin(0.45)) / asp)
    return [P(x1, y1), P(x2, y2), head(1), P(x2, y2), head(-1)]
  }
  if (kind === 'cresc' || kind === 'decresc') {   // soufflets < et >
    const open = Math.max(Math.abs(y2 - y1), 0.006 / asp) / 2, my = (y1 + y2) / 2
    const [xa, xb] = kind === 'cresc' ? [x1, x2] : [x2, x1]
    return [P(xb, my - open), P(xa, my), P(xb, my + open)]
  }
  return [P(x1, y1), P(x2, y2)]
}

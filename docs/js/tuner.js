// Accordeur multi-instruments : micro -> détection de hauteur (YIN) -> écart en cents, historique qui défile
const LET = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']
const FR = ['DO', 'DO♯', 'RÉ', 'MI♭', 'MI', 'FA', 'FA♯', 'SOL', 'SOL♯', 'LA', 'SI♭', 'SI']
const S = (...midis) => midis.map(m => ({ midi: m, fr: FR[m % 12], id: LET[m % 12], oct: Math.floor(m / 12) - 1 }))
export const INSTRUMENTS = [
  { id: 'violin', name: 'Violon', strings: S(55, 62, 69, 76) },
  { id: 'viola', name: 'Alto', strings: S(48, 55, 62, 69) },
  { id: 'cello', name: 'Violoncelle', strings: S(36, 43, 50, 57) },
  { id: 'dbass', name: 'Contrebasse', strings: S(28, 33, 38, 43) },
  { id: 'guitar', name: 'Guitare (sèche / électrique)', strings: S(40, 45, 50, 55, 59, 64) },
  { id: 'guitar-dropd', name: 'Guitare — Drop D', strings: S(38, 45, 50, 55, 59, 64) },
  { id: 'guitar-dadgad', name: 'Guitare — DADGAD', strings: S(38, 45, 50, 55, 57, 62) },
  { id: 'guitar-halfdown', name: 'Guitare — ½ ton en dessous', strings: S(39, 44, 49, 54, 58, 63) },
  { id: 'bass4', name: 'Basse électrique 4 cordes', strings: S(28, 33, 38, 43) },
  { id: 'bass5', name: 'Basse électrique 5 cordes', strings: S(23, 28, 33, 38, 43) },
  { id: 'ukulele', name: 'Ukulélé (GCEA)', strings: S(67, 60, 64, 69) },
  { id: 'mandolin', name: 'Mandoline', strings: S(55, 62, 69, 76) },
  { id: 'banjo', name: 'Banjo 5 cordes (open G)', strings: S(67, 50, 55, 59, 62) },
  { id: 'chromatic', name: 'Chromatique (toutes notes)', strings: [] },
]
const NAMES_FR = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si']
const TOL = 5          // ± cents = juste
const HOLD_MS = 900    // temps à tenir dans la zone pour valider

export class Tuner {
  constructor(root, store) {
    this.root = root
    this.store = store || { get: () => ({}), set: () => { } }
    const st = this.store.get() || {}
    this.ref = st.ref || 440
    this.favs = Array.isArray(st.favs) ? st.favs : ['violin']
    this.inst = INSTRUMENTS.find(i => i.id === st.inst) || INSTRUMENTS[0]
    this.auto = true
    this.target = Math.min(2, Math.max(0, this.inst.strings.length - 1))
    this.done = new Set()
    this.hist = []       // {t, cents|null}
    this.inSince = 0
    this.running = false
    this.canvas = root.querySelector('canvas')
    this._build()
  }

  freq(midi) { return this.ref * Math.pow(2, (midi - 69) / 12) }

  _save() { this.store.set({ inst: this.inst.id, favs: this.favs, ref: this.ref }) }

  setInstrument(id) {
    this.inst = INSTRUMENTS.find(i => i.id === id) || INSTRUMENTS[0]
    this.done.clear(); this.target = Math.min(2, Math.max(0, this.inst.strings.length - 1)); this.inSince = 0; this.recent = []
    this._save(); this._buildStrings(); this._paint()
  }

  _buildStrings() {
    const bar = this.root.querySelector('.tstrings')
    bar.innerHTML = ''
    bar.style.gridTemplateColumns = `repeat(${Math.max(1, this.inst.strings.length)}, 1fr)`
    bar.hidden = !this.inst.strings.length
    // doublons de nom (ex. MI grave / MI aigu) : on affiche l'octave
    this.inst.strings.forEach((s, i) => {
      const b = document.createElement('button')
      b.className = 'tstring'
      const dup = this.inst.strings.filter(x => x.fr === s.fr).length > 1
      b.innerHTML = `<b>${s.fr}${dup ? '<sup>' + s.oct + '</sup>' : ''}</b><small>${s.id}${s.oct}</small><i>✓</i>`
      b.onclick = () => { this.auto = false; this.target = i; this.inSince = 0; this._paint() }
      bar.appendChild(b)
    })
  }

  _renderFavs() {
    const box = this.root.querySelector('.tfavs')
    box.innerHTML = ''
    for (const id of this.favs) {
      const ins = INSTRUMENTS.find(i => i.id === id); if (!ins) continue
      const c = document.createElement('button')
      c.className = 'chip tfav' + (ins === this.inst ? ' on' : '')
      c.textContent = '★ ' + ins.name
      c.onclick = () => { this.setInstrument(ins.id); this._renderFavs() }
      box.appendChild(c)
    }
    box.hidden = !box.children.length
  }

  _renderPicker() {
    const pop = this.root.querySelector('.tinstpop')
    pop.innerHTML = ''
    const sorted = [...INSTRUMENTS].sort((a, b) => (this.favs.includes(b.id) - this.favs.includes(a.id)))
    for (const ins of sorted) {
      const row = document.createElement('div')
      row.className = 'tinstrow' + (ins === this.inst ? ' on' : '')
      const fav = this.favs.includes(ins.id)
      row.innerHTML = `<button class="star${fav ? ' on' : ''}" title="Favori">${fav ? '★' : '☆'}</button><button class="nm"></button><small></small>`
      row.querySelector('.nm').textContent = ins.name
      row.querySelector('small').textContent = ins.strings.map(s => s.id + s.oct).join(' ')
      row.querySelector('.nm').onclick = () => { this.setInstrument(ins.id); pop.hidden = true; this._renderFavs() }
      row.querySelector('.star').onclick = e => {
        e.stopPropagation()
        this.favs = fav ? this.favs.filter(x => x !== ins.id) : [...this.favs, ins.id]
        this._save(); this._renderPicker(); this._renderFavs()
      }
      pop.appendChild(row)
    }
  }

  _build() {
    this._buildStrings()
    this.root.querySelector('.tinst').onclick = e => {
      e.stopPropagation()
      const pop = this.root.querySelector('.tinstpop')
      if (pop.hidden) { this._renderPicker(); pop.hidden = false } else pop.hidden = true
    }
    this.root.addEventListener('pointerdown', e => { if (!e.target.closest('.tinstpop') && !e.target.closest('.tinst')) this.root.querySelector('.tinstpop').hidden = true })
    this._renderFavs()
    this.root.querySelector('.tauto').onclick = () => { this.auto = !this.auto; this._paint() }
    this.root.querySelector('.tref').onclick = () => { this.ref = this.ref === 440 ? 442 : this.ref === 442 ? 443 : this.ref === 443 ? 415 : 440; this._save(); this._paint() }
    this.root.querySelector('.tplay').onclick = () => this.playRef()
    this.root.querySelector('.treset').onclick = () => { this.done.clear(); this._paint() }
    this._paint()
  }

  _paint() {
    this.root.querySelectorAll('.tstring').forEach((b, i) => {
      b.classList.toggle('on', i === this.target)
      b.classList.toggle('ok', this.done.has(i))
    })
    this.root.querySelector('.tauto').classList.toggle('on', this.auto)
    this.root.querySelector('.tauto').textContent = this.auto ? 'Auto' : 'Manuel'
    this.root.querySelector('.tref').textContent = `La = ${this.ref} Hz`
    this.root.querySelector('.tinst').textContent = this.inst.name + ' ▾'
    this.root.querySelector('.tauto').hidden = !this.inst.strings.length
    this.root.querySelector('.tplay').hidden = !this.inst.strings.length
  }

  async start() {
    if (this.running) return
    this.err('')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (e) {
      this.err('Micro inaccessible : autorise le micro pour Partoche And Prof (' + (e.name || e.message) + ')')
      return
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)()
    if (this.ctx.state !== 'running') await this.ctx.resume()
    const src = this.ctx.createMediaStreamSource(this.stream)
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 25
    this.an = this.ctx.createAnalyser(); this.an.fftSize = 8192
    src.connect(hp).connect(this.an)
    this.buf = new Float32Array(this.an.fftSize)
    this.running = true
    this.recent = []
    this._loop()
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.stream) this.stream.getTracks().forEach(t => t.stop())
    if (this.ctx) this.ctx.close()
    this.stream = this.ctx = null
  }

  err(m) { const e = this.root.querySelector('.terr'); e.textContent = m; e.hidden = !m }

  playRef() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'triangle'; o.frequency.value = this.freq(this.inst.strings[this.target].midi)
    g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05)
    g.gain.setTargetAtTime(0, ctx.currentTime + 1.6, 0.15)
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 2.4)
    setTimeout(() => ctx.close(), 2600)
  }

  _loop() {
    if (!this.running) return
    this._odd = !this._odd
    if (this._odd) { this.raf = requestAnimationFrame(() => this._loop()); return }   // ~30 mesures/s
    this.an.getFloatTimeDomainData(this.buf)
    const ms = this.inst.strings.map(x => x.midi)
    const lo = ms.length ? this.freq(Math.min(...ms)) * 0.7 : 28, hi = ms.length ? this.freq(Math.max(...ms)) * 1.6 : 2000
    // basses fréquences : on sous-échantillonne pour garder le calcul léger
    const dec = lo < 60 ? (hi > 800 ? 2 : 4) : lo < 120 ? 2 : 1
    let data = this.buf
    if (dec > 1) {
      const n = Math.floor(this.buf.length / dec)
      if (!this._dbuf || this._dbuf.length !== n) this._dbuf = new Float32Array(n)
      for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < dec; k++) a += this.buf[i * dec + k]; this._dbuf[i] = a / dec }
      data = this._dbuf
    } else if (this.buf.length > 4096) data = this.buf.subarray(0, 4096)
    const f = yin(data, this.ctx.sampleRate / dec, lo, hi)
    const now = performance.now()
    let cents = null, info = null
    if (f) {
      // lissage : médiane des dernières mesures
      this.recent.push(f); if (this.recent.length > 5) this.recent.shift()
      const fm = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1]
      const midiF = 69 + 12 * Math.log2(fm / this.ref)
      const strs = this.inst.strings
      if (this.auto && strs.length) {
        let best = 0, bd = 1e9
        strs.forEach((s, i) => { const d = Math.abs(midiF - s.midi); if (d < bd) { bd = d; best = i } })
        if (bd < 3 && best !== this.target) { this.target = best; this.inSince = 0; this._paint() }
      }
      // chromatique : on vise la note la plus proche
      const s = strs.length ? strs[this.target] : { midi: Math.round(midiF) }
      cents = (midiF - s.midi) * 100
      const nearest = Math.round(midiF)
      info = { f: fm, note: NAMES_FR[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1), off: Math.abs(cents) > 300, tm: s.midi }
      // validation : tenir dans ± TOL cents
      if (Math.abs(cents) <= TOL) {
        if (!this.inSince) this.inSince = now
        if (now - this.inSince > HOLD_MS && (!this.inst.strings.length ? !this._chromOk : !this.done.has(this.target))) {
          if (!this.inst.strings.length) { this._chromOk = true; this._flash(); return this._next(cents, info, now) }
          this.done.add(this.target); this._paint(); this._flash()
          if (navigator.vibrate) try { navigator.vibrate(60) } catch { }
          // passe à la corde suivante non validée
          if (this.auto === false) { const nx = this.inst.strings.map((_, i) => i).find(i => !this.done.has(i)); if (nx != null) setTimeout(() => { this.target = nx; this.inSince = 0; this._paint() }, 700) }
        }
      } else { this.inSince = 0; this._chromOk = false }
    } else { this.recent = []; this.inSince = 0; this._chromOk = false }
    this._next(cents, info, now)
  }

  _next(cents, info, now) {
    this.hist.push({ t: now, c: cents })
    while (this.hist.length && now - this.hist[0].t > 6000) this.hist.shift()
    this._draw(cents, info, now)
    this.raf = requestAnimationFrame(() => this._loop())
  }

  _flash() {
    const el = this.root.querySelector('.tvalid')
    el.hidden = false; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop')
    clearTimeout(this._ft); this._ft = setTimeout(() => { el.hidden = true }, 1400)
  }

  _draw(cents, info, now) {
    const c = this.canvas, dpr = Math.min(devicePixelRatio || 1, 2)
    const W = c.clientWidth, H = c.clientHeight
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const RANGE = 50, cx = W / 2, px = W / 2 / RANGE
    const X = v => cx + Math.max(-RANGE, Math.min(RANGE, v)) * px
    // zone juste
    g.fillStyle = 'rgba(47,178,106,0.16)'; g.fillRect(X(-TOL), 0, X(TOL) - X(-TOL), H)
    // graduations
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1
    for (let v = -50; v <= 50; v += 10) { g.beginPath(); g.moveTo(X(v), 0); g.lineTo(X(v), H); g.stroke() }
    // ligne cible
    g.strokeStyle = '#2fb26a'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke()
    g.fillStyle = '#1d2027'; g.fillRect(cx - 34, 5, 68, 30)
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = '11px system-ui'; g.textAlign = 'center'
    for (const v of [-50, -25, 25, 50]) {
      g.textAlign = v === -50 ? 'left' : v === 50 ? 'right' : 'center'
      g.fillText((v > 0 ? '+' : '') + v, X(v) + (v === -50 ? 6 : v === 50 ? -6 : 0), 16)
    }
    g.textAlign = 'center'; g.fillStyle = 'rgba(47,178,106,0.8)'; g.fillText('juste', cx, 16)
    // quelques fréquences (Hz) de la note visée
    const tm = this.inst.strings.length ? this.inst.strings[this.target].midi : (info && info.tm != null ? (this._tm = info.tm) : this._tm)
    if (tm != null) {
      const fz = v => this.ref * Math.pow(2, (tm - 69) / 12 + v / 1200)
      g.font = '10px system-ui'
      for (const v of (W > 520 ? [-50, -25, 0, 25, 50] : [-50, 0, 50])) {
        g.textAlign = v === -50 ? 'left' : v === 50 ? 'right' : 'center'
        g.fillStyle = v === 0 ? 'rgba(47,178,106,0.9)' : 'rgba(255,255,255,0.32)'
        g.fillText(fz(v).toFixed(1) + ' Hz', X(v) + (v === -50 ? 6 : v === 50 ? -6 : 0), 30)
      }
      g.font = '11px system-ui'
    }
    // historique : le plus récent en bas, défile vers le haut
    const SPAN = 6000, y = t => H - 40 - (now - t) / SPAN * (H - 60)
    g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round'
    let prev = null
    for (const p of this.hist) {
      if (p.c == null) { prev = null; continue }
      const ok = Math.abs(p.c) <= TOL
      if (prev) {
        g.strokeStyle = ok ? '#2fb26a' : Math.abs(p.c) <= 15 ? '#ffb020' : '#ff5a5f'
        g.globalAlpha = 0.25 + 0.75 * (1 - (now - p.t) / SPAN)
        g.beginPath(); g.moveTo(X(prev.c), y(prev.t)); g.lineTo(X(p.c), y(p.t)); g.stroke()
      }
      prev = p
    }
    g.globalAlpha = 1
    // curseur actuel
    const note = this.root.querySelector('.tnote'), val = this.root.querySelector('.tcents'), hz = this.root.querySelector('.thz')
    if (cents != null) {
      const ok = Math.abs(cents) <= TOL
      g.fillStyle = ok ? '#2fb26a' : Math.abs(cents) <= 15 ? '#ffb020' : '#ff5a5f'
      g.beginPath(); g.arc(X(cents), H - 40, 11, 0, Math.PI * 2); g.fill()
      note.textContent = info.note
      val.textContent = info.off ? '—' : (cents > 0 ? '+' : '') + Math.round(cents) + ' cents'
      val.className = 'tcents ' + (ok ? 'ok' : cents > 0 ? 'hi' : 'lo')
      hz.textContent = info.f.toFixed(1) + ' Hz · ' + (info.off && this.inst.strings.length ? 'loin de la corde' : ok ? 'juste !' : cents > 0 ? 'trop haut — détends' : 'trop bas — tends')
    } else {
      val.textContent = ''; hz.textContent = this.inst.strings.length ? 'Joue une corde…' : 'Joue une note…'
      note.textContent = this.inst.strings.length ? this.inst.strings[this.target].fr : '—'
      val.className = 'tcents'
    }
  }
}

// Détection de hauteur YIN (fréquence en Hz ou null)
function yin(buf, sr, fLo = 150, fHi = 1400) {
  const N = buf.length
  let rms = 0
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / N)
  if (rms < 0.008) return null
  const minTau = Math.max(2, Math.floor(sr / fHi)), maxTau = Math.min(Math.floor(sr / fLo), (N >> 1) - 1)
  const W = N >> 1
  const d = new Float32Array(maxTau + 2)
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    let s = 0
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x }
    d[tau] = s
  }
  // différence normalisée cumulée
  let run = 0; d[0] = 1
  for (let tau = 1; tau <= maxTau + 1; tau++) { run += d[tau]; d[tau] = d[tau] * tau / (run || 1) }
  let tau = -1
  for (let t = minTau; t <= maxTau; t++) {
    if (d[t] < 0.12) { while (t + 1 <= maxTau && d[t + 1] < d[t]) t++; tau = t; break }
  }
  if (tau < 0) return null
  // interpolation parabolique
  const a = d[tau - 1], b = d[tau], c = d[tau + 1]
  const den = a + c - 2 * b
  const shift = den ? (a - c) / (2 * den) : 0
  const f = sr / (tau + shift)
  return f > fLo && f < fHi ? f : null
}

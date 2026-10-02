// Lecture / transformation d'un fichier .mscz (zip) contenant un .mscx (XML MuseScore)
import { unzipSync, zipSync, strFromU8, strToU8 } from '../lib/fflate.js'

const LETTERS = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const SOLFEGE = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' }
const ACC = { '-2': '♭♭', '-1': '♭', '0': '', '1': '♯', '2': '♯♯' }
const GRACE_TAGS = ['acciaccatura', 'appoggiatura', 'grace4', 'grace8after', 'grace16', 'grace16after', 'grace32', 'grace32after']
const MANUAL_NAME_RE = /^\s*(do|ré|re|mi|fa|sol|la|si|[a-g])\s*(♯|♭|#|b|x|𝄪|𝄫|dièse|diese|bémol|bemol){0,2}\s*[0-9]?\s*$/i

const kids = (el, tag) => Array.from(el.children).filter(c => c.tagName === tag)
const kid = (el, tag) => Array.from(el.children).find(c => c.tagName === tag)
const txt = (el, tag) => { const k = el && kid(el, tag); return k ? k.textContent.trim() : null }

// Polices embarquées dans webmscore ; les autres (Times New Roman, Arial…) sont remplacées
const FONTS_OK = /^(scoretext|symbol|edwin|freeserif|freesans|musejazz text|musejazz|campania|leland text|bravura text|gootville text|mscore text|petaluma text|petaluma script|finale maestro text|finale broadway text|mscoretab|mscore bc|leland|bravura|mscore|gootville|petaluma|finale maestro|finale broadway)$/i
const SANS = /sans|arial|helvet|calibri|verdana|segoe|tahoma|roboto|lato|open|ubuntu|trebuchet|century gothic|futura|gill/i
function mapFont(f) {
  const n = f.trim()
  if (!n || FONTS_OK.test(n)) return f
  return SANS.test(n) ? 'FreeSans' : 'FreeSerif'
}
export function fixFonts(x) {
  return x
    .replace(/(<font face=")([^"]*)(")/g, (m, a, f, b) => a + mapFont(f) + b)
    .replace(/(&lt;font face=&quot;)(.*?)(&quot;)/g, (m, a, f, b) => a + mapFont(f) + b)
    .replace(/(<family>)([^<]*)(<\/family>)/g, (m, a, f, b) => a + mapFont(f) + b)
    .replace(/(<(\w*FontFace)>)([^<]*)(<\/\2>)/g, (m, a, t, f, b) => a + mapFont(f) + b)
}

export function tpcName(tpc, mode, octave, pitch) {
  const letter = LETTERS[(((tpc + 1) % 7) + 7) % 7]
  const acc = Math.floor((tpc + 1) / 7) - 2
  let s = (mode === 'solfege' ? SOLFEGE[letter] : letter) + (ACC[acc] ?? '')
  if (octave && pitch != null) s += Math.floor((pitch - acc) / 12) - 1
  return s
}

export class MsczFile {
  constructor(bytes, name) {
    this.name = name
    this.bytes = bytes
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
    this.files = isZip ? unzipSync(bytes) : { 'score.mscx': bytes }
    let root = null
    const cont = this.files['META-INF/container.xml']
    if (cont) {
      const m = strFromU8(cont).match(/full-path="([^"]+\.mscx)"/)
      if (m && this.files[m[1]]) root = m[1]
    }
    if (!root) root = Object.keys(this.files).find(n => n.endsWith('.mscx') && !n.includes('/'))
    if (!root) root = Object.keys(this.files).find(n => n.endsWith('.mscx'))
    if (!root) throw new Error('Aucun fichier .mscx dans ce .mscz')
    this.root = root
    this.xml = strFromU8(this.files[root])
    this.styleName = Object.keys(this.files).find(n => n.endsWith('.mss') && !n.includes('/'))
    this._parseInfo()
  }

  _doc() {
    const doc = new DOMParser().parseFromString(this.xml, 'application/xml')
    if (doc.querySelector('parsererror')) throw new Error('XML MuseScore illisible')
    return doc
  }

  _mainScore(doc) {
    return kid(doc.documentElement, 'Score')
  }

  _parseInfo() {
    const doc = this._doc()
    const score = this._mainScore(doc)
    this.version = doc.documentElement.getAttribute('version')
    this.parts = []
    this.staffToPart = {}
    let staffIndex = 0
    for (const p of kids(score, 'Part')) {
      const inst = kid(p, 'Instrument')
      let name = txt(p, 'trackName') || (inst && (txt(inst, 'longName') || txt(inst, 'trackName'))) || `Piste ${this.parts.length + 1}`
      name = name.replace(/<[^>]*>/g, '').trim() || `Piste ${this.parts.length + 1}`
      // MS3 : <Staff id="n"> ; MS4 : pas d'id -> numérotation séquentielle (1-based)
      const staves = kids(p, 'Staff').map((s, k) => s.getAttribute('id') || String(staffIndex + k + 1))
      const drum = !!(inst && txt(inst, 'useDrumset') === '1') ||
        kids(p, 'Staff').some(s => { const st = kid(s, 'StaffType'); return st && st.getAttribute('group') === 'percussion' })
      const transpose = inst ? parseInt(txt(inst, 'transposeChromatic') || '0', 10) : 0
      const part = { index: this.parts.length, name, staves, drum, visible: txt(p, 'show') !== '0', transpose, firstStaff: staffIndex }
      staves.forEach(id => { this.staffToPart[id] = part.index })
      staffIndex += staves.length
      this.parts.push(part)
    }
    this.staffCount = staffIndex
    // concert pitch
    let cp = null
    const style = kid(score, 'Style')
    if (style) cp = txt(style, 'concertPitch')
    if (cp == null && this.styleName) {
      const m = strFromU8(this.files[this.styleName]).match(/<concertPitch>(\d)<\/concertPitch>/)
      if (m) cp = m[1]
    }
    this.concertPitch = cp === '1'
    const hasManual = /<Note>[\s\S]{0,400}?<Text>[\s\S]{0,300}?<text>\s*(Do|Ré|Re|Mi|Fa|Sol|La|Si)\b/i.test(this.xml) ||
      /<StaffText>(?:(?!<\/StaffText>)[\s\S]){0,200}<text>\s*(Do|Ré|Re|Mi|Fa|Sol|La|Si)\s*[♯♭#b]?\s*<\/text>/i.test(this.xml)
    this.hasManualNames = hasManual
  }

  /**
   * Construit un .mscz modifié.
   * opts: { visible: bool[], names: 'off'|'letter'|'solfege', octave: bool, above: bool, hideManual: bool }
   */
  build(opts) {
    const doc = this._doc()
    const score = this._mainScore(doc)
    // toujours en mode page (un fichier sauvegardé en « vue continue » donnerait une page vide)
    kids(score, 'layoutMode').forEach(e => e.remove())
    // MS 4.4+ : balises racine inconnues du moteur 4.0 (ex. <LastEID>) -> partition vide ; on les retire
    for (const e of Array.from(doc.documentElement.children)) {
      if (!['programVersion', 'programRevision', 'Score'].includes(e.tagName)) e.remove()
    }
    const parts = kids(score, 'Part')
    parts.forEach((p, i) => {
      kids(p, 'show').forEach(s => s.remove())
      const vis = !(opts.visible && opts.visible[i] === false)
      // MS 4.x : visibilité aussi stockée par portée
      for (const st of kids(p, 'Staff')) kids(st, 'isStaffVisible').forEach(e => { e.textContent = vis ? '1' : '0' })
      if (!vis) {
        const s = doc.createElement('show')
        s.textContent = '0'
        p.insertBefore(s, p.firstElementChild ? p.firstElementChild.nextSibling : null)
      }
    })

    const doNames = opts.names && opts.names !== 'off'
    if (doNames || opts.hideManual) {
      for (const staff of kids(score, 'Staff')) {
        const pi = this.staffToPart[staff.getAttribute('id')]
        const part = this.parts[pi]
        if (!part || part.drum) continue
        if (opts.visible && opts.visible[pi] === false) continue
        if (opts.hideManual) {
          for (const t of Array.from(staff.getElementsByTagName('StaffText'))) {
            const v = (txt(t, 'text') || '').replace(/<[^>]*>/g, '')
            if (MANUAL_NAME_RE.test(v)) t.remove()
          }
        }
        const chords = staff.getElementsByTagName('Chord')
        let base = 0
        if (doNames) {
          for (const l of staff.getElementsByTagName('Lyrics')) {
            const no = parseInt(txt(l, 'no') || '0', 10)
            base = Math.max(base, no + 1)
          }
        }
        for (const chord of Array.from(chords)) {
          const notes = kids(chord, 'Note')
          if (opts.hideManual) {
            for (const n of notes) for (const t of kids(n, 'Text')) {
              const s = (txt(t, 'text') || '').replace(/<[^>]*>/g, '')
              if (MANUAL_NAME_RE.test(s)) t.remove()
            }
          }
          if (!doNames) continue
          if (GRACE_TAGS.some(g => kid(chord, g))) continue
          const items = []
          for (const n of notes) {
            if (isTieEnd(n)) continue
            const pitch = parseInt(txt(n, 'pitch') || '60', 10)
            const tpc = parseInt(txt(n, 'tpc') || '14', 10)
            const tpc2 = txt(n, 'tpc2')
            let useTpc = tpc, usePitch = pitch
            if (!this.concertPitch && tpc2 != null) { useTpc = parseInt(tpc2, 10); usePitch = pitch - part.transpose }
            items.push({ pitch, label: tpcName(useTpc, opts.names, opts.octave, usePitch) })
          }
          if (!items.length) continue
          items.sort((a, b) => b.pitch - a.pitch)
          items.forEach((it, k) => {
            const ly = doc.createElement('Lyrics')
            const no = base + k
            if (no > 0) { const e = doc.createElement('no'); e.textContent = String(no); ly.appendChild(e) }
            if (opts.above) { const e = doc.createElement('placement'); e.textContent = 'above'; ly.appendChild(e) }
            const t = doc.createElement('text'); t.textContent = it.label; ly.appendChild(t)
            const firstNote = kid(chord, 'Note')
            chord.insertBefore(ly, firstNote || null)
          })
        }
      }
    }

    let styleVals = doNames ? { lyricsOddFontSize: '9', lyricsEvenFontSize: '9', lyricsMinDistance: '0.5', lyricsMinTopDistance: '0.6' } : null
    if (opts.line) {
      // « une seule ligne » : page très large et juste assez haute pour un système ; plus de sauts de ligne/page
      for (const lb of Array.from(score.getElementsByTagName('LayoutBreak'))) {
        const t = (kid(lb, 'subtype') || {}).textContent
        if (t === 'line' || t === 'page' || t === 'section') lb.remove()
      }
      const firstStaff = kids(score, 'Staff')[0]
      const nMeas = firstStaff ? kids(firstStaff, 'Measure').length : 50
      const nStaves = parts.reduce((n, p, i) => n + ((opts.visible && opts.visible[i] === false) ? 0 : kids(p, 'Staff').length), 0)
      const w = Math.min(1200, Math.max(14, nMeas * 2.1)), h = 1.6 + Math.max(1, nStaves) * (doNames ? 1.25 : 0.95)
      styleVals = Object.assign(styleVals || {}, {
        pageWidth: w.toFixed(2), pageHeight: h.toFixed(2), pagePrintableWidth: (w - 0.6).toFixed(2),
        pageEvenLeftMargin: '0.3', pageOddLeftMargin: '0.3', pageEvenTopMargin: '0.3', pageOddTopMargin: '0.3',
        pageEvenBottomMargin: '0.3', pageOddBottomMargin: '0.3', lastSystemFillLimit: '0', showHeader: '0', showFooter: '0',
      })
    }
    if (styleVals) {
      let st = kid(score, 'Style')
      if (!st) { st = doc.createElement('Style'); score.insertBefore(st, score.firstElementChild) }
      for (const [k, v] of Object.entries(styleVals)) {
        let e = kid(st, k)
        if (!e) { e = doc.createElement(k); st.appendChild(e) }
        e.textContent = v
      }
    }

    let out = new XMLSerializer().serializeToString(doc)
    if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out
    const files = { ...this.files, [this.root]: strToU8(fixFonts(out)) }
    if (this.styleName) {
      let mss = fixFonts(strFromU8(this.files[this.styleName]))
      if (styleVals) for (const [k, v] of Object.entries(styleVals)) {
        const re = new RegExp(`<${k}>[^<]*</${k}>`)
        mss = re.test(mss) ? mss.replace(re, `<${k}>${v}</${k}>`) : mss.replace('</Style>', `<${k}>${v}</${k}>\n</Style>`)
      }
      files[this.styleName] = strToU8(mss)
    }
    if (!files['META-INF/container.xml']) {
      files['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles><rootfile full-path="${this.root}"/></rootfiles></container>\n`)
    }
    return zipSync(files, { level: 0 })
  }

  thumbnail() {
    const t = this.files['Thumbnails/thumbnail.png']
    return t ? new Blob([t], { type: 'image/png' }) : null
  }
}

function isTieEnd(note) {
  for (const sp of kids(note, 'Spanner')) {
    if (sp.getAttribute('type') === 'Tie' && kid(sp, 'prev')) return true
  }
  return false
}

/** Lit seulement la vignette d'un mscz (rapide) */
export function readThumbnail(bytes) {
  try {
    const f = unzipSync(bytes, { filter: f => f.name === 'Thumbnails/thumbnail.png' })
    const t = f['Thumbnails/thumbnail.png']
    return t ? new Blob([t], { type: 'image/png' }) : null
  } catch { return null }
}

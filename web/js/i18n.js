// Langues de la page web (prof) : français (source), anglais, coréen.
// L'appli Android reste en français. Le texte français sert de clé : la traduction est appliquée
// directement sur la page (nœuds de texte, placeholder, title), y compris sur ce qui apparaît ensuite
// (MutationObserver). Les clés avec {0}, {1}… sont des modèles (ex. « Envoyé à {0} ✓ »).
import { DICT } from './i18n-dict.js'

const native = !!window.MsczNative
const LANGS = ['fr', 'en', 'ko']
function detect() {
  if (native) return 'fr'
  try { const v = JSON.parse(localStorage.getItem('mcsz:lang') || 'null'); if (LANGS.includes(v)) return v } catch { }
  return 'fr'   // français par défaut ; EN / 한국어 se choisissent dans les Options
}
export const LANG = detect()
const IDX = { en: 0, ko: 1 }[LANG]
document.documentElement.lang = LANG

// clés exactes + modèles
const exact = new Map(), tpl = []
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
for (const [k, v] of Object.entries(DICT)) {
  if (!Array.isArray(v) || v[IDX] == null) continue
  if (/\{\d\}/.test(k)) {
    const parts = k.split(/\{(\d)\}/), order = []
    let re = '^'
    parts.forEach((p, i) => { if (i % 2) { re += '([\\s\\S]+?)'; order.push(+p) } else re += esc(p) })
    tpl.push({ re: new RegExp(re + '$'), order, out: v[IDX] })
  } else exact.set(k, v[IDX])
}
tpl.sort((a, b) => b.re.source.length - a.re.source.length)   // le plus précis d'abord

export function t(s) {
  if (IDX == null || s == null) return s
  const str = String(s), k = str.trim()
  if (!k) return str
  let r = exact.get(k)
  if (r == null) {
    for (const m of tpl) {
      const x = k.match(m.re); if (!x) continue
      r = m.out.replace(/\{(\d)\}/g, (_, n) => { const i = m.order.indexOf(+n); return i >= 0 ? t(x[i + 1]) : '' })
      break
    }
  }
  if (r == null) return str
  return str.replace(k, r)
}
window.__t = t

const SKIP = 'script,style,svg,textarea,input,select,.notr'
function trNode(n) {
  if (n.nodeType === 3) {
    const p = n.parentElement; if (!p || p.closest(SKIP)) return
    const v = n.nodeValue; if (!v || !/[A-Za-zÀ-ÿ]/.test(v)) return
    const r = t(v); if (r !== v) n.nodeValue = r
  } else if (n.nodeType === 1) {
    if (n.matches && n.matches('script,style,svg')) return
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = n.getAttribute && n.getAttribute(a); if (v) { const r = t(v); if (r !== v) n.setAttribute(a, r) }
    }
    if (n.matches && n.matches('textarea,select')) return
    for (const c of n.childNodes) trNode(c)
  }
}
export function translateDom(root = document.body) {
  if (IDX == null) return
  trNode(root)
  new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'characterData') trNode(m.target)
      else if (m.type === 'attributes') trNode(m.target)
      else m.addedNodes.forEach(trNode)
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] })
  // boîtes du navigateur
  const c = window.confirm.bind(window), a = window.alert.bind(window)
  window.confirm = m => c(t(m)); window.alert = m => a(t(m))
  const pr = window.prompt.bind(window); window.prompt = (m, d) => pr(t(m), d)
}

// sélecteur de langue (page web uniquement)
export function langPicker(el) {
  if (!el || native) { if (el) el.hidden = true; return }
  el.hidden = false
  el.innerHTML = LANGS.map(l => `<option value="${l}"${l === LANG ? ' selected' : ''}>${{ fr: 'FR', en: 'EN', ko: '한국어' }[l]}</option>`).join('')
  el.onchange = () => { localStorage.setItem('mcsz:lang', JSON.stringify(el.value)); location.reload() }
}
export const guideUrl = () => 'guide' + (LANG === 'fr' ? '' : '-' + LANG) + '.html'

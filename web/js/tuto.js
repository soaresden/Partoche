// Visite guidée : une bulle par étape, pointée sur un élément de l'interface.
// steps: [{ sel, text, title? }] — les éléments absents ou cachés sont sautés.

let cur = null

export function runTour(steps, onEnd) {
  endTour(false)
  const list = steps.filter(s => { const el = document.querySelector(s.sel); return el && el.offsetParent !== null })
  if (!list.length) { onEnd && onEnd(); return }
  const ov = document.createElement('div'); ov.className = 'tour'
  ov.innerHTML = '<div class="tspot"></div><div class="tbub"><div class="tttl"></div><div class="ttxt"></div><div class="tnav"><span class="tcount"></span><button class="btn tskip">Passer</button><button class="btn primary tnext">Suivant</button></div></div>'
  document.body.appendChild(ov)
  cur = { ov, list, i: 0, onEnd }
  ov.querySelector('.tskip').onclick = () => endTour(true)
  ov.querySelector('.tnext').onclick = () => { cur.i++; if (cur.i >= cur.list.length) endTour(true); else place() }
  ov.addEventListener('click', e => { if (e.target === ov) ov.querySelector('.tnext').click() })
  addEventListener('resize', place)
  place()
}

function place() {
  if (!cur) return
  const { ov, list, i } = cur
  const st = list[i], el = document.querySelector(st.sel)
  const spot = ov.querySelector('.tspot'), bub = ov.querySelector('.tbub')
  const T = window.__t || (x => x)
  ov.querySelector('.tttl').textContent = T(st.title || '')
  ov.querySelector('.ttxt').innerHTML = T(st.text)
  ov.querySelector('.tcount').textContent = (i + 1) + ' / ' + list.length
  ov.querySelector('.tnext').textContent = i === list.length - 1 ? 'Terminer' : 'Suivant'
  if (!el) return
  el.scrollIntoView && el.scrollIntoView({ block: 'nearest' })
  const r = el.getBoundingClientRect(), pad = 6
  Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' })
  const bw = Math.min(360, innerWidth - 24)
  bub.style.width = bw + 'px'
  const bh = bub.offsetHeight
  let left = Math.min(innerWidth - bw - 12, Math.max(12, r.left + r.width / 2 - bw / 2))
  let top = r.bottom + 14
  if (top + bh > innerHeight - 12) top = Math.max(12, r.top - bh - 14)
  bub.style.left = left + 'px'; bub.style.top = top + 'px'
}

export function endTour(done) {
  if (!cur) return
  const c = cur; cur = null
  removeEventListener('resize', place)
  c.ov.remove()
  if (done && c.onEnd) c.onEnd()
}

export const tourOpen = () => !!cur

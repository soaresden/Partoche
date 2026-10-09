// Partoche And Prof hors ligne (page web du prof, sur iPad / ordinateur ; l'appli Android n'en a pas besoin).
//  - l'appli (HTML, JS, CSS, images) : réseau d'abord (toujours la dernière version), copie gardée pour le hors-ligne ;
//  - le moteur MuseScore (lib/) : gardé une fois pour toutes (gros fichiers) ; les sons, l'appli les garde déjà elle-même ;
//  - pCloud, relais « en ligne » : jamais mis en cache ici (l'appli garde elle-même partitions et annotations).
self.window = self
try { importScripts('version.js') } catch { }
const V = self.PARTOCHE_VERSION || 'dev'
const APP = 'pap-app-' + V, LIB = 'pap-lib-1'
const SHELL = ['./', 'index.html', 'css/app.css', 'config.js', 'version.js', 'manifest.json',
  'js/app.js', 'js/audio.js', 'js/i18n.js', 'js/i18n-dict.js', 'js/ink.js', 'js/midi.js', 'js/pcloud.js', 'js/score.js',
  'js/store.js', 'js/tuner.js', 'js/tuto.js', 'lib/fflate.js', 'img/logo.svg', 'img/favicon.png', 'img/icon-192.png', 'img/icon-512.png']
const ENGINE = ['lib/webmscore.mjs', 'lib/webmscore.lib.js', 'lib/webmscore.lib.wasm', 'lib/webmscore.lib.mem.wasm', 'lib/webmscore.lib.data']

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await (await caches.open(APP)).addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))
    const lib = await caches.open(LIB)   // moteur : en arrière-plan, sans bloquer l'installation s'il échoue
    for (const u of ENGINE) { try { if (!(await lib.match(u))) await lib.add(u) } catch { } }
    self.skipWaiting()
  })())
})
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pap-app-') && k !== APP) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const r = e.request
  if (r.method !== 'GET') return
  const u = new URL(r.url)
  if (u.origin !== location.origin) return
  if (/\/lib\//.test(u.pathname)) { e.respondWith(cacheFirst(LIB, r)); return }
  e.respondWith(networkFirst(r))
})
async function cacheFirst(name, r) {
  const c = await caches.open(name), hit = await c.match(r, { ignoreSearch: true })
  if (hit) return hit
  const res = await fetch(r)
  if (res.ok) c.put(r, res.clone())
  return res
}
async function networkFirst(r) {
  const c = await caches.open(APP)
  try {
    const res = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('lent')), 4000))])
    if (res.ok) c.put(r, res.clone())
    return res
  } catch (e) {
    const hit = await c.match(r, { ignoreSearch: true }) || (r.mode === 'navigate' && await c.match('index.html'))
    if (hit) return hit
    throw e
  }
}

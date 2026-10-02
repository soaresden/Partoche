// Petit stockage clé/valeur : IndexedDB (annotations, vignettes) + localStorage (préférences)
let dbp = null
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('mcsz-player', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return dbp
}
export async function idbGet(k) {
  try {
    const d = await db()
    return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
  } catch { return undefined }
}
export async function idbSet(k, v) {
  try {
    const d = await db()
    await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error) })
  } catch { }
}
export function lsGet(k, def) {
  try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v) } catch { return def }
}
export function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { }
}
export async function idbKeys(prefix) {
  try {
    const d = await db()
    const keys = await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
    return keys.filter(k => typeof k === 'string' && k.startsWith(prefix))
  } catch { return [] }
}

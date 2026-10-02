import { unzipSync } from '../lib/fflate.js'

// Accès en lecture à un lien public pCloud (avec mot de passe) + dépôt via un lien d'envoi pCloud.
//   showpublink        -> arborescence du dossier partagé
//   getpublinkdownload -> URL de téléchargement d'un fichier
//   uploadtolink       -> envoi d'un fichier dans le dossier « dépôt » (pas de compte nécessaire)

export function parseLink(link) {
  if (!link) return null
  const m = String(link).match(/code=([A-Za-z0-9]+)/) || String(link).match(/^([A-Za-z0-9]{20,})$/)
  if (!m) return null
  const eu = /e\.pcloud\.link|eapi\.pcloud|^e:/.test(link) || !/u\.pcloud\.link|my\.pcloud\.com\/publink/.test(link)
  return { code: m[1], api: eu ? 'https://eapi.pcloud.com' : 'https://api.pcloud.com' }
}

async function call(api, method, params, opts = {}) {
  const q = new URLSearchParams(params).toString()
  const r = await fetch(`${api}/${method}?${q}`, opts)
  const d = await r.json()
  if (d.result !== 0) { const e = new Error(d.error || ('pCloud ' + d.result)); e.code = d.result; throw e }
  return d
}

export class PublicFolder {
  constructor(link, password) {
    const p = parseLink(link)
    if (!p) throw new Error('Lien pCloud invalide')
    Object.assign(this, p)
    this.password = password || ''
    this.root = null
  }
  _p(extra) { const o = { code: this.code, ...extra }; if (this.password) o.linkpassword = this.password; return o }
  async list() {
    const d = await call(this.api, 'showpublink', this._p({}))
    this.root = d.metadata
    return this.root
  }
  // trouve un sous-dossier par nom (insensible à la casse), à n'importe quelle profondeur (2 niveaux max)
  folder(name, from = this.root, depth = 0) {
    if (!from || !name) return null
    for (const c of from.contents || []) if (c.isfolder && c.name.toLowerCase() === name.toLowerCase()) return c
    if (depth < 2) for (const c of from.contents || []) if (c.isfolder) { const f = this.folder(name, c, depth + 1); if (f) return f }
    return null
  }
  // tous les fichiers sous un dossier : [{ meta, rel }]
  files(from, filter = () => true, prefix = '', depth = 0, out = []) {
    for (const c of (from && from.contents) || []) {
      if (c.isfolder) { if (depth < 4) this.files(c, filter, prefix + c.name + '/', depth + 1, out) }
      else if (filter(c)) out.push({ meta: c, rel: prefix + c.name })
    }
    return out
  }
  async url(fileid) {
    const d = await call(this.api, 'getpublinkdownload', this._p({ fileid, forcedownload: 1 }))
    return 'https://' + d.hosts[0] + d.path
  }
  // Les serveurs de téléchargement pCloud n'autorisent pas les autres sites (CORS) :
  // on passe par l'API (getpubzip / getpubtextfile), qui, elle, les autorise.
  async bytes(fileid) {
    const q = new URLSearchParams(this._p({ fileids: fileid })).toString()
    const r = await fetch(`${this.api}/getpubzip?${q}`)
    if (!r.ok) throw new Error('Téléchargement pCloud impossible (' + r.status + ')')
    const buf = new Uint8Array(await r.arrayBuffer())
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {   // pas un zip : message d'erreur JSON
      let e = 'réponse inattendue'; try { const d = JSON.parse(new TextDecoder().decode(buf)); e = d.error || e } catch { }
      throw new Error('pCloud : ' + e)
    }
    const files = unzipSync(buf)
    const name = Object.keys(files).find(n => !n.endsWith('/'))
    if (!name) throw new Error('pCloud : fichier vide')
    return files[name]
  }
  async text(fileid) {
    const q = new URLSearchParams(this._p({ fileid })).toString()
    const r = await fetch(`${this.api}/getpubtextfile?${q}`)
    const t = await r.text()
    if (/^\s*\{\s*"result"\s*:\s*[1-9]/.test(t)) { let e = 'erreur'; try { e = JSON.parse(t).error } catch { } throw new Error('pCloud : ' + e) }
    return t
  }
}

// Envoi d'un fichier via un lien de dépôt pCloud (« Upload link »)
export async function uploadToLink(link, who, name, text) {
  const p = parseLink(link)
  if (!p) throw new Error('Lien de dépôt pCloud invalide')
  let last = null
  // essai sur le serveur de la région du lien, puis sur l'autre (EU / US)
  for (const api of [p.api, p.api.includes('eapi') ? 'https://api.pcloud.com' : 'https://eapi.pcloud.com']) {
    const fd = new FormData()
    fd.append('file', text instanceof Blob ? text : new Blob([text], { type: typeof text === 'string' ? 'application/json' : 'application/octet-stream' }), name)
    const r = await fetch(`${api}/uploadtolink?code=${p.code}&names=${encodeURIComponent(who || 'Invité')}`, { method: 'POST', body: fd })
    const d = await r.json()
    if (d.result === 0) return d
    last = d
    if (d.result !== 2012) break   // 2012 = code inconnu sur ce serveur -> on tente l'autre
  }
  if (last && last.result === 2012) throw new Error('ce n’est pas un lien de dépôt (« Demander des fichiers »)')
  throw new Error((last && last.error) || 'envoi refusé')
}

// Vérifie un lien de dépôt : { ok, folder } ou { ok:false, error }
export async function checkUploadLink(link) {
  const p = parseLink(link)
  if (!p) return { ok: false, error: 'lien illisible' }
  for (const api of [p.api, p.api.includes('eapi') ? 'https://api.pcloud.com' : 'https://eapi.pcloud.com']) {
    try {
      const d = await (await fetch(`${api}/showuploadlink?code=${p.code}`)).json()
      if (d.result === 0) return { ok: true, folder: (d.metadata && d.metadata.name) || d.name || '' }
    } catch { }
  }
  return { ok: false, error: 'ce n’est pas un lien de dépôt (« Demander des fichiers »)' }
}

// Nom des fichiers déposés : « <Auteur> - <fichier annotations sans .json> - AAAAMMJJ-HHMMSS.json »
export const stamp = (t = new Date()) => {
  const p = n => String(n).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}
export function dropName(who, docFileName) { return `${who} - ${docFileName.replace(/\.json$/i, '')} - ${stamp()}.json` }
export function parseDropName(who, name) {
  const pre = who + ' - '
  if (!name.startsWith(pre)) return null
  const m = name.slice(pre.length).match(/^(.*) - (\d{8}-\d{6})(?: ?\(\d+\))?\.json$/i)
  return m ? { doc: m[1] + '.json', stamp: m[2] } : null
}

// n'importe quel auteur : { who, doc, stamp }
export function parseAnyDrop(name) {
  const m = name.match(/^(.+?) - (.+\.(?:mscz|mscx)|!Agenda|!Avis) - (\d{8}-\d{6})(?: ?\(\d+\))?\.json$/i)
  return m ? { who: m[1], doc: m[2] + '.json', stamp: m[3] } : null
}

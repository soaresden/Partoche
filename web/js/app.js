import { MsczFile, readThumbnail } from './score.js'
import { parseMidi } from './midi.js'
import { Player, GM } from './audio.js'
import { Ink } from './ink.js'
import { Tuner } from './tuner.js'
import { idbGet, idbSet, idbKeys, lsGet, lsSet } from './store.js'
import { runTour } from './tuto.js'
import { LANG, translateDom, langPicker, guideUrl } from './i18n.js'
const LOC = { fr: 'fr-FR', en: 'en-GB', ko: 'ko-KR' }[LANG] || 'fr-FR'
import { PublicFolder, uploadToLink, checkUploadLink, dropName, parseAnyDrop, parseLink } from './pcloud.js'

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))
const native = window.MsczNative || null
const bridge = window.__native = {}
const SHARE = window.MSCZ_SHARE || {}
// rôle : 'eleve' (ses partitions, ses annotations) ou 'prof' (lit les partitions partagées par ses élèves et les annote)
let ROLE = lsGet('mcsz:role', '')
if (SHARE.teacher) ROLE = 'prof'   // page web du prof
const TEACHER = ROLE === 'prof'
const DEMO = !!lsGet('mcsz:demo', false)
if (TEACHER) document.body.classList.add('teacher')
// prof : liste de ses élèves { id, name, link, pwd, upload }
function students() {
  let l = lsGet('mcsz:students', null)
  if (!l) {   // page préconfigurée (config.js) : premier élève déjà connu
    l = SHARE.link ? [{ id: 's1', name: SHARE.owner || 'Élève', link: SHARE.link, pwd: lsGet('mcsz:sharePwd', ''), upload: SHARE.upload || '' }] : []
    lsSet('mcsz:students', l)
  }
  return l
}
const saveStudents = l => lsSet('mcsz:students', l)
// ---- codes Partoche : tout (liens + mot de passe) dans un seul texte, ou dans un lien ----
// « P1. » + JSON en base64 (pas un chiffrement : un emballage pour copier-coller sans erreur)
const PAGE_URL = 'https://soaresden.github.io/Partoche/'
function packCode(o) { const b = new TextEncoder().encode(JSON.stringify(o)); let t = ''; b.forEach(x => t += String.fromCharCode(x)); return 'P1.' + btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function unpackCode(txt) {
  const m = String(txt || '').match(/P1\.([A-Za-z0-9_-]+)/); if (!m) return null
  try { const t = atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); return JSON.parse(new TextDecoder().decode(Uint8Array.from(t, c => c.charCodeAt(0)))) } catch { return null }
}
// ajoute / met à jour les élèves contenus dans un code ; renvoie { add, upd, last }
function applyCode(o) {
  const list = o && (o.k === 'b' ? (o.s || []) : o.k === 'e' ? [o] : null); if (!list) return null
  const l = students(); let add = 0, upd = 0, last = null
  for (const x of list) {
    const st = { name: x.n || x.name, link: x.l || x.link, pwd: x.p != null ? x.p : x.pwd, upload: x.u || x.upload || '', emoji: x.e || x.emoji, color: x.c || x.color }
    if (!st.link) continue
    Object.keys(st).forEach(k => st[k] === undefined && delete st[k])
    const code = (String(st.link).match(/code=([A-Za-z0-9]+)/) || [])[1]
    const i = l.findIndex(y => code && (String(y.link).match(/code=([A-Za-z0-9]+)/) || [])[1] === code)
    if (i >= 0) { l[i] = { ...l[i], ...st }; upd++; last = l[i] } else { last = { id: 's' + Date.now() + '' + add, ...st }; l.push(last); add++ }
  }
  saveStudents(l)
  if (o.k === 'b') { if (o.me && !lsGet('mcsz:me', '')) lsSet('mcsz:me', o.me); const g = lsGet('mcsz:global', {}); if (o.pr && !g.profile) g.profile = o.pr; if (o.dp && !g.dispo) g.dispo = o.dp; lsSet('mcsz:global', g) }
  if (last && o.k === 'e') lsSet('mcsz:student', last.id)
  return { add, upd, last }
}
const studentsCode = () => packCode({ k: 'b', me: lsGet('mcsz:me', ''), pr: (lsGet('mcsz:global', {}) || {}).profile || null, dp: (lsGet('mcsz:global', {}) || {}).dispo || null, s: students().map(x => ({ n: x.name, l: x.link, p: x.pwd || '', u: x.upload || '', e: x.emoji, c: x.color })) })
// lien d'invitation ouvert par la prof : …/Partoche/#P1.xxxx
let _codeMsg = ''
if (TEACHER && /P1\./.test(location.hash)) {
  const r = applyCode(unpackCode(decodeURIComponent(location.hash)))
  _codeMsg = r ? (r.add ? '✓ ' + (r.last && r.last.name || 'Élève') + ' ajouté(e) à tes élèves' : '✓ ' + (r.last && r.last.name || 'Élève') + ' mis(e) à jour') : 'Lien d’invitation illisible'
  try { history.replaceState(null, '', location.pathname + location.search) } catch { }
}
function curStudent() { const l = students(); return l.find(x => x.id === lsGet('mcsz:student', '')) || l[0] || null }
const myName = () => lsGet('mcsz:me', '') || 'Prof'
const ownerName = () => (curStudent() || {}).name || 'l’élève'

// =====================================================================
//  SAUVEGARDE — dossier de sauvegarde (par défaut <partitions>/_MSCZ Player) :
//     !Settings.json            préférences + historique
//     <partition>.mscz.json     un fichier par partition (état actuel, pas d'historique)
//  L'écriture est faite côté Android : file d'attente, 1 fichier à la fois, ouverture du fichier
//  existant (jamais de doublon), relecture de vérification, nouvel essai jusqu'à réussite.
// =====================================================================
const SETTINGS_FILE = '!Settings.json'
const docFile = e => (e.rel || e.name).replace(/[\\/]/g, ' ~ ') + '.json'
const parseJ = t => { try { return t ? JSON.parse(t) : null } catch { return null } }
const nRead = name => { try { return native && native.readData ? native.readData(name) : '' } catch { return '' } }
let libDir = null          // dossier (navigateur)
const dataIndex = new Map() // nom de fichier -> date de modification (colonne « Édité le »)

// JSON lisible : indentation, mais les listes de nombres (points d'un trait) restent sur une ligne
function pretty(v, ind = '') {
  const inner = ind + '  '
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    const prim = x => x === null || typeof x !== 'object'
    const flat = v.every(x => prim(x) || (Array.isArray(x) && x.every(prim)))
    if (flat) return JSON.stringify(v)
    return '[\n' + v.map(x => inner + pretty(x, inner)).join(',\n') + '\n' + ind + ']'
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined)
    if (!keys.length) return '{}'
    return '{\n' + keys.map(k => inner + JSON.stringify(k) + ': ' + pretty(v[k], inner)).join(',\n') + '\n' + ind + '}'
  }
  return JSON.stringify(v)
}

// ---- indicateur d'enregistrement ----
let saveHideT = 0
function showSave(state, text) {
  const el = $('#saveState')
  if (!el) return
  clearTimeout(saveHideT)
  el.className = 'savestate ' + state
  el.querySelector('span').textContent = text
  el.hidden = false
  if (state === 'saved' || state === 'dirty') saveHideT = setTimeout(() => { el.hidden = true }, state === 'dirty' ? 3000 : 2500)
}
bridge.onSaveState = json => {
  const d = parseJ(json) || {}
  if (d.state === 'saving') showSave('saving', 'Enregistrement…')
  else if (d.state === 'retry') showSave('retry', `Nouvel essai (${d.attempt}) — ${d.error || 'erreur'} · toucher pour le journal`)
  else if (d.state === 'saved') {
    dataIndex.set(d.name, Date.now())
    if (d.pending > 0) showSave('saving', 'Enregistrement…')
    else showSave('saved', 'Enregistré')
  }
}
const nlog = m => { try { native && native.log && native.log(String(m)) } catch { } }
window.addEventListener('error', e => nlog('ERREUR JS : ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno))
window.addEventListener('unhandledrejection', e => nlog('PROMESSE REJETÉE : ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)))
function queueFile(name, body) {
  nlog('mise en file : ' + name + ' (' + body.length + ' car.)')
  if (native && native.queueData) { native.queueData(name, body); return }
  showSave('saved', 'Enregistré')   // navigateur : copie locale uniquement
}

// ---- réglages (!Settings.json) ----
if (native) {
  const d = parseJ(nRead(SETTINGS_FILE))
  if (d && d.global && (d.updated || 0) > lsGet('mcsz:settingsUpdated', 0)) {
    lsSet('mcsz:global', d.global); lsSet('mcsz:recent', d.recent || []); lsSet('mcsz:settingsUpdated', d.updated)
  }
}
let settingsBody = '', settingsT = 0
function saveSettingsFile() {
  lsSet('mcsz:settingsUpdated', Date.now())
}
function writeSettings() {
  clearTimeout(settingsT)
  const core = { global: G, recent: lsGet('mcsz:recent', []) }
  const key = JSON.stringify(core)
  if (key === settingsBody) return
  settingsBody = key
  queueFile(SETTINGS_FILE, pretty({ app: 'Partoche', updated: lsGet('mcsz:settingsUpdated', Date.now()), ...core }))
}
const G = Object.assign({
  names: 'off', octave: false, above: false, hideManual: true,
  follow: true, fingerDraws: false, tool: 'pen', color: '#d11a2a', size: 2,
}, lsGet('mcsz:global', {}))
const saveGlobal = () => { lsSet('mcsz:global', G); saveSettingsFile() }
// élève : un emoji et une couleur par défaut, écrits dans !Settings.json (la prof les lit), même s'il n'a encore rien choisi
if (!TEACHER && !(G.profile && G.profile.emoji)) { G.profile = Object.assign({ emoji: '🎻', color: '#9b3fc0' }, G.profile || {}); saveGlobal(); setTimeout(() => writeSettings(), 3000) }

// ---------- utilitaires UI ----------
function busy(msg) {
  if (msg === false) { $('#busy').hidden = true; return }
  $('#busyMsg').textContent = msg
  $('#busy').hidden = false
}
let toastT = 0
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true }, ms)
}
const fmt = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
const baseName = n => n.replace(/\.(mscz|mscx)$/i, '')
function show(screen) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === screen))
  if (native && native.keepScreenOn) try { native.keepScreenOn(screen === 'viewer') } catch { }
}

// =====================================================================
//  BIBLIOTHÈQUE
// =====================================================================
let files = []          // {name, rel, url?, file?, handle?, size, mtime}
let folderName = ''
let canWriteFolder = false // dossier Android accessible en écriture

// ---------- données d'une partition (<partition>.mscz.json) ----------
async function loadDoc(entry, fileKey) {
  const rel = entry.rel || entry.name
  const local = await idbGet('mcsz:doc:' + rel)
  const inFile = native ? parseJ(nRead(docFile(entry))) : null
  let doc = [local, inFile].filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]
  if (!doc) doc = { updated: 0, prefs: lsGet('mcsz:file:' + fileKey, {}), ink: {}, legacyKey: fileKey }
  doc = { updated: doc.updated || 0, prefs: doc.prefs || {}, ink: doc.ink || {}, legacyKey: doc.legacyKey }
  doc._rel = rel; doc._file = docFile(entry)
  if (inFile) doc._body = JSON.stringify({ prefs: inFile.prefs || {}, ink: inFile.ink || {} })
  nlog(`ouverture « ${rel} » : fichier=${inFile ? new Date(inFile.updated || 0).toISOString() : 'absent'} local=${local ? new Date(local.updated || 0).toISOString() : 'absent'}`)
  let st = {}
  try { st = native && native.statData ? JSON.parse(native.statData(doc._file)) : {} } catch { }
  nlog(`  état fichier : existe=${!!st.exists} copies[conflicted]=${st.conflicts || 0} lu=${inFile ? 'oui' : 'non'}`)
  // (re)écrire seulement si : le fichier n'existe vraiment pas et on a des annotations locales,
  // ou s'il reste des copies « [conflicted] » à fusionner (on écrit la plus récente puis on les nettoie)
  const localInk = local && local.ink && Object.keys(local.ink).length
  if (native && ((!st.exists && !st.conflicts && localInk) || (st.conflicts && (inFile || localInk)))) {
    doc._forceWrite = true   // sera écrit au prochain enregistrement (retour en mode Main / sortie)
  }
  if (entry.demo) {   // démo : annotations fictives de l'autre rôle
    doc._demo = true
    const dj = await demoData()
    const dd = dj && dj[entry.name]
    if (dd) { doc._under = { [dd.key]: [TEACHER ? dd.eleve : dd.prof] }; doc._underWho = TEACHER ? 'Élève (démo)' : 'Prof (démo)' }
  } else if (TEACHER && share) {
    if (Date.now() - (share.t || 0) > 8000) { try { await connectShare() } catch { } }   // liste fraîche : sa dernière version, même faite sur un autre appareil
    const o = ownerDocs.get(doc._file)
    const od = o ? await shareJson(o) : null
    const stu = curStudent() || {}
    doc._under = (od && od.ink) || null; doc._underWho = (stu.emoji ? stu.emoji + ' ' : '') + ownerName(); doc._underColor = stu.color
    if (od && !local) {   // 1re ouverture : même vue (pistes, noms des notes…) que l'élève
      doc.prefs = Object.assign({}, od.prefs || {})
      const v = parseViewKey(bestKey(od.ink))
      if (v) { doc.prefs.visible = v.visible; doc.prefs.notes = v.notes }
    }
    doc._body = undefined
    const g = guestDocs.get(doc._file)
    if (g && (!local || Date.parse(g.meta.modified) > (local.updated || 0) - 5000)) {
      const gd = await shareJson(g.meta)
      if (gd && gd.ink) { if (!local || (gd.updated || 0) >= (local.updated || 0)) { doc.ink = gd.ink; doc.updated = gd.updated || doc.updated } ; doc._body = JSON.stringify(gd.ink) }
    }
  }
  return doc
}
// 1) Chaque modif -> copie locale (immédiat, rien n'est perdu)
async function saveDocNow(d) {
  if (!d || !d._pending) return
  d._pending = false
  d.updated = Date.now()
  await idbSet('mcsz:doc:' + d._rel, { updated: d.updated, prefs: d.prefs, ink: d.ink })
}
const saveDocLater = debounce(saveDocNow, 600)
function markDirty(on) { const b = $('#modeSeg [data-m=hand]'); if (b) b.classList.toggle('inkdirty', !!on) }
function saveDoc(d) { if (!d) return; d._pending = true; saveDocLater(d); if (inkOn) markDirty(true) }
// 2) Fichier pCloud écrit seulement : en repassant en mode Main, en quittant la partition, en quittant l'appli
async function commitDoc(d = V && V.doc) {
  if (!d) return
  // annotations les plus récentes (sans attendre le délai d'enregistrement automatique)
  if (V && d === V.doc && V.key && ink.pages && ink.pages.length) {
    const pages = serializeInk()
    if (pages.some(p => p.length)) d.ink[V.key] = pages; else delete d.ink[V.key]
    d._pending = true
  }
  markDirty(false)
  await saveDocNow(d)
  if (d._demo) return            // démo : gardé seulement sur l'appareil
  if (TEACHER) return sendToOwner(d)
  const core = { prefs: d.prefs, ink: d.ink }
  const key = JSON.stringify(core)
  if (key === d._body && !d._forceWrite) return          // rien n'a changé : on ne touche pas au fichier
  d._body = key; d._forceWrite = false
  nlog('enregistrement demandé : ' + d._file)
  queueFile(d._file, pretty({ app: 'Partoche', file: d._rel, updated: d.updated || Date.now(), ...core }))
}
const flushDoc = async () => { await commitDoc(); if (!TEACHER) writeSettings(); try { native && native.autoLogTick && native.autoLogTick() } catch { } }

async function getBytes(entry) {
  if (entry.pc) {
    const k = 'mcsz:pc:' + entry.pc + ':' + (entry.hash || entry.mtime)
    const c = await idbGet(k); if (c) return c
    if (!share) await connectShare()
    const b = await share.bytes(entry.pc); idbSet(k, b); return b
  }
  if (entry.file) return new Uint8Array(await entry.file.arrayBuffer())
  if (entry.handle) return new Uint8Array(await (await entry.handle.getFile()).arrayBuffer())
  const r = await fetch(entry.url)
  if (!r.ok) throw new Error('Lecture impossible (' + r.status + ')')
  return new Uint8Array(await r.arrayBuffer())
}

// =====================================================================
//  PARTAGE pCloud : le prof lit le dossier de l'élève (lien public + mot de passe)
//  et envoie ses annotations via un lien de dépôt ; l'appli de l'élève les affiche en calque.
// =====================================================================
let share = null
const ownerDocs = new Map()   // <partition>.json -> fichier (annotations de l'élève)
const guestDocs = new Map()   // <partition>.json -> { meta, stamp } (dernier envoi de la prof)
function shareCfg() {
  if (TEACHER) { const st = curStudent() || {}; return { link: st.link || '', pwd: st.pwd || '', guest: myName(), upload: st.upload || '' } }
  const c = G.share || {}
  return { link: c.link || '', pwd: c.pwd || '', guest: '' }
}
async function connectShare(pwd) {
  const c = shareCfg()
  if (pwd != null) c.pwd = pwd
  if (!c.link) throw new Error('aucun lien pCloud')
  const pf = new PublicFolder(c.link, c.pwd)
  await pf.list()
  pf.cfg = c; pf.t = Date.now()
  share = pf
  indexShare()
  return pf
}
function indexShare() {
  ownerDocs.clear(); guestDocs.clear()
  for (const { meta } of share.files(share.root, c => /\.json$/i.test(c.name))) {
    const d = parseAnyDrop(meta.name)
    if (d) {   // envoi d'un prof (côté prof : seulement les siens)
      if (TEACHER && d.who.toLowerCase() !== String(share.cfg.guest).toLowerCase()) continue
      const cur = guestDocs.get(d.doc)
      if (!cur || d.stamp > cur.stamp) guestDocs.set(d.doc, { meta, stamp: d.stamp, who: d.who })
    } else if (/\.(mscz|mscx)\.json$/i.test(meta.name) && !/\[conflicted/.test(meta.name) && !/ - \d{8}-\d{6}/.test(meta.name)) {   // annotations de l'élève
      const cur = ownerDocs.get(meta.name)
      if (!cur || Date.parse(meta.modified) > Date.parse(cur.modified)) ownerDocs.set(meta.name, meta)
    }
  }
}
// dossier racine des partitions dans le partage : réglé (config) ou plus long chemin commun à tous les .mscz
function scoresRoot() {
  if (SHARE.scores && share.folder(SHARE.scores)) return { folder: share.folder(SHARE.scores) }
  const top = (share.root.contents || []).find(c => c.isfolder && /^mscz$/i.test(c.name))
  if (top) return { folder: top }
  const all = share.files(share.root, c => /\.(mscz|mscx)$/i.test(c.name)).filter(f => !/(^|\/)files from /i.test(f.rel))
  if (!all.length) return { folder: share.root }
  let parts = all[0].rel.split('/').slice(0, -1)
  for (const f of all) { const p = f.rel.split('/').slice(0, -1); let i = 0; while (i < parts.length && parts[i] === p[i]) i++; parts = parts.slice(0, i) }
  let folder = share.root
  for (const n of parts) folder = (folder.contents || []).find(c => c.isfolder && c.name === n) || folder
  return { folder }
}
async function shareJson(meta) {
  try { return parseJ(await share.text(meta.fileid)) } catch (e) { nlog('pCloud, lecture impossible : ' + meta.name + ' — ' + e.message); return null }
}
async function sendToOwner(d) {
  while (d._sending) await d._sending          // un seul envoi à la fois
  const key = JSON.stringify(d.ink)
  if (key === d._body) return
  let done; d._sending = new Promise(r => done = r)
  try { await sendToOwnerNow(d, key) } finally { d._sending = null; done() }
}
async function sendToOwnerNow(d, key) {
  const owner = ownerName(), cfg = shareCfg(), who = cfg.guest
  if (!cfg.upload) { if (Object.keys(d.ink).length) showSave('saved', 'Gardé ici (pas de lien de dépôt pour ' + owner + ')'); return }
  showSave('saving', 'Envoi à ' + owner + '…')
  try {
    const fname = dropName(who, d._file)
    await uploadToLink(cfg.upload, who, fname, pretty({ app: 'Partoche', file: d._rel, author: who, profile: { emoji: (G.profile || {}).emoji || '🎼', color: (G.profile || {}).color || '#2f7de1' }, updated: d.updated || Date.now(), ink: d.ink }))
    d._body = key
    net.sent = Date.now(); paintNet()
    // vérification : on relit le fichier dans le dossier de l'élève et on compare
    showSave('saving', 'Vérification chez ' + owner + '…')
    const ok = await verifyDrop(fname, key)
    showSave('saved', ok ? 'Enregistré chez ' + owner : 'Envoyé à ' + owner)
    presPing({ ev: 'ink', d: presDocOf(d._file) })   // l'élève recharge tout de suite
  } catch (e) {
    markDirty(true); net.sent = false; paintNet()
    showSave('retry', 'Envoi impossible (' + e.message + ') — réessaie plus tard')
  }
}
async function teacherLibrary(pwdTry) {
  paintStudentBtn()
  if (!lsGet('mcsz:me', '')) {   // on demande le prénom de la prof une fois (affiché sur ses annotations chez l'élève)
    promptText('Bonjour ! Quel est ton prénom ?', SHARE.guest || '', t => {
      t = (t || '').trim(); if (!t) return teacherLibrary(pwdTry)
      lsSet('mcsz:me', t); G.myName = t; saveGlobal(); teacherLibrary(pwdTry)
    }, 'Ton prénom (il apparaîtra sur tes annotations)')
    return
  }
  const st = curStudent()
  if (!st) { files = []; renderLibrary(); openStudents(true); return }
  const pwd = pwdTry != null ? pwdTry : (st.pwd || '')
  busy('Connexion aux partitions de ' + st.name + '…')
  share = null
  try { await connectShare(pwd) } catch (e) {
    busy(false); files = []; renderLibrary()
    if (e.code === 2258 || e.code === 1125) return askPassword(pwd && e.code === 1125 ? 'Mot de passe incorrect.' : '')
    toast('pCloud : ' + e.message, 6000); return
  }
  if (st.pwd !== pwd) { const l = students(); const x = l.find(y => y.id === st.id); if (x) { x.pwd = pwd; saveStudents(l) } }
  loadStudentProfile(st)
  const sc = scoresRoot().folder
  folderName = st.name + ' · ' + sc.name
  files = share.files(sc, c => /\.(mscz|mscx)$/i.test(c.name))
    .map(({ meta, rel }) => ({ name: meta.name, rel, pc: meta.fileid, hash: meta.hash, size: meta.size, mtime: Date.parse(meta.modified) || 0 }))
  // partitions envoyées mais encore dans un dossier « Files from … » (l'appli de l'élève les rangera dans MSCZ) : on les montre déjà
  const have = new Set(files.map(f => f.rel))
  for (const { meta, rel } of share.files(share.root, c => /\.(mscz|mscx)$/i.test(c.name))) {
    if (!/(^|\/)files from /i.test(rel) || have.has(meta.name)) continue
    have.add(meta.name)
    files.push({ name: meta.name, rel: meta.name, pc: meta.fileid, hash: meta.hash, size: meta.size, mtime: Date.parse(meta.modified) || 0, enRoute: true })
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
  dataIndex.clear()
  for (const f of files) {
    const fn = docFile(f), o = ownerDocs.get(fn), g = guestDocs.get(fn)
    const t = Math.max(o ? Date.parse(o.modified) : 0, g ? Date.parse(g.meta.modified) : 0)
    if (t) dataIndex.set(fn, t)
  }
  busy(false); renderLibrary()
}
// emoji et couleur choisis par l'élève (dans son !Settings.json)
async function loadStudentProfile(st) {
  try {
    const f = share.files(share.root, c => c.name === '!Settings.json')[0]; if (!f) return
    const d = parseJ(await share.text(f.meta.fileid)); if (!d || !d.global) return
    if (curStudent() && curStudent().id === st.id) {
      const nt = d.global.tags || {}, nl = { labels: d.global.labels || {}, defs: d.global.labelDefs || null }
      if (JSON.stringify(nt) !== JSON.stringify(peerTags) || JSON.stringify(nl) !== JSON.stringify(peerLabels)) { peerTags = nt; peerLabels = nl; if ($('#library').classList.contains('active')) renderLibrary() }
    }
    const pr = d.global.profile
    if (!pr) return
    const l = students(), x = l.find(y => y.id === st.id); if (!x) return
    if (x.emoji === pr.emoji && x.color === pr.color) return
    x.emoji = pr.emoji; x.color = pr.color; saveStudents(l); paintStudentBtn()
  } catch { }
}
function askPassword(err) {
  $('#loginTitle').textContent = 'Partitions de ' + ownerName()
  $('#loginMsg').textContent = 'Entre le mot de passe du dossier partagé (il sera retenu sur cet ordinateur).'
  $('#loginErr').hidden = !err; $('#loginErr').textContent = err || ''
  $('#loginDlg').hidden = false; $('#loginPwd').value = ''
  setTimeout(() => $('#loginPwd').focus(), 50)
  const go = () => { const v = $('#loginPwd').value; if (!v) return; $('#loginDlg').hidden = true; teacherLibrary(v) }
  $('#loginGo').onclick = go
  $('#loginPwd').onkeydown = e => { if (e.key === 'Enter') go() }
}
const parseLinkCode = l => { const m = String(l || '').match(/code=([A-Za-z0-9]+)/); return m ? m[1] : '' }
// ---- prof : choix / gestion des élèves ----
function paintStudentBtn() {
  const st = curStudent()
  $('#btnStudent').hidden = !TEACHER
  $('#studentLbl').textContent = st ? (st.emoji ? st.emoji + ' ' : '') + st.name : 'Ajouter un élève'
  $('#btnStudent .udot').style.background = (st && st.color) || ''
  const b = document.querySelector('#library .bname > span')
  if (b && TEACHER) b.textContent = st ? 'Partitions de ' + st.name : 'Partoche — Prof'
}
let stEdit = null
function openStudents(addFirst) {
  $('#stMe').value = lsGet('mcsz:me', '') || ''
  paintMe(); renderStudents()
  if (addFirst || !students().length) fillStudentForm(null, true); else $('#stForm').hidden = true
  $('#studentsDlg').hidden = false
  if (!$('#stMe').value) setTimeout(() => $('#stMe').focus(), 50)
  refreshStudentCards()
}
const hexA2 = (h, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return ''; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }
function renderStudents() {
  const box = $('#stList'); box.innerHTML = ''
  const cur = curStudent()
  for (const st of students()) {
    const d = document.createElement('div'); d.className = 'stcard' + (cur && cur.id === st.id ? ' on' : '')
    const col = st.color || '#7a7f8c'
    d.style.setProperty('--sc', col); d.style.setProperty('--scbg', hexA2(col, .22)); d.style.setProperty('--scbg2', hexA2(col, .06))
    d.innerHTML = '<div class="stemo"></div><b></b><span class="stsub"></span><span class="stpres" hidden>● en ligne</span>'
      + '<div class="stact"><button title="Modifier">✎</button><button title="Retirer">🗑</button></div>'
    d.querySelector('.stemo').textContent = st.emoji || (st.name || '?').trim().charAt(0).toUpperCase()
    d.querySelector('b').textContent = st.name
    d.querySelector('.stsub').textContent = (cur && cur.id === st.id ? 'ouvert · ' : '') + (st.upload ? 'lecture + envoi' : 'lecture seule')
    const p = presOf.get(st.id)
    if (p) { const e = d.querySelector('.stpres'); e.hidden = false; e.textContent = '● est en ligne' }
    const [be, bd] = d.querySelectorAll('.stact button')
    d.onclick = e => { if (e.target.closest('.stact')) return; lsSet('mcsz:student', st.id); $('#studentsDlg').hidden = true; share = null; presAfterSwitch(); teacherLibrary() }
    be.onclick = () => fillStudentForm(st, true)
    bd.onclick = () => { if (!confirm('Retirer ' + st.name + ' de ta liste ?')) return; saveStudents(students().filter(x => x.id !== st.id)); renderStudents(); paintStudentBtn() }
    box.appendChild(d)
  }
  const add = document.createElement('button'); add.className = 'stcard add'
  add.innerHTML = '<div class="stemo">＋</div><b>Ajouter un élève</b><span class="stsub">avec les liens qu’il t’a envoyés</span>'
  add.onclick = () => fillStudentForm(null, true)
  box.appendChild(add)
}
// emoji / couleur choisis par chaque élève (lus dans son !Settings.json) + présence
const presOf = new Map()
async function refreshStudentCards() {
  for (const st of students()) {
    if (st.link && st.pwd) (async () => {
      try {
        const pf = new PublicFolder(st.link, st.pwd); await pf.list()
        const f = pf.files(pf.root, c => c.name.toLowerCase() === '!settings.json')[0]; if (!f) return
        const d = parseJ(await pf.text(f.meta.fileid)); const pr = d && d.global && d.global.profile; if (!pr) return
        const l = students(), x = l.find(y => y.id === st.id); if (!x || (x.emoji === pr.emoji && x.color === pr.color)) return
        x.emoji = pr.emoji; x.color = pr.color; saveStudents(l); paintStudentBtn()
        if (!$('#studentsDlg').hidden) renderStudents()
      } catch { }
    })()
    if (st.link) (async () => {
      const o = await presPollTopic(presTopicFor(st.link))
      if (o) { presOf.set(st.id, o); adoptStudentLook(st, o) } else presOf.delete(st.id)
      if (!$('#studentsDlg').hidden) renderStudents()
    })()
  }
}
function fillStudentForm(st, show) {
  stEdit = st
  $('#stForm').hidden = !show
  $('#stFormTitle').textContent = st ? 'Modifier ' + st.name : 'Ajouter un élève'
  $('#stSave').textContent = st ? 'Enregistrer' : 'Ajouter'
  $('#stName').value = st ? st.name : ''; $('#stLink').value = st ? st.link : ''
  $('#stPwd').value = st ? st.pwd || '' : ''; $('#stUpload').value = st ? st.upload || '' : ''
  if (show) setTimeout(() => { $('#stForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); if (!st) $('#stName').focus() }, 30)
}
// ma carte (prof) : prénom, emoji, couleur
function paintMe() {
  const pr = G.profile || {}
  const col = /^#[0-9a-f]{6}$/i.test(pr.color || '') ? pr.color : '#2f7de1'
  $('#meEmo').textContent = pr.emoji || '🎼'
  $('#meCard').style.setProperty('--sc', col); $('#meCard').style.setProperty('--scbg', hexA2(col, .22))
  if (document.activeElement !== $('#meEmoIn')) $('#meEmoIn').value = pr.emoji || ''
  $('#meColIn').value = col
}
$('#meEmoIn').addEventListener('input', debounce(() => { const v = $('#meEmoIn').value.trim(); if (v) setProfile({ emoji: v }) }, 500))
$('#meColIn').addEventListener('input', debounce(e => setProfile({ color: e.target.value }), 250))
const toggleEmoGrid = g => {
  if (!g.hidden) { g.hidden = true; return }
  if (!g.childElementCount) for (const em of emojiList()) { const b = document.createElement('button'); b.textContent = em; b.onclick = () => { setProfile({ emoji: em }); g.hidden = true }; g.appendChild(b) }
  g.hidden = false
}
$('#meEmoAll').onclick = () => toggleEmoGrid($('#meEmoGrid'))
$('#meEmo').onclick = () => toggleEmoGrid($('#meEmoGrid'))
$('#stMe').addEventListener('change', e => { lsSet('mcsz:me', e.target.value.trim()); G.myName = e.target.value.trim(); saveGlobal(); presSend(true) })
$('#stCancelEdit').onclick = () => fillStudentForm(null, false)
$('#stSave').onclick = async () => {
  const name = $('#stName').value.trim(), link = $('#stLink').value.trim()
  if (!$('#stMe').value.trim()) { toast('Indique d’abord ton prénom (en haut)'); $('#stMe').focus(); return }
  lsSet('mcsz:me', $('#stMe').value.trim())
  if (!name || !link) { toast('Il faut au moins le prénom et le lien de partage'); return }
  const upload = $('#stUpload').value.trim()
  if (upload) {
    if (parseLinkCode(upload) && parseLinkCode(upload) === parseLinkCode(link)) { toast('Le lien de dépôt est le même que le lien de partage : il faut le lien « Demander des fichiers » du dossier Prof', 6000); return }
    $('#stSave').disabled = true; $('#stSave').textContent = 'Vérification…'
    const ck = await checkUploadLink(upload)
    $('#stSave').disabled = false; $('#stSave').textContent = stEdit ? 'Enregistrer' : 'Ajouter'
    if (!ck.ok) { toast('Lien de dépôt : ' + ck.error + '. Demande à ton élève le lien créé avec « Demander des fichiers » sur son dossier Prof.', 7000); return }
    toast('✓ Lien de dépôt vérifié' + (ck.folder ? ' (dossier « ' + ck.folder + ' »)' : ''), 3000)
  }
  const l = students()
  const o = { ...(stEdit || {}), id: stEdit ? stEdit.id : 's' + Date.now(), name, link, pwd: $('#stPwd').value, upload }
  if (stEdit) l[l.findIndex(x => x.id === stEdit.id)] = o; else l.push(o)
  saveStudents(l); lsSet('mcsz:student', o.id)
  $('#studentsDlg').hidden = true; share = null; presAfterSwitch(); teacherLibrary()
}
$('#stClose').onclick = () => { $('#studentsDlg').hidden = true; paintStudentBtn() }
$('#btnStudent').onclick = () => openStudents(false)

// suivi des envois du prof (appli de l'élève) : vu / pas vu + notification Android
const guestSeen = () => lsGet('mcsz:guestSeen', {})
function setGuestSeen(doc, stamp) {
  const m = guestSeen(); if ((m[doc] || '') >= stamp) return
  m[doc] = stamp; lsSet('mcsz:guestSeen', m)
  try { native && native.setGuestSeen && native.setGuestSeen(JSON.stringify(m)) } catch { }
}
function syncShareToNative() {
  if (TEACHER || !native || !native.setShare) return
  const c = shareCfg()
  try { native.setShare(c.link && c.pwd ? JSON.stringify({ link: c.link, pwd: c.pwd, guest: c.guest, seen: guestSeen() }) : '') } catch { }
}
async function refreshGuest(force) {
  if (TEACHER) return
  const c = shareCfg(); if (!c.link || !c.pwd) return
  if (!force && share && Date.now() - share.t < 60000) return
  try { await connectShare(); renderLibrary() } catch (e) { nlog('partage : ' + e.message) }
}
// appli de l'élève : calque des annotations du prof
async function loadGuestLayer(force) {
  if (TEACHER || !V) return
  const c = shareCfg(); if (!c.link || !c.pwd) return
  const myV = V
  try {
    if (force || !share || Date.now() - share.t > 60000) await connectShare()
    net.ok = true; net.at = Date.now(); paintNet()
    const g = guestDocs.get(myV.doc._file); if (!g) return
    if (myV.doc._underStamp === g.stamp) return          // rien de nouveau
    const fresh = !!myV.doc._underStamp
    const gd = await shareJson(g.meta); if (!gd || !gd.ink || V !== myV) return
    V.doc._underStamp = g.stamp
    if (fresh) toast('✍️ Nouvelles annotations de ' + (g.who || 'ton prof'), 3500)
    const gp = gd.profile || {}
    V.doc._under = gd.ink; V.doc._underWho = (gp.emoji ? gp.emoji + ' ' : '') + (g.who || gd.author || 'Prof')
    if (/^#[0-9a-f]{6}$/i.test(gp.color || '')) V.doc._underColor = gp.color
    ink.underWho = V.doc._underWho; ink.underColor = V.doc._underColor || '#9b3fc0'
    setGuestSeen(myV.doc._file, g.stamp)
    if (V.key) ink.setUnder(toView(gd.ink[V.key] || null), V.doc._underWho)
    paintUnder()
  } catch (e) { net.ok = false; paintNet(); nlog('annotations du prof : ' + e.message) }
}
// ---- état de la connexion / de la synchro (pastille dans l'en-tête) ----
const net = { ok: null, at: 0, sent: null }
function paintNet() {
  const el = $('#netState'); if (!el) return
  const online = navigator.onLine !== false
  let cls, txt
  if (!online) { cls = 'off'; txt = 'Hors ligne' }
  else if (TEACHER) {
    const st = curStudent()
    if (st && !st.upload) { cls = 'warn'; txt = 'Pas de lien de dépôt' }
    else if (net.sent === false) { cls = 'warn'; txt = 'Envoi en attente' }
    else { cls = 'on'; txt = net.sent ? 'Envoyé ' + ago(net.sent) : 'En ligne' }
  } else {
    const c = shareCfg()
    if (!c.link) { cls = 'mute'; txt = native && (nativeInfo() || {}).storage === 'pcloud' ? 'pCloud' : 'Local' }
    else if (net.ok === false) { cls = 'warn'; txt = 'pCloud injoignable' }
    else { cls = 'on'; txt = net.at ? 'Vérifié ' + ago(net.at) : 'En ligne' }
  }
  const po = online && presOther()
  if (po) { cls = 'on live'; txt = po.label + ' est en ligne' + (po.same ? ' · sur cette partition' : '') }
  el.className = 'netstate ' + cls; el.querySelector('span').textContent = txt
  el.title = TEACHER ? 'Tes annotations partent chez l’élève en repassant en mode Main' : 'Les annotations de ton prof sont vérifiées toutes les 20 s'
}
// ---- présence : « X est en ligne » ----
// Petit relais public ntfy.sh : chaque côté y signale sa présence toutes les ~75 s sur un sujet
// tiré (par hachage) du code du lien de partage ; rien d'autre n'y passe (prénom, emoji, couleur, partition hachée).
const PRES = 'https://ntfy.sh/'
const pres = { other: null, sentAt: 0, last: '', was: false }

function h32(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
function presTopicFor(link) { const p = parseLink(link); return p ? 'partoche-' + h32('pt:' + p.code, 2166136261) + h32(p.code + ':pt', 33554467) : '' }
const presTopic = () => presTopicFor(shareCfg().link)
const presDoc = () => (V && V.doc && $('#viewer').classList.contains('active')) ? h32(V.doc._file || '', 7) : ''
async function presPollTopic(topic) {
  if (!topic || navigator.onLine === false) return null
  try {
    const t = await (await fetch(PRES + topic + '/json?poll=1&since=200s', { cache: 'no-store' })).text()
    let last = null
    for (const line of t.split('\n')) {
      try { const m = JSON.parse(line); if (m.event !== 'message') continue; const o = JSON.parse(m.message); if (o.r === (TEACHER ? 'e' : 'p')) { o.t = m.time * 1000; if (!last || o.t >= last.t) last = o } } catch { }
    }
    return last && !last.off && Date.now() - last.t < 200000 ? last : null
  } catch { return null }
}
async function presSend(force) {
  if (DEMO || navigator.onLine === false) return
  const topic = presTopic(); if (!topic) return
  const pr = G.profile || {}
  // page ouverte = en ligne, même si l'onglet est en arrière-plan (sur la tablette, l'appli en arrière-plan se tait d'elle-même)
  const body = JSON.stringify({ r: TEACHER ? 'p' : 'e', n: TEACHER ? myName() : '', e: pr.emoji || '', c: pr.color || '', d: presDoc() })
  if (!force && body === pres.last && Date.now() - pres.sentAt < 75000) return
  pres.last = body; pres.sentAt = Date.now()
  try { await fetch(PRES + topic, { method: 'POST', body, keepalive: true }) } catch { }
}
function presOther() {
  const o = pres.other; if (!o) return null
  let label
  if (TEACHER) { const st = curStudent() || {}; label = (o.e || st.emoji ? (o.e || st.emoji) + ' ' : '') + (st.name || 'Ton élève') }
  else label = (o.e ? o.e + ' ' : '') + (o.n || 'Ton prof')
  return { label, color: o.c || '', same: !!(o.d && o.d === presDoc()) }
}
function paintPresence() {
  const el = $('#presLib'); if (!el) return
  const po = presOther()
  el.hidden = !po
  if (po) { el.querySelector('span').textContent = po.label + ' est en ligne'; el.style.setProperty('--pc', po.color || '#3ecf6e') }
}
async function presTick(force) {
  presSend(force)
  if (document.hidden) return
  pres.other = await presPollTopic(presTopic())
  if (TEACHER && pres.other && (pres.other.e || pres.other.c)) adoptStudentLook(curStudent(), pres.other)
  if (pres.other && !pres.was) { const po = presOther(); if (po) toast(po.label + ' est en ligne' + (po.same ? ', sur cette partition' : ''), 3500) }
  pres.was = !!pres.other
  paintNet(); paintPresence()
}
// emoji / couleur annoncés par l'élève (présence) -> vignette
function adoptStudentLook(st, o) {
  if (!st) return
  const l = students(), x = l.find(y => y.id === st.id); if (!x) return
  const e = o.e || x.emoji, c = /^#[0-9a-f]{6}$/i.test(o.c || '') ? o.c : x.color
  if (x.emoji === e && x.color === c) return
  x.emoji = e; x.color = c; saveStudents(l); paintStudentBtn()
  if (!$('#studentsDlg').hidden) renderStudents()
}
function presAfterSwitch() { peerTags = {};  pres.other = null; pres.was = false; pres.last = ''; paintPresence(); setTimeout(() => presTick(true), 300) }
setInterval(() => presTick(), 20000)
document.addEventListener('visibilitychange', () => presTick(true))
addEventListener('pagehide', () => { const t = presTopic(); if (t) try { navigator.sendBeacon(PRES + t, JSON.stringify({ r: TEACHER ? 'p' : 'e', off: 1 })) } catch { } })
setTimeout(() => presTick(true), 1500)

const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'à l’instant' : s < 3600 ? 'il y a ' + Math.round(s / 60) + ' min' : 'il y a ' + Math.round(s / 3600) + ' h' }
addEventListener('online', paintNet); addEventListener('offline', paintNet)
setInterval(() => {
  paintNet()
  if (!TEACHER && V && $('#viewer').classList.contains('active') && !document.hidden) loadGuestLayer(true)
}, 20000)
function paintUnder() {
  const U = V && V.doc && V.doc._under
  const has = !!(U && Object.keys(U).length)
  $('#btnUnder').hidden = !has
  if (!has) return
  const on = G.showUnder !== false
  $('#btnUnder').classList.toggle('off', !on)
  const here = !!(U[V.key] && U[V.key].some(p => p && p.length))
  const live = !!(pres.other && pres.other.d && V.doc._file && pres.other.d === presDocOf(V.doc._file))
  $('#underLbl').textContent = V.doc._underWho + (here ? '' : ' (autre vue)') + (live ? ' · en direct' : V.doc._underStamp ? ' · ' + stampAgo(V.doc._underStamp) : '')
  $('#btnUnder .udot').style.background = V.doc._underColor || ''
  $('#btnUnder').title = here ? 'Annotations de ' + V.doc._underWho + ' : afficher / masquer'
    : V.doc._underWho + ' a annoté cette partition avec un autre choix de pistes ou de noms de notes'
  ink.setUnderVisible(on)
}
// clé de vue « 0110-solfege-0-1-1 » -> { visible, notes }
function parseViewKey(k) {
  const m = /^([01]+)-(off|letter|solfege)-([01])-([01])-([01])$/.exec(k || ''); if (!m) return null
  return { visible: m[1].split('').map(c => c === '1'), notes: { names: m[2], octave: m[3] === '1', above: m[4] === '1', hideManual: m[2] === 'off' ? true : m[5] === '1' } }
}
const inkCount = a => (a || []).reduce((n, p) => n + ((p && p.length) || 0), 0)
function bestKey(ink) { let best = null, n = 0; for (const k in ink || {}) { const c = inkCount(ink[k]); if (c > n) { n = c; best = k } } return best }
async function switchToView(k) {
  const v = parseViewKey(k); if (!v || !V || v.visible.length !== V.visible.length) return false
  V.visible = v.visible; V.notes = Object.assign({}, V.notes, v.notes)
  saveFilePrefs(); buildTrackList(); updateNamesUI(); await renderVariant(); return true
}
$('#btnUnder').onclick = async () => {
  const U = V.doc._under
  const here = inkCount(U[V.key]) > 0
  if (!here) {   // l'autre a annoté avec une autre vue : on propose d'y passer
    const k = bestKey(U)
    if (k && confirm(V.doc._underWho + ' a annoté avec d’autres pistes / noms de notes. Passer à sa vue ?')) { G.showUnder = true; saveGlobal(); await switchToView(k); return }
  }
  G.showUnder = G.showUnder === false; saveGlobal(); paintUnder()
}
if (TEACHER) document.addEventListener('visibilitychange', () => { if (document.hidden && V && V.doc) commitDoc() })

// ---- démo ----
const DEMO_FILES = [['Ode à la joie.mscz', 'ode-a-la-joie.mscz', 21164], ['Frère Jacques (canon).mscz', 'frere-jacques.mscz', 25009], ['Au clair de la lune.mscz', 'au-clair-de-la-lune.mscz', 18888]]
let demoJ = null
async function demoData() { if (!demoJ) try { demoJ = await (await fetch('demo/demo.json')).json() } catch { demoJ = {} } return demoJ }
function demoLibrary() {
  $('#demoBar').hidden = false
  ;['#btnFolder', '#btnFiles', '#btnRefresh', '#btnStudent'].forEach(id => { $(id).hidden = true })
  folderName = 'Démo'
  files = DEMO_FILES.map(([name, file, size], i) => ({ name, rel: 'demo/' + name, url: 'demo/' + file, size, mtime: Date.UTC(2026, 8, 1 + i), demo: true }))
  dataIndex.clear(); files.forEach((f, i) => dataIndex.set(docFile(f), Date.now() - i * 86400000))
  $('#q').addEventListener('input', debounce(renderLibrary, 150))
  renderLibrary()
}
function setDemo(on) { lsSet('mcsz:demo', !!on); location.reload() }
$('#demoQuit').onclick = () => setDemo(false)
// ---- visite guidée ----
const TOUR_LIB = () => [
  { sel: '#demoBar', title: 'Mode démo', text: 'Des partitions d’exemple avec des annotations fictives, pour tout essayer sans rien casser.' },
  { sel: '#btnStudent', title: 'Tes élèves', text: 'Choisis l’élève dont tu veux voir les partitions, ou ajoute-en un avec les liens qu’il t’a donnés.' },
  { sel: '.lrow:not(.lhead) .pv', title: 'Écouter un extrait', text: '▶ joue 30 secondes, calées sur le refrain quand on le trouve.' },
  { sel: '.lrow:not(.lhead)', title: 'Ouvrir une partition', text: 'Touche une ligne pour l’ouvrir.<br><b>Appui long</b> : renommer, supprimer ou mettre un tag.' },
  { sel: '#tagSeg', title: 'Tags', text: 'Range tes morceaux : <b>À faire</b>, <b>En cours</b>, <b>Maîtrisé</b>, et filtre la liste.' },
  { sel: '#btnAgenda', title: 'Cours', text: 'Propose un horaire de cours, accepte ou déplace : un cours est confirmé quand vous l’avez accepté tous les deux.' },
  { sel: '#btnPres', title: 'Présences', text: 'Qui est en ligne, et le temps passé par chaque élève sur ses partitions cette semaine.' },
  { sel: '#btnTunerLib', title: 'Accordeur', text: 'Violon, alto, violoncelle, guitares, basses, ukulélé… avec tes instruments favoris.' },
  { sel: '#brandBtn', title: 'Options', text: 'Touche le logo : dossiers, partage avec ton prof, langue… et ce tuto, si tu veux le revoir.' },
]
const TOUR_VIEW = () => [
  { sel: '#btnTracks', title: 'Pistes', text: 'Affiche ou masque chaque instrument, et règle le son : muet, solo, volume.' },
  { sel: '#btnNames', title: 'Noms des notes', text: 'Écris le nom des notes sous la portée : <b>A B C</b> ou <b>Do Ré Mi</b>.' },
  { sel: '#modeSeg', title: 'Main / Stylo', text: '<b>Main</b> : défiler, toucher une mesure pour y aller.<br><b>Stylo</b> : annoter (stylo, surligneur, texte, emoji). C’est enregistré en repassant en Main.' },
  { sel: '#btnUnder', title: 'Annotations de l’autre', text: 'Elles gardent leurs couleurs, avec une petite bulle à son nom. Ce bouton les affiche ou les masque.' },
  { sel: '#btnLayout', title: 'Mise en page', text: 'Vertical, côte à côte ou horizontal.' },
  { sel: '#btnLoop', title: 'Boucle', text: 'Touche ⟲, puis la mesure de début, puis celle de fin, puis <b>▶ Boucler</b>.' },
  { sel: '#btnSpeed', title: 'Vitesse', text: 'De 25 à 150 %, sans changer la hauteur des notes.' },
  { sel: '#btnTuner', title: 'Accordeur', text: 'Toujours à portée de main, même pendant un morceau.' },
]
function startTour(which) {
  if (which === 'viewer') return runTour(TOUR_VIEW(), () => lsSet('mcsz:tutoViewer', true))
  lsSet('mcsz:tutoPending', false)
  runTour(TOUR_LIB())
}
$('#setTuto').onclick = () => { $('#settings').hidden = true; lsSet('mcsz:tutoViewer', false); if ($('#viewer').classList.contains('active')) startTour('viewer'); else startTour('lib') }
// ---- accueil (premier lancement) ----
function openOnboard() {
  let role = ROLE || ''
  const paint = () => {
    $$('#onboard [data-role]').forEach(b => b.classList.toggle('on', b.dataset.role === role))
    $('#obGo').disabled = $('#obDemo').disabled = !role
  }
  $$('#onboard [data-role]').forEach(b => b.onclick = () => { role = b.dataset.role; paint() })
  const go = demo => { lsSet('mcsz:role', role); lsSet('mcsz:onboarded', true); lsSet('mcsz:demo', demo); lsSet('mcsz:tutoPending', true); location.reload() }
  $('#obGo').onclick = () => go(false)
  $('#obDemo').onclick = () => go(true)
  paint(); $('#onboard').hidden = false
}

function setupLibrary() {
  if (DEMO) { demoLibrary(); return }
  if (TEACHER) {
    $('#btnFolder').hidden = true; $('#btnFiles').hidden = true
    $('#btnRefresh').onclick = () => teacherLibrary()
    $('#q').addEventListener('input', debounce(renderLibrary, 150))
    teacherLibrary()
    return
  }
  if (native) {
    $('#btnFolder').hidden = false
    $('#btnFiles').hidden = true
    $('#btnFolder').onclick = () => native.pickFolder()
    $('#btnRefresh').onclick = () => { busy('Actualisation du dossier pCloud…'); native.requestFiles() }
    bridge.onTidy = () => { try { native.requestFiles() } catch { } }
    // range les dossiers « Files from … » dès qu'ils apparaissent (pas seulement au démarrage)
    if (native.tidyNow) { setInterval(() => { if (!document.hidden) native.tidyNow() }, 90000); document.addEventListener('visibilitychange', () => { if (!document.hidden) native.tidyNow() }) }
    bridge.onFiles = json => {
      busy(false)
      try {
        const d = typeof json === 'string' ? JSON.parse(json) : json
        folderName = d.folder || ''
        files = (d.files || []).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
        files.forEach(f => { f.tree = true })
        dataIndex.clear(); (d.data || []).forEach(x => dataIndex.set(x.name, x.mtime))
        canWriteFolder = !!d.writable
        if (d.error) toast(d.error, 5000)
        if (d.fromProf && d.fromProf.length) {
          G.tags = G.tags || {}
          const got = lsGet('mcsz:fromProf', [])
          for (const x of d.fromProf) { if (!G.tags[x.name]) G.tags[x.name] = 'new'; got.push({ ...x, t: Date.now() }) }
          lsSet('mcsz:fromProf', got.slice(-30)); saveGlobal(); writeSettings()
          setTimeout(() => showNewScores(d.fromProf), 300)
        }
      } catch { files = [] }
      renderLibrary()
      refreshGuest(true)
      if (!$('#settings').hidden) paintSettings()
      if (!files.length && folderName && !bridge._retried) { bridge._retried = true; setTimeout(() => native.requestFiles(), 2500) }
    }
    bridge.onOpen = json => {
      const d = typeof json === 'string' ? JSON.parse(json) : json
      if (d && d.url) openScore(d)
    }
    busy('Chargement du dossier des partitions…')
    native.requestFiles()
    const pend = native.takePendingOpen && native.takePendingOpen()
    if (pend) { try { bridge.onOpen(pend) } catch { } }
  } else {
    $('#btnFiles').hidden = false
    $('#fileInput').onchange = e => {
      const list = Array.from(e.target.files).map(f => ({ name: f.name, rel: f.name, file: f, size: f.size, mtime: f.lastModified }))
      const seen = new Set(files.map(f => f.name + f.size))
      files = files.concat(list.filter(f => !seen.has(f.name + f.size))).sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      renderLibrary()
      if (list.length === 1) openScore(list[0])
    }
    if (window.showDirectoryPicker) {
      $('#btnFolder').onclick = async () => {
        try {
          const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
          libDir = dir
          folderName = dir.name
          const out = []
          const walk = async (d, prefix, depth) => {
            for await (const [name, h] of d.entries()) {
              if (h.kind === 'file' && /\.(mscz|mscx)$/i.test(name)) { const f = await h.getFile(); out.push({ name, rel: prefix + name, handle: h, size: f.size, mtime: f.lastModified }) }
              else if (h.kind === 'directory' && depth < 3 && !name.startsWith('_MSCZ') && name !== 'MSCZ Player - annotations') await walk(h, prefix + name + '/', depth + 1)
            }
          }
          busy('Lecture du dossier…'); await walk(dir, '', 0); busy(false)
          files = out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
          renderLibrary()
        } catch (e) { busy(false) }
      }
      $('#btnRefresh').hidden = true
    } else { $('#btnFolder').hidden = true; $('#btnRefresh').hidden = true }
    // glisser-déposer
    document.addEventListener('dragover', e => e.preventDefault())
    document.addEventListener('drop', e => {
      e.preventDefault()
      const list = Array.from(e.dataTransfer.files).filter(f => /\.(mscz|mscx)$/i.test(f.name)).map(f => ({ name: f.name, rel: f.name, file: f, size: f.size, mtime: f.lastModified }))
      if (!list.length) return
      files = files.concat(list); renderLibrary()
      if (list.length === 1) openScore(list[0])
    })
    renderLibrary()
  }
  $('#q').addEventListener('input', debounce(renderLibrary, 150))
}

const thumbObserver = new IntersectionObserver(ents => {
  for (const e of ents) if (e.isIntersecting) { thumbObserver.unobserve(e.target); queueThumb(e.target) }
}, { root: $('#libBody'), rootMargin: '300px' })
const thumbQ = []; let thumbBusy = 0
function queueThumb(el) { thumbQ.push(el); pumpThumbs() }
async function pumpThumbs() {
  while (thumbBusy < 3 && thumbQ.length) {
    const el = thumbQ.shift(); thumbBusy++
    loadThumb(el).finally(() => { thumbBusy--; pumpThumbs() })
  }
}
const thumbUrls = new Map()
async function loadThumb(el) {
  const entry = el._entry
  const key = 'thumb:' + entry.name + ':' + entry.size + ':' + entry.mtime
  let url = thumbUrls.get(key)
  if (!url) {
    let blob = await idbGet(key)
    if (blob === undefined) {
      try { blob = readThumbnail(await getBytes(entry)) } catch { blob = null }
      idbSet(key, blob)
    }
    if (blob) { url = URL.createObjectURL(blob); thumbUrls.set(key, url) }
  }
  const th = el.querySelector('.thumb')
  if (url) { th.style.backgroundImage = `url("${url}")`; th.classList.remove('none'); th.innerHTML = '' }
}

function card(entry, small) {
  const c = document.createElement('div')
  c.className = 'card'
  c.innerHTML = `<div class="thumb none"><svg class="ic big"><use href="#i-note"/></svg></div><button class="pv" title="Écouter un extrait (30 s)"><svg class="ic"><use href="#i-play"/></svg></button><div class="name"></div>` + (small ? '' : '<div class="sub"></div>')
  c.querySelector('.name').textContent = baseName(entry.name)
  const sub = c.querySelector('.sub')
  if (sub) { const dir = (entry.demo ? 'Démo' : folderOf(entry)); sub.textContent = dir; if (!dir) sub.remove() }
  c._entry = entry
  bindPress(c, entry)
  thumbObserver.observe(c)
  return c
}

// toucher = ouvrir ; appui long = menu (renommer / supprimer)
function bindPress(el, entry) {
  const pv = el.querySelector('.pv')
  if (pv) {
    pv._entry = entry
    if (preview && preview.entry === entry) paintPv(pv, preview.state)
    pv.addEventListener('pointerdown', e => e.stopPropagation())
    pv.addEventListener('click', e => { e.stopPropagation(); togglePreview(entry, pv) })
  }
  let t = 0, sx = 0, sy = 0, long = false
  el.addEventListener('pointerdown', e => {
    long = false; sx = e.clientX; sy = e.clientY
    clearTimeout(t); t = setTimeout(() => { long = true; if (navigator.vibrate) try { navigator.vibrate(20) } catch { } scoreMenu(entry) }, 550)
  })
  el.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(t) })
  el.addEventListener('pointerup', () => clearTimeout(t))
  el.addEventListener('pointercancel', () => clearTimeout(t))
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (!long) { long = true; scoreMenu(entry) } })
  el.addEventListener('click', e => { if (long) { e.preventDefault(); long = false; return } openScore(entry) })
}
function promptText(title, init, cb, placeholder) {
  const dlg = $('#textDlg'), ta = $('#textIn')
  dlg.querySelector('h3').textContent = title
  ta.placeholder = placeholder || ''
  ta.rows = title === 'Texte' ? 3 : 1
  ta.value = init || ''
  dlg.hidden = false
  setTimeout(() => { ta.focus(); ta.select() }, 50)
  const done = v => { dlg.hidden = true; $('#textOk').onclick = $('#textCancel').onclick = null; ta.blur(); cb(v) }
  $('#textOk').onclick = () => done(ta.value)
  $('#textCancel').onclick = () => done(null)
}
function scoreMenu(entry) {
  const dlg = $('#scoreMenu')
  $('#smTitle').textContent = baseName(entry.name)
  $('#smSub').textContent = [(entry.demo ? 'Démo' : folderOf(entry)), fmtSize(entry.size), fmtDate(entry.mtime)].filter(Boolean).join(' · ')
  $('#smDelAnnot').checked = false
  $('#smDelConfirm').hidden = true
  dlg.hidden = false
  const close = () => { dlg.hidden = true }
  $$('#smTags button').forEach(b => {
    b.classList.toggle('on', (b.dataset.t || '') === tagOf(entry))
    b.onclick = () => { setTag(entry, b.dataset.t); $$('#smTags button').forEach(x => x.classList.toggle('on', (x.dataset.t || '') === tagOf(entry))); renderLibrary() }
  })
  // étiquettes (plusieurs)
  const lb = $('#smLabels'); lb.innerHTML = ''
  $('#smLabelsRow').hidden = TEACHER && !labelsOf(entry).length
  const cur = new Set(labelsOf(entry))
  for (const d of labelDefs()) {
    if (TEACHER && !cur.has(d.id)) continue
    const b = document.createElement('button'); b.className = 'lblpick' + (cur.has(d.id) ? ' on' : '')
    b.style.setProperty('--lc', d.c); b.textContent = d.e + ' ' + d.n
    b.onclick = () => { if (TEACHER) return; cur.has(d.id) ? cur.delete(d.id) : cur.add(d.id); b.classList.toggle('on'); setLabels(entry, [...cur]); renderLibrary() }
    lb.appendChild(b)
  }
  if (!TEACHER) { const m = document.createElement('button'); m.className = 'lblpick add'; m.textContent = '✏️ Mes tags…'; m.onclick = () => { close(); openLabelEditor(() => scoreMenu(entry)) }; lb.appendChild(m) }
  $('#smAsk').hidden = TEACHER || !!entry.demo
  $('#smAsk').onclick = () => { close(); askTeacher(entry) }
  $('#smOpen').onclick = () => { close(); openScore(entry) }
  $('#smCancel').onclick = close
  dlg.onclick = e => { if (e.target === dlg) close() }
  $('#smRename').onclick = () => {
    close()
    promptText('Renommer la partition', baseName(entry.name), v => {
      if (v == null) return
      v = v.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!v || v === baseName(entry.name)) return
      renameScore(entry, v + (entry.name.match(/\.(mscz|mscx)$/i) || ['.mscz'])[0])
    }, 'Nouveau nom')
  }
  $('#smDelete').onclick = () => { $('#smDelConfirm').hidden = false }
  $('#smDelYes').onclick = () => { close(); deleteScore(entry, $('#smDelAnnot').checked) }
}
async function renameScore(entry, newName) {
  if (!native || !native.renameDoc || !entry.url) { toast('Renommage disponible dans l’appli Android'); return }
  const oldRel = entry.rel || entry.name, oldData = docFile(entry)
  const newUrl = native.renameDoc(entry.url, newName)
  if (!newUrl) { toast('Impossible de renommer ce fichier'); return }
  const dir = oldRel.includes('/') ? oldRel.slice(0, oldRel.lastIndexOf('/') + 1) : ''
  const newEntry = { ...entry, name: newName, rel: dir + newName, url: newUrl }
  // annotations : fichier de sauvegarde + copie locale + historique
  let renamed = false
  try { renamed = !!(native.renameData && native.renameData(oldData, docFile(newEntry))) } catch { }
  const d = await idbGet('mcsz:doc:' + oldRel); if (d) await idbSet('mcsz:doc:' + newEntry.rel, d)
  // fichier pas renommé (introuvable, conflit…) : on réécrit les annotations sous le nouveau nom
  const onDisk = parseJ(nRead(oldData))
  if (!renamed && (d || onDisk)) { const src = [d, onDisk].filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]; queueFile(docFile(newEntry), pretty({ app: 'Partoche', file: newEntry.rel, updated: Date.now(), prefs: src.prefs || {}, ink: src.ink || {} })) }
  // annotations du prof (dans Prof) : elles suivent aussi
  try { native.renameProfDrops && native.renameProfDrops(oldData.replace(/\.json$/i, ''), docFile(newEntry).replace(/\.json$/i, '')) } catch { }
  // étiquettes, temps de travail, demandes d'avis
  if (G.labels && G.labels[oldRel]) { G.labels[newEntry.rel] = G.labels[oldRel]; delete G.labels[oldRel] }
  if (work) { for (const day of Object.values(work.days || {})) if (day[oldRel]) { day[newEntry.rel] = day[oldRel]; delete day[oldRel] } for (const x of work.sessions || []) if (x.s === oldRel) x.s = newEntry.rel; if (work.last && work.last.s === oldRel) work.last.s = newEntry.rel; if (work.tot && work.tot[oldRel] != null) { work.tot[newEntry.rel] = (work.tot[newEntry.rel] || 0) + work.tot[oldRel]; delete work.tot[oldRel] } workDirty = true; workSave(true) }
  if (asksMine && asksMine.some(a => a.rel === oldRel)) saveAsks(asksMine.map(a => a.rel === oldRel ? { ...a, rel: newEntry.rel } : a))
  writeSettings()
  const rec = lsGet('mcsz:recent', []).map(r => (r.url === entry.url || (r.name === entry.name && r.size === entry.size)) ? { ...r, name: newName, url: newUrl } : r)
  lsSet('mcsz:recent', rec); saveSettingsFile()
  const tg = tagOf(entry); if (tg) { setTag(entry, ''); G.tags[newEntry.rel] = tg; saveGlobal() }
  Object.assign(entry, newEntry)
  if (dataIndex.has(oldData)) { dataIndex.set(docFile(newEntry), dataIndex.get(oldData)); dataIndex.delete(oldData) }
  nlog(`renommé : « ${oldRel} » → « ${newEntry.rel} »`)
  toast('Renommé en « ' + baseName(newName) + ' »')
  renderLibrary()
}
async function deleteScore(entry, withAnnot) {
  if (!native || !native.deleteDoc || !entry.url) { toast('Suppression disponible dans l’appli Android'); return }
  if (!native.deleteDoc(entry.url)) { toast('Impossible de supprimer ce fichier'); return }
  if (withAnnot) { try { native.deleteData && native.deleteData(docFile(entry)) } catch { } }
  setTag(entry, '')
  files = files.filter(f => f !== entry)
  lsSet('mcsz:recent', lsGet('mcsz:recent', []).filter(r => !(r.url === entry.url || (r.name === entry.name && r.size === entry.size)))); saveSettingsFile()
  nlog(`supprimé : « ${entry.rel || entry.name} »` + (withAnnot ? ' (+ annotations)' : ''))
  toast('Partition supprimée')
  renderLibrary()
}
const folderOf = e => e.rel && e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : ''
const fmtDate = t => {
  if (!t) return '—'
  const d = new Date(t)
  return d.toLocaleDateString(LOC, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' })
}
const fmtSize = b => !b ? '—' : b < 1024 * 1024 ? Math.round(b / 1024) + ' Ko' : (b / 1048576).toFixed(1).replace('.', ',') + ' Mo'

function row(entry, opened) {
  const r = document.createElement('div')
  r.className = 'lrow'
  r.innerHTML = `<div class="thumb none"><svg class="ic"><use href="#i-note"/></svg></div>
    <div class="lname"><button class="pv" title="Écouter un extrait (30 s)"><svg class="ic"><use href="#i-play"/></svg></button><div class="ltxt"><div class="name"></div><div class="sub"></div></div></div>
    <div class="ldate"></div><div class="ledit"></div><div class="lopen"></div><div class="lsize"></div>`
  r.querySelector('.name').innerHTML = tagPill(tagOf(entry)) + labelMinis(entry) + (entry.enRoute ? '<span class="tag t-route" title="Encore dans le dépôt : l’appli de l’élève va la ranger dans MSCZ">📬 en chemin</span>' : '')
  r.querySelector('.name').append(baseName(entry.name))
  r.querySelector('.sub').textContent = (entry.demo ? 'Démo' : folderOf(entry))
  r.querySelector('.ldate').textContent = fmtDate(entry.mtime)
  const ed = dataIndex.get(docFile(entry))
  const le = r.querySelector('.ledit')
  le.textContent = ed ? fmtDate(ed) : '—'
  le.classList.toggle('has', !!ed)
  const gd = guestDocs.get(docFile(entry))
  if (gd) {
    const b = document.createElement('div'); b.className = 'gbadge'
    const isNew = !TEACHER && gd.stamp > (guestSeen()[docFile(entry)] || '')
    b.classList.toggle('new', isNew)
    b.textContent = (isNew ? '● Nouveau · ' : '✎ ') + (TEACHER ? 'toi' : gd.who) + ' ' + fmtDate(Date.parse(gd.meta.modified))
    le.appendChild(b)
  }
  r.querySelector('.lopen').textContent = opened ? fmtDate(opened) : '—'
  r.querySelector('.lsize').textContent = fmtSize(entry.size)
  r._entry = entry
  bindPress(r, entry)
  thumbObserver.observe(r)
  return r
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }),
  date: (a, b) => (a.mtime || 0) - (b.mtime || 0),
  opened: (a, b) => (a._opened || 0) - (b._opened || 0),
  edited: (a, b) => (dataIndex.get(docFile(a)) || 0) - (dataIndex.get(docFile(b)) || 0),
  size: (a, b) => (a.size || 0) - (b.size || 0),
}
const DEFAULT_DIR = { name: 1, date: -1, edited: -1, opened: -1, size: -1 }

function paintViewerTag() {
  const b = $('#vTag'); if (!b || !V) return
  const t = tagOf(V.entry)
  b.className = 'tag vtag ' + (t ? 't-' + t : 't-none')
  b.textContent = t ? TAGS[t] : '+ Tag'
}
// ---------- tags (À faire / En cours / Maîtrisé) — gardés dans !Settings.json ----------
const TAGS = { new: 'Nouveau', todo: 'À faire', wip: 'En cours', done: 'Maîtrisé' }
// côté prof : ce sont les tags de l'élève (lus dans son !Settings.json) — lecture croisée des configs
let peerTags = {}
const tagOf = e => ((TEACHER ? peerTags : G.tags) || {})[e.rel || e.name] || ''
function setTag(e, tag) {
  if (TEACHER) { toast('Les tags, c’est ' + ownerName() + ' qui les range : tu vois les siens (Nouveau = pas encore ouverte)', 4500); return }
  G.tags = G.tags || {}
  if (tag) G.tags[e.rel || e.name] = tag; else delete G.tags[e.rel || e.name]
  saveGlobal(); writeSettings()
}
function tagPill(tag) { return tag ? `<span class="tag t-${tag}">${TAGS[tag]}</span>` : '' }
// ---------- étiquettes perso (plusieurs par partition, avec emoji et couleur) — gardées dans !Settings.json ----------
const LABELS0 = [
  { id: 'hell', e: '🔥', n: 'L’enfer', c: '#e5484d' }, { id: 'easy', e: '😎', n: 'Easy', c: '#2fb26a' },
  { id: 'fun', e: '🤭', n: 'Marrant', c: '#f5a623' }, { id: 'wtf', e: '🫠', n: 'Improbable', c: '#9b59ff' },
  { id: 'worked', e: '💪', n: 'Déjà bossé', c: '#3e8eff' }, { id: 'love', e: '❤️', n: 'Coup de cœur', c: '#ff5c8a' },
  { id: 'stage', e: '🎤', n: 'Pour la scène', c: '#d14fd8' }, { id: 'chill', e: '🌙', n: 'Détente', c: '#3fb0a8' },
  { id: 'goal', e: '🎯', n: 'Objectif', c: '#ff8a3d' }, { id: 'dust', e: '🕸️', n: 'Oublié', c: '#8b93a1' },
]
let peerLabels = { labels: {}, defs: null }
const labelDefs = () => (TEACHER ? peerLabels.defs : G.labelDefs) || LABELS0
const labelsOf = e => (((TEACHER ? peerLabels.labels : G.labels) || {})[e.rel || e.name] || []).filter(id => labelDefs().some(d => d.id === id))
function setLabels(e, ids) {
  if (TEACHER) return
  G.labels = G.labels || {}
  if (ids.length) G.labels[e.rel || e.name] = ids; else delete G.labels[e.rel || e.name]
  saveGlobal(); writeSettings()
}
const hexA3 = (h, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return 'rgba(128,128,128,' + a + ')'; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }
const labelPill = d => `<span class="tag lbl" style="background:${hexA3(d.c, .25)};color:${d.c};box-shadow:inset 0 0 0 1px ${hexA3(d.c, .5)}">${esc(d.e)} ${esc(d.n)}</span>`
const labelPills = e => labelsOf(e).map(id => labelDefs().find(d => d.id === id)).filter(Boolean).map(labelPill).join('')
// dans la liste : juste l'emoji dans une pastille de sa couleur (le nom au survol / appui long)
const labelMinis = e => labelsOf(e).map(id => labelDefs().find(d => d.id === id)).filter(Boolean).map(d => `<span class="lbmini" style="--lc:${d.c}" title="${esc(d.n)}">${esc(d.e)}</span>`).join('')

function renderLibrary() {
  const lb = $('#libBody'), keepY = lb ? lb.scrollTop : 0
  requestAnimationFrame(() => { if (lb && lb.scrollTop !== keepY) lb.scrollTop = keepY })   // la liste ne remonte pas
  $('#folderLabel').textContent = folderName || 'Choisir un dossier'
  if (G.libSortV !== 2) { G.libSort = 'edited'; G.libDir = -1; G.libSortV = 2; saveGlobal() }   // défaut : dernières annotations en haut
  const sort = G.libSort || 'edited', dir = G.libDir || DEFAULT_DIR[sort], filt = G.libTag || 'all'
  $$('#sortSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.s === sort)
    b.querySelector('i').textContent = b.dataset.s === sort ? (dir > 0 ? ' ↑' : ' ↓') : ''
  })
  $$('#tagSeg button').forEach(b => b.classList.toggle('on', b.dataset.t === filt))

  const rec = lsGet('mcsz:recent', [])
  const openedAt = e => { const r = rec.find(r => (r.url && e.url === r.url) || (e.name === r.name && e.size === r.size)); return r ? (r.t || 1) : 0 }
  for (const f of files) f._opened = openedAt(f)

  const q = $('#q').value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  let list = q ? files.filter(f => f.rel.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q)) : files.slice()
  if (filt === 'none') list = list.filter(f => !tagOf(f))
  else if (filt !== 'all') list = list.filter(f => tagOf(f) === filt)
  const lf = G.libLabel || ''
  if (lf) list = list.filter(f => labelsOf(f).includes(lf))
  paintLabelFilter()
  list.sort((a, b) => SORTS[sort](a, b) * dir || SORTS.name(a, b))

  const grid = $('#grid'); grid.innerHTML = ''
  grid.className = 'list'
  if (list.length) {
    const h = document.createElement('div'); h.className = 'lrow lhead'
    h.innerHTML = '<div></div><div>Nom</div><div class="ldate">Fichier modifié</div><div class="ledit">' + (TEACHER ? 'Annotations' : 'Mes annotations') + '</div><div class="lopen">Ouverte</div><div class="lsize">Taille</div>'
    grid.appendChild(h)
    for (const f of list) grid.appendChild(row(f, f._opened > 1 ? f._opened : 0))
  }
  $('#count').textContent = list.length ? `${list.length} partition${list.length > 1 ? 's' : ''}` : ''
  $('#libTools').hidden = files.length === 0
  $('#empty').hidden = files.length > 0
  if (files.length && !list.length) { grid.innerHTML = '<p class="muted" style="padding:24px;text-align:center">Aucune partition avec ce filtre.</p>' }
  if (native && !files.length) $('#empty').querySelector('p').innerHTML = folderName
    ? `Aucune partition trouvée dans <b>${folderName}</b> pour l’instant — pCloud est peut-être encore en train de charger. Touche <b>Actualiser</b>.`
    : 'Choisis le dossier qui contient tes fichiers <b>.mscz</b>.'
  if (!native && !files.length) $('#empty').querySelector('p').innerHTML = 'Ouvre ou glisse ici des fichiers <b>.mscz</b>' + (window.showDirectoryPicker ? ', ou choisis un dossier.' : '.')
}

$$('#tagSeg button').forEach(b => b.onclick = () => { G.libTag = b.dataset.t; saveGlobal(); renderLibrary() })
function paintLabelFilter() {
  const sel = $('#labelSel'); if (!sel) return
  const cur = G.libLabel || ''
  sel.innerHTML = '<option value="">🏷️ Étiquettes</option>' + labelDefs().map(d => `<option value="${esc(d.id)}"${d.id === cur ? ' selected' : ''}>${esc(d.e + ' ' + d.n)}</option>`).join('')
  sel.classList.toggle('on', !!cur)
}
$('#labelSel').onchange = e => { G.libLabel = e.target.value; saveGlobal(); renderLibrary() }
$$('#sortSeg button').forEach(b => b.onclick = () => {
  const s = b.dataset.s
  if ((G.libSort || 'edited') === s) G.libDir = -(G.libDir || DEFAULT_DIR[s])
  else { G.libSort = s; G.libDir = DEFAULT_DIR[s] }
  saveGlobal(); renderLibrary()
})

function pushRecent(entry) {
  let rec = lsGet('mcsz:recent', [])
  rec = rec.filter(r => !((entry.url && r.url === entry.url) || (r.name === entry.name && r.size === entry.size)))
  rec.unshift({ name: entry.name, url: entry.url, size: entry.size, t: Date.now() })
  lsSet('mcsz:recent', rec.slice(0, 200))
  saveSettingsFile()
}

// =====================================================================
//  LECTEUR
// =====================================================================
let WM = null
async function engine() {
  if (!WM) { WM = (await import('../lib/webmscore.mjs')).default; await WM.ready }
  return WM
}

const player = new Player()
const scroller = $('#scroller')
const pagesEl = $('#pages')
let V = null   // état de la partition ouverte
const ink = new Ink(scroller, () => saveInk())

async function openScore(entry) {
  if (!TEACHER && tagOf(entry) === 'new') setTag(entry, '')
  stopPreview()
  closePops()
  busy('Ouverture…')
  let mf
  try {
    const bytes = await getBytes(entry)
    if (entry.size == null) entry.size = bytes.length
    mf = new MsczFile(bytes, entry.name)
  } catch (e) { busy(false); toast('Impossible d’ouvrir ce fichier : ' + e.message, 4000); return }
  if (V) flushDoc()
  if (V && V.score) { try { V.score.destroy() } catch { } }
  player.stop()
  const fileKey = entry.name + '|' + mf.bytes.length
  const doc = await loadDoc(entry, fileKey)
  const prefs = doc.prefs
  V = {
    entry, mf, fileKey, doc, tok: 0, score: null, midiReady: false,
    visible: (prefs.visible && prefs.visible.length === mf.parts.length) ? prefs.visible : mf.parts.map(p => p.visible),
    mix: (prefs.mix && prefs.mix.length === mf.parts.length) ? prefs.mix : mf.parts.map(() => ({ volume: 1, muted: false, solo: false })),
    sound: prefs.sound || {},
    rate: prefs.rate || 1, zoom: prefs.zoom || 1,
    layout: LAYOUTS.includes(prefs.layout) ? prefs.layout : prefs.twoUp != null ? (prefs.twoUp ? 'two' : 'vertical') : defaultLayout(),
    loop: null, loopPick: null, svg: new Map(),
    notes: Object.assign({ names: G.names || 'off', octave: !!G.octave, above: !!G.above, hideManual: G.hideManual !== false }, prefs.notes || {}),
  }
  if (!V.visible.some(Boolean)) V.visible[0] = true
  V.renderedVisible = V.visible.slice()
  $('#title').textContent = baseName(entry.name)
  paintViewerTag()
  applyZoom(); applyLayout()
  player.rate = V.rate; updateSpeedUI()
  player.setLoop(null); $('#btnLoop').classList.remove('on'); paintLoopBar()
  setInk(false, true)
  show('viewer')
  if (!TEACHER && work) { workTick = Date.now(); setTimeout(() => workStep(), 50) }   // début de séance : heure d'ouverture
  pushRecent(entry)
  buildTrackList()
  updateNamesUI()
  scroller.scrollTop = 0
  await renderVariant(true)
  loadGuestLayer(); paintNet(); setTimeout(() => presTick(true), 500)
  if (!lsGet('mcsz:tutoViewer', false) && lsGet('mcsz:onboarded', false)) setTimeout(() => startTour('viewer'), 700)
}

function saveFilePrefs() {
  if (!V) return
  V.doc.prefs = { visible: V.visible, mix: V.mix, rate: V.rate, zoom: V.zoom, layout: V.layout, notes: V.notes, sound: V.sound || {} }
  saveDoc(V.doc)
}

function variantOpts() {
  const N = V.notes
  return { visible: V.visible.slice(), names: N.names, octave: N.octave, above: N.above, hideManual: N.names !== 'off' && N.hideManual }
}
const variantKey = o => [o.visible.map(v => v ? 1 : 0).join(''), o.names, o.octave ? 1 : 0, o.above ? 1 : 0, o.hideManual ? 1 : 0].join('-')

async function renderVariant(first) {
  const tok = ++V.tok
  const opts = variantOpts()
  busy(first ? 'Mise en page de la partition…' : 'Mise à jour de la partition…')
  let sc, npages, pos
  try {
    const bytes = V.mf.build(opts)
    const W = await engine()
    sc = await W.load('mscz', bytes, [], true)
    if (tok !== V.tok) { sc.destroy(); return }
    npages = await sc.npages()
    pos = await sc.measurePositions()
    if (!V.midiReady) {
      const midiBytes = await sc.saveMidi(true, true)
      V.midi = parseMidi(midiBytes); setupPlayer(V.midi)
      V.midiReady = true
      setTimeout(() => ensureSounds(true), 50)   // préchargement des instruments en arrière-plan
    }
  } catch (e) {
    console.error(e)
    busy(false); toast('Erreur de rendu MuseScore : ' + (e.message || e), 5000)
    return
  }
  if (tok !== V.tok) { sc.destroy(); return }
  const ratio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / scroller.scrollHeight : 0
  if (V.score) { try { V.score.destroy() } catch { } }
  for (const u of V.svg.values()) URL.revokeObjectURL(u)
  V.svg = new Map()
  V.score = sc; V.key = variantKey(opts); V.npages = npages
  V.renderedVisible = opts.visible.slice()
  V.pos = pos
  V.events = pos.events.slice().sort((a, b) => a.position - b.position)
  V.elements = new Map(pos.elements.map(e => [e.id, e]))
  V.PW = pos.pageSize.width; V.PH = pos.pageSize.height
  V.lastMeasure = -1
  await buildPages()
  scroller.scrollTop = ratio * scroller.scrollHeight
  busy(false)
  drawLoopMarks()
  updateCursor(true)
  requestAnimationFrame(kickVisible)   // les pages visibles se dessinent tout de suite (sans attendre un défilement)
}
// demande le rendu des pages / lignes visibles (filet de sécurité si l'observateur ne s'est pas déclenché)
function kickVisible() {
  if (!V || !V.score || !$('#viewer').classList.contains('active')) return
  const r = scroller.getBoundingClientRect(), mx = r.width, my = r.height
  const els = V.tiles ? V.tiles.map(t => t.wrap) : V.pageEls
  els.forEach((el, k) => {
    if (!el) return
    const b = el.getBoundingClientRect()
    if (b.right > r.left - mx && b.left < r.right + mx && b.bottom > r.top - my && b.top < r.bottom + my) {
      const i = V.tiles ? V.tiles[k].page : k
      if (!V.svg.has(i)) requestPage(i); else { const img = (V.tiles ? V.tiles[k].el : el).querySelector('img'); if (img && !img.getAttribute('src')) setImg(i) }
    }
  })
}
setInterval(kickVisible, 800)

// ---------- pages ----------
const renderQ = []; let rendering = false
const pageObserver = new IntersectionObserver(ents => {
  for (const e of ents) {
    if (e.isIntersecting) requestPage(+e.target.dataset.i)
    else if (V && V.tiles && e.target.dataset.tile != null) {   // ligne continue : on libère l'image des tuiles loin de l'écran
      const img = e.target.querySelector('img'); if (img && img.getAttribute('src')) img.removeAttribute('src')
    }
  }
}, { root: scroller, rootMargin: '120% 120%' })

async function buildPages() {
  pageObserver.disconnect()
  renderQ.length = 0
  pagesEl.innerHTML = ''
  const els = []
  V.tiles = V.layout === 'line' ? computeTiles() : null
  if (V.tiles) {
    // ligne continue : une tuile par système (fenêtre sur la page entière), alignées de gauche à droite
    V.pageEls = []; V.pageTiles = []
    V.tiles.forEach((t, k) => {
      const w = document.createElement('div'); w.className = 'tile'
      const d = document.createElement('div')
      d.className = 'page'; d.dataset.i = t.page; d.dataset.tile = k
      w.dataset.i = t.page; w.dataset.tile = k
      d.innerHTML = `<div class="loading">…</div><img alt=""><span class="pnum">${k + 1} / ${V.tiles.length}</span>`
      w.appendChild(d); pagesEl.appendChild(w); els.push(d); t.el = d; t.wrap = w
      if (!V.pageEls[t.page]) V.pageEls[t.page] = d
      ;(V.pageTiles[t.page] = V.pageTiles[t.page] || []).push(d)
      pageObserver.observe(w)
    })
    sizeTiles()
  } else {
    for (let i = 0; i < V.npages; i++) {
      const d = document.createElement('div')
      d.className = 'page'; d.dataset.i = i
      d.style.aspectRatio = `${V.PW} / ${V.PH}`
      d.innerHTML = `<div class="loading">Page ${i + 1}…</div><img alt=""><span class="pnum">${i + 1} / ${V.npages}</span>`
      pagesEl.appendChild(d); els.push(d)
      pageObserver.observe(d)
    }
    V.pageEls = els; V.pageTiles = null
  }
  V.cursorEl = document.createElement('div'); V.cursorEl.className = 'cursor'; V.cursorEl.innerHTML = '<i></i>'
  let data = V.doc.ink[V.key]
  if (!data && V.doc.legacyKey) {
    data = await idbGet('mcsz:ink:' + V.doc.legacyKey + ':' + V.key)
    if (data && data.some(p => p.length)) { V.doc.ink[V.key] = data; saveDoc(V.doc) }
  }
  ink.underWho = V.doc._underWho || ''; ink.underColor = V.doc._underColor || '#9b3fc0'
  ink.attach(els, toView(data, true), toView(V.doc._under ? (V.doc._under[V.key] || null) : null), V.tiles ? V.tiles.map(t => ({ y0: t.y0, y1: t.y1 })) : undefined)
  paintUnder()
  ink.setEnabled(inkOn)
}

// systèmes de la partition -> tuiles { page, y0, y1 (fenêtre visible), o0, o1 (zone « propriétaire » des annotations) }
function computeTiles() {
  const sys = []
  for (const e of [...V.elements.values()].sort((a, b) => a.page - b.page || a.y - b.y)) {
    let s = sys.find(q => q.page === e.page && Math.abs(q.y - e.y) < 3)
    if (!s) sys.push(s = { page: e.page, y: e.y, y2: e.y + e.sy })
    else { s.y = Math.min(s.y, e.y); s.y2 = Math.max(s.y2, e.y + e.sy) }
  }
  sys.sort((a, b) => a.page - b.page || a.y - b.y)
  if (!sys.length) return null
  const padT = 0.05 * V.PH, padB = 0.045 * V.PH
  const tiles = sys.map((q, k) => {
    const prev = sys[k - 1], next = sys[k + 1]
    const o0 = prev && prev.page === q.page ? (prev.y2 + q.y) / 2 : 0
    const o1 = next && next.page === q.page ? (q.y2 + next.y) / 2 : V.PH
    // fenêtre : le système + un peu de marge, sans déborder sur le système voisin
    return { page: q.page, y0: Math.max(o0, q.y - padT) / V.PH, y1: Math.min(o1, q.y2 + padB) / V.PH, o0: o0 / V.PH, o1: o1 / V.PH }
  })
  // la fenêtre de chaque ligne s'agrandit pour montrer toutes les annotations qui lui appartiennent
  // (notes écrites entre deux systèmes, au-dessus, en dessous…)
  const own = (V.doc && V.doc.ink && V.doc.ink[V.key]) || [], und = (V.doc && V.doc._under && V.doc._under[V.key]) || []
  for (const src of [own, und]) (src || []).forEach((pg, p) => {
    for (const o of pg || []) {
      const ys = o.t === 'text' ? [o.y - 0.03, o.y + 0.01] : (o.p || []).map(q => q[1])
      if (!ys.length) continue
      const y = objY(o), lo = Math.min(...ys) - 0.006, hi = Math.max(...ys) + 0.006
      const t = tiles.find(t => t.page === p && y >= t.o0 && y < t.o1); if (!t) continue
      t.y0 = Math.max(t.o0, Math.min(t.y0, lo)); t.y1 = Math.min(t.o1, Math.max(t.y1, hi))
    }
  })
  return tiles
}
function sizeTiles() {
  if (!V || !V.tiles) return
  // même échelle pour toutes les tuiles : la plus haute remplit l'écran
  const th = Math.max(120, (scroller.clientHeight - 28) * V.zoom)
  const maxCrop = Math.max(...V.tiles.map(t => t.y1 - t.y0))
  const pageH = th / maxCrop, pageW = pageH * V.PW / V.PH
  for (const t of V.tiles) {
    Object.assign(t.wrap.style, { width: pageW + 'px', height: (t.y1 - t.y0) * pageH + 'px' })
    Object.assign(t.el.style, { width: pageW + 'px', height: pageH + 'px', top: -t.y0 * pageH + 'px' })
  }
}
// annotations par page <-> par tuile (ligne continue)
const objY = o => o.t === 'text' ? o.y : (o.p && o.p.length ? o.p.reduce((a, q) => a + q[1], 0) / o.p.length : 0)
function toView(data, own) {
  if (!V.tiles || !data) return data
  return V.tiles.map(t => {
    const pg = data[t.page] || []
    return own ? pg.filter(o => { const y = objY(o); return y >= t.o0 && y < t.o1 }) : pg
  })
}
function serializeInk() {
  const arr = ink.serialize()
  if (!V.tiles) return arr
  const out = Array.from({ length: V.npages }, () => [])
  arr.forEach((list, k) => { const t = V.tiles[k]; if (t) out[t.page].push(...list) })
  return out
}
function pageElFor(el) {
  if (!V.pageTiles) return V.pageEls[el.page]
  const y = (el.y + el.sy / 2) / V.PH
  const ts = V.tiles.filter(t => t.page === el.page)
  const t = ts.find(t => y >= t.o0 && y < t.o1) || ts[0]
  return t && t.el
}
async function relayoutPages() {
  if (!V || !V.score) return
  const pages = serializeInk()
  if (pages.some(p => p.length)) V.doc.ink[V.key] = pages
  await buildPages()
  for (const i of V.svg.keys()) setImg(i)
  drawLoopMarks(); updateCursor(true)
}

function requestPage(i) {
  if (!V || !V.score) return
  if (V.svg.has(i)) return setImg(i)
  if (!renderQ.includes(i)) renderQ.push(i)
  pumpRender()
}
async function pumpRender() {
  if (rendering) return
  rendering = true
  while (renderQ.length) {
    // priorité à la page la plus proche de la vue
    const cur = visiblePage()
    renderQ.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))
    const i = renderQ.shift()
    const key = V.key, sc = V.score
    if (!sc) continue
    renderBar(true, 'Chargement de la page ' + (i + 1) + ' / ' + V.npages + '…')
    try {
      const svg = await sc.saveSvg(i, true)
      if (V.key !== key || V.score !== sc) continue
      V.svg.set(i, URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })))
      setImg(i)
    } catch (e) { console.warn('page', i, e) }
  }
  rendering = false
  renderBar(false)
}
function renderBar(on, txt) {
  const b = $('#renderBar'); if (!b) return
  b.hidden = !on; if (txt) b.querySelector('span').textContent = txt
}
function setImg(i) {
  const list = V.pageTiles ? (V.pageTiles[i] || []) : [V.pageEls[i]]
  const url = V.svg.get(i)
  for (const el of list) {
    if (!el) continue
    const img = el.querySelector('img')
    if (img.src !== url) {
      img.onload = () => { const l = el.querySelector('.loading'); if (l) l.remove() }
      img.src = url
    }
  }
}
// tuile / page d'annotation affichée (pour « effacer la page »)
function visibleInkPage() {
  if (!V || !V.tiles) return visiblePage()
  const r = scroller.getBoundingClientRect(), midx = r.left + r.width / 2
  let best = 0, bd = 1e9
  V.tiles.forEach((t, k) => { const b = t.wrap.getBoundingClientRect(); const d = midx < b.left ? b.left - midx : midx > b.right ? midx - b.right : 0; if (d < bd) { bd = d; best = k } })
  return best
}
function visiblePage() {
  if (!V || !V.pageEls) return 0
  const r = scroller.getBoundingClientRect()
  const mid = r.top + r.height / 2, midx = r.left + r.width / 2
  let best = 0, bd = 1e9
  V.pageEls.forEach((el, i) => {
    const b = el.getBoundingClientRect()
    const d = (mid < b.top ? b.top - mid : mid > b.bottom ? mid - b.bottom : 0) + (midx < b.left ? b.left - midx : midx > b.right ? midx - b.right : 0)
    if (d < bd) { bd = d; best = i }
  })
  return best
}

// ---------- zoom / disposition ----------
function applyZoom() {
  pagesEl.style.setProperty('--zoom', V.zoom)
  sizeTiles()
  requestAnimationFrame(() => ink.resize())
}
function setZoom(z, keepCenter = true) {
  z = Math.max(0.4, Math.min(3.5, z))
  const cy = (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight)
  const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth)
  V.zoom = z; applyZoom()
  if (keepCenter) {
    scroller.scrollTop = cy * scroller.scrollHeight - scroller.clientHeight / 2
    scroller.scrollLeft = cx * scroller.scrollWidth - scroller.clientWidth / 2
  }
  saveFilePrefs()
}
const LAYOUTS = ['vertical', 'two', 'horizontal', 'line']
function defaultLayout() {
  if (G.layout === 'one') return 'vertical'
  if (LAYOUTS.includes(G.layout)) return G.layout
  return innerWidth > innerHeight * 1.15 ? 'two' : 'vertical'
}
const LAYOUT_ICON = { vertical: '#i-1up', two: '#i-2up', horizontal: '#i-hup', line: '#i-lineup' }
const isHoriz = l => l === 'horizontal' || l === 'line'
function setVh() { pagesEl.style.setProperty('--vh', scroller.clientHeight + 'px') }
function applyLayout() {
  setVh()
  pagesEl.classList.toggle('two', V.layout === 'two')
  pagesEl.classList.toggle('horiz', V.layout === 'horizontal')
  pagesEl.classList.toggle('line', V.layout === 'line')
  scroller.classList.toggle('horiz', isHoriz(V.layout))
  $('#btnLayout use').setAttribute('href', LAYOUT_ICON[V.layout] || '#i-1up')
  $$('#layoutPop [data-l]').forEach(b => b.classList.toggle('on', b.dataset.l === V.layout))
  requestAnimationFrame(() => ink.resize())
}
async function setLayout(l) {
  if (!V || l === V.layout) return
  const pg = visiblePage()
  const rebuild = l === 'line' || V.layout === 'line'
  V.layout = l; applyLayout(); saveFilePrefs()
  if (rebuild) await relayoutPages()
  requestAnimationFrame(() => {
    const el = V.pageEls && V.pageEls[pg]; if (!el) return
    if (isHoriz(l)) { scroller.scrollTop = 0; scroller.scrollLeft = (l === 'line' ? el.parentElement.offsetLeft : el.offsetLeft) - 14 }
    else { scroller.scrollLeft = 0; scroller.scrollTop = el.offsetTop - 14 }
  })
}
$('#btnZin').onclick = () => setZoom(V.zoom * 1.2)
$('#btnZout').onclick = () => setZoom(V.zoom / 1.2)
$('#btnLayout').onclick = e => { applyLayout(); togglePop('#layoutPop', e.currentTarget, 'down') }
$$('#layoutPop [data-l]').forEach(b => b.onclick = () => { closePops(); setLayout(b.dataset.l) })
// molette verticale -> défilement horizontal en mode « Horizontal » (PC)
scroller.addEventListener('wheel', e => {
  if (!V || !isHoriz(V.layout) || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  if (scroller.scrollHeight <= scroller.clientHeight + 2) { e.preventDefault(); scroller.scrollLeft += e.deltaY }
}, { passive: false })

// pincer pour zoomer (2 doigts)
let pinch = null
scroller.addEventListener('touchstart', e => {
  // 2 doigts = comme le mode Main (zoom + défilement), même en mode Stylo
  if (e.touches.length === 2) {
    const [a, b] = e.touches
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: V.zoom }
  }
}, { passive: true })
scroller.addEventListener('touchmove', e => {
  if (pinch && e.touches.length === 2) {
    e.preventDefault()
    const [a, b] = e.touches
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    const z = pinch.z * d / pinch.d
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2
    if (!pinch.raf) pinch.raf = requestAnimationFrame(() => {
      if (!pinch) return
      pinch.raf = 0; setZoom(z)
      if (ink._pan) ink._pan = { x: mx, y: my, st: scroller.scrollTop, sl: scroller.scrollLeft }   // mode Stylo : le défilement à 2 doigts repart du nouveau zoom
    })
  }
}, { passive: false })
scroller.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null })
scroller.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(V.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) } }, { passive: false })
let resizeT; addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (V) { setVh(); sizeTiles() } ink.resize() }, 150) })

// ---------- lecture ----------
function makeTrackToPart(mf, midi) {
  const staffPart = []
  mf.parts.forEach(p => p.staves.forEach(() => staffPart.push(p.index)))
  const byName = new Map(mf.parts.map(p => [p.name.toLowerCase(), p.index]))
  const nTracks = midi.tracks.length
  return (ti, tr) => {
    if (nTracks === staffPart.length) return staffPart[ti]
    const n = (tr.name || '').toLowerCase()
    if (byName.has(n)) return byName.get(n)
    return staffPart[Math.min(ti, staffPart.length - 1)] ?? 0
  }
}
// son de chaque partie / portée (main droite, main gauche…) : « s<portée> » prime sur « p<partie> »
function makeProgFor(mf, midi) {
  const staffOf = []; mf.parts.forEach(p => p.staves.forEach(() => staffOf.push(staffOf.length)))
  const perStaff = midi.tracks.length === staffOf.length
  const snd = V.sound || {}
  return (ti, part, orig) => {
    const k = perStaff ? snd['s' + ti] : undefined
    const v = k != null && k !== '' ? k : snd['p' + part]
    return v != null && v !== '' ? +v : orig
  }
}
const SOUNDS = [['', 'Son d’origine'], [0, '🎹 Piano'], [40, '🎻 Violon'], [41, '🎻 Alto'], [42, '🎻 Violoncelle'], [43, 'Contrebasse'], [48, 'Cordes (ensemble)'], [73, '🪈 Flûte'], [71, 'Clarinette'], [68, 'Hautbois'], [65, '🎷 Saxophone'], [56, '🎺 Trompette'], [60, 'Cor'], [24, '🎸 Guitare'], [46, 'Harpe'], [52, '🎤 Voix (aah)'], [19, 'Orgue'], [21, 'Accordéon'], [12, 'Marimba'], [8, 'Célesta'], [4, 'Piano électrique']]
async function changeSound(key, val) {
  V.sound = V.sound || {}
  if (val === '' || val == null) delete V.sound[key]; else V.sound[key] = +val
  saveFilePrefs()
  const wasPlaying = player.playing, pos = player.position
  if (wasPlaying) { player.pause(); setPlayIcon(false) }
  setupPlayer(V.midi)
  if (pos) try { player.seek(pos) } catch { }
  toast('🎼 Son changé', 1500)
  await ensureSounds(true)
}
function soundSelect(key) {
  const sel = document.createElement('select'); sel.className = 'sndsel'; sel.title = 'Son à la lecture'
  sel.innerHTML = '<optgroup label="Courants">' + SOUNDS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Tous les instruments">' + GM.map((g, i) => `<option value="${i}">${i + 1}. ${g.replace(/_/g, ' ').replace(/\b\w/, c => c.toUpperCase())}</option>`).join('') + '</optgroup>'
  sel.value = V.sound && V.sound[key] != null ? String(V.sound[key]) : ''
  sel.onchange = () => changeSound(key, sel.value)
  return sel
}
function setupPlayer(midi) {
  const mf = V.mf
  stopPreview()
  player.setScore(midi, mf.parts.length, makeTrackToPart(mf, midi), V.mix, makeProgFor(mf, midi))
  player.onEnd = () => { setPlayIcon(false); updateCursor(true) }
  $('#tDur').textContent = fmt(player.duration)
  V.soundsReady = null
}

async function ensureSounds(background) {
  if (!V.soundsReady) {
    V.soundsLoading = true
    V.soundsReady = player.loadInstruments((d, n) => { V.soundsProgress = n ? `${d}/${n}` : '' }).then(failed => {
      V.soundsLoading = false
      if (failed) toast('Hors-ligne : certains instruments utilisent un son de synthèse', 4000)
    })
  }
  if (!background && V.soundsLoading) {
    const t = setInterval(() => { if (V.soundsLoading) toast('Chargement des instruments… ' + (V.soundsProgress || ''), 1500) }, 300)
    await V.soundsReady
    clearInterval(t); $('#toast').hidden = true
  }
  return V.soundsReady
}

function setPlayIcon(on) { $('#btnPlay use').setAttribute('href', on ? '#i-pause' : '#i-play') }
$('#btnPlay').onclick = async () => {
  if (!V || !V.midiReady) return
  if (player.playing) { player.pause(); setPlayIcon(false); return }
  { const c = player.ensureCtx(); if (c.state !== 'running') c.resume() }   // iPad/iPhone : à faire tout de suite dans le geste
  await ensureSounds()
  await player.play()
  setPlayIcon(true)
  if (V.loop) { const p = player.position; if (p < V.loop.a - 0.05 || p > V.loop.b) player.seek(V.loop.a) }
  updateCursor(true)
  if (V.loop && player.position <= V.loop.a + 0.3) frameLoop(true)
  else if (G.follow) scrollToCursor(true, true)
  loop()
}
$('#btnStart').onclick = () => { player.seek(V.loop ? V.loop.a : 0); updateCursor(true); if (V.loop) frameLoop(false); else scrollToCursor(true) }
$('#seek').addEventListener('input', e => { player.seek(e.target.value / 1000 * player.duration); updateCursor(true) })

function loop() {
  updateCursor(false)
  if (player.playing) requestAnimationFrame(loop)
}

function eventIndexAt(ms) {
  const ev = V.events; let lo = 0, hi = ev.length - 1
  if (!ev.length) return -1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ev[m].position <= ms) lo = m; else hi = m - 1 }
  return lo
}

function updateCursor(force) {
  if (!V || !V.events) return
  const t = player.position
  $('#tCur').textContent = fmt(t)
  if (!seekDragging) $('#seek').value = player.duration ? Math.round(t / player.duration * 1000) : 0
  const idx = eventIndexAt(t * 1000)
  if (idx < 0) return
  const ev = V.events[idx]
  const el = V.elements.get(ev.elid)
  if (!el) return
  const next = V.events[idx + 1]
  const end = next ? next.position : player.duration * 1000
  const frac = Math.max(0, Math.min(1, (t * 1000 - ev.position) / Math.max(1, end - ev.position)))
  const c = V.cursorEl
  const pageEl = pageElFor(el)
  if (!pageEl) return
  if (c.parentElement !== pageEl) pageEl.appendChild(c)
  c.style.display = (player.playing || t > 0) ? 'block' : 'none'
  c.style.left = (el.x / V.PW * 100) + '%'
  c.style.top = (el.y / V.PH * 100) + '%'
  c.style.width = (el.sx / V.PW * 100) + '%'
  c.style.height = (el.sy / V.PH * 100) + '%'
  c.firstChild.style.left = (frac * 100) + '%'
  if (idx !== V.lastMeasure || force) {
    const wrapped = V.loop && V.lastMeasure != null && idx < V.lastMeasure && idx <= V.loop.ia + 1
    V.lastMeasure = idx
    if (player.playing && wrapped) frameLoop(true)          // la boucle repart : on revient au début du passage
    else if (player.playing && G.follow) scrollToCursor(false)
  }
}

let userScrollAt = 0, seekDragging = false
for (const ev of ['wheel', 'touchstart', 'pointerdown']) scroller.addEventListener(ev, () => { userScrollAt = performance.now() }, { passive: true })
$('#seek').addEventListener('pointerdown', () => { seekDragging = true })
addEventListener('pointerup', () => { seekDragging = false })

function scrollToCursor(forceNow, instant) {
  const c = V.cursorEl
  if (!c || !c.parentElement || c.style.display === 'none') return
  if (!forceNow && performance.now() - userScrollAt < 2500) return
  // on n'fait pas défiler la page sous le stylet pendant qu'on écrit
  if (!forceNow && (ink.current || ink.sel || performance.now() - ink.lastActivity < 2500)) return
  frameRect(c.getBoundingClientRect(), instant)
}
// amène un rectangle (mesure, boucle…) dans la zone visible, quel que soit le zoom
function frameRect(cr, instant) {
  const sr = scroller.getBoundingClientRect()
  const top = cr.top - sr.top, bottom = cr.bottom - sr.top
  let dy = 0
  if (cr.height > sr.height * 0.8) dy = top - sr.height * 0.05
  else if (top < sr.height * 0.08 || bottom > sr.height * 0.88) dy = top - sr.height * 0.22
  let dx = 0
  const left = cr.left - sr.left, right = cr.right - sr.left
  if (scroller.scrollWidth > scroller.clientWidth + 4 && (left < 20 || right > sr.width - 10)) dx = cr.width > sr.width * 0.8 ? left - 20 : left - sr.width * 0.1
  if (dy || dx) scroller.scrollBy({ top: dy, left: dx, behavior: instant ? 'auto' : 'smooth' })
}
// boucle : cadrer tout le passage (ou au moins son début s'il est plus grand que l'écran)
function frameLoop(instant) {
  const ms = $$('.loopmark'); if (!ms.length) return
  const rs = ms.map(m => m.getBoundingClientRect())
  const u = { top: Math.min(...rs.map(r => r.top)), left: Math.min(...rs.map(r => r.left)), bottom: Math.max(...rs.map(r => r.bottom)), right: Math.max(...rs.map(r => r.right)) }
  u.width = u.right - u.left; u.height = u.bottom - u.top
  const sr = scroller.getBoundingClientRect()
  const r0 = rs[0]
  const fits = u.height <= sr.height * 0.8 && u.width <= sr.width - 20
  const tgt = fits ? u : { top: r0.top, bottom: r0.bottom, left: r0.left, right: r0.right, width: r0.width, height: r0.height }
  // forcer le recadrage même si c'est « déjà visible » au bord : on place le début en haut
  const sy = tgt.top - sr.top - sr.height * (fits ? Math.max(0.05, (0.9 - tgt.height / sr.height) / 2) : 0.15)
  let sx = 0
  if (scroller.scrollWidth > scroller.clientWidth + 4) {
    const left = tgt.left - sr.left
    if (left < 20 || tgt.right - sr.left > sr.width - 10) sx = left - 20
  }
  scroller.scrollBy({ top: sy, left: sx, behavior: instant ? 'auto' : 'smooth' })
}

// toucher une mesure = aller à cette mesure (ou choisir la boucle)
// souris = main : cliquer-glisser fait défiler la partition (molette du milieu : même en mode Stylo)
let mpan = null
scroller.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || !V) return
  if (!(e.button === 1 || (e.button === 0 && !inkOn))) return
  if (e.target.closest('button, input, .tsel, .pop')) return
  mpan = { x: e.clientX, y: e.clientY, st: scroller.scrollTop, sl: scroller.scrollLeft, moved: false, id: e.pointerId }
  e.preventDefault()   // pas de glisser-déposer d'image ni de sélection
})
addEventListener('pointermove', e => {
  if (!mpan || e.pointerId !== mpan.id) return
  const dx = e.clientX - mpan.x, dy = e.clientY - mpan.y
  if (!mpan.moved && Math.hypot(dx, dy) < 5) return
  if (!mpan.moved) { mpan.moved = true; scroller.classList.add('grabbing') }
  scroller.scrollTop = mpan.st - dy; scroller.scrollLeft = mpan.sl - dx
  e.preventDefault()
})
addEventListener('pointerup', e => {
  if (!mpan || e.pointerId !== mpan.id) return
  if (mpan.moved) { const stop = ev => { ev.stopPropagation(); ev.preventDefault() }; addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => removeEventListener('click', stop, { capture: true }), 50) }
  mpan = null; scroller.classList.remove('grabbing')
})
pagesEl.addEventListener('click', e => {
  if (inkOn || !V || !V.events) return
  const pageEl = e.target.closest('.page'); if (!pageEl) return
  const i = +pageEl.dataset.i
  const r = pageEl.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width * V.PW, y = (e.clientY - r.top) / r.height * V.PH
  let hit = null
  for (const el of V.elements.values()) {
    if (el.page === i && x >= el.x && x <= el.x + el.sx && y >= el.y - 10 && y <= el.y + el.sy + 10) { hit = el; break }
  }
  if (!hit) return
  const occ = V.events.map((ev, k) => ({ ev, k })).filter(o => o.ev.elid === hit.id)
  if (!occ.length) return
  const now = player.position * 1000
  // occurrence la plus proche de la position actuelle (reprises)
  occ.sort((a, b) => Math.abs(a.ev.position - now) - Math.abs(b.ev.position - now))
  const target = occ[0]
  if (V.loopPick) { pickLoop(target.k); return }
  player.seek(target.ev.position / 1000)
  updateCursor(true)
})

function drawLoopMarks(ia, ib) {
  $$('.loopmark').forEach(m => m.remove())
  if (ia == null) { if (!V.loop) return; ia = V.loop.ia; ib = V.loop.ib }
  const seen = new Set()
  for (let k = ia; k <= ib; k++) {
    const el = V.elements.get(V.events[k].elid)
    if (!el || seen.has(el.id)) continue; seen.add(el.id)
    const m = document.createElement('div'); m.className = 'loopmark'
    Object.assign(m.style, { left: el.x / V.PW * 100 + '%', top: el.y / V.PH * 100 + '%', width: el.sx / V.PW * 100 + '%', height: el.sy / V.PH * 100 + '%' })
    const pe = pageElFor(el); pe && pe.appendChild(m)
  }
}

// boucle : 1) bouton boucle  2) toucher la mesure de début  3) la mesure de fin (re-toucher pour ajuster)  4) « Boucler »
function paintLoopBar() {
  const P = V.loopPick, bar = $('#loopBar')
  bar.hidden = !P
  if (!P) return
  const n = k => 'mesure ' + (k + 1)
  $('#loopMsg').textContent = P.a == null ? 'Touche la mesure de début'
    : P.b == null ? `Début : ${n(P.a)} · touche la mesure de fin`
    : `De ${n(P.a)} à ${n(P.b)} · touche pour ajuster`
  $('#loopGo').disabled = P.a == null
  $('#loopCancel').textContent = V.loop ? 'Arrêter la boucle' : 'Annuler'
}
function pickLoop(k) {
  const P = V.loopPick
  if (P.a == null) P.a = k
  else if (P.b == null) { if (k < P.a) { P.b = P.a; P.a = k } else P.b = k }
  else if (k < P.a) P.a = k
  else if (k > P.b) P.b = k
  else if (k - P.a < P.b - k) P.a = k
  else P.b = k
  drawLoopMarks(P.a, P.b == null ? P.a : P.b)
  paintLoopBar()
}
function startLoopPick() {
  V.loopPick = { a: null, b: null }
  if (V.loop) { V.loopPick.a = V.loop.ia; V.loopPick.b = V.loop.ib }
  $('#btnLoop').classList.add('on')
  if (inkOn) setInk(false)
  paintLoopBar()
}
function cancelLoopPick() {
  V.loopPick = null; paintLoopBar()
  $('#btnLoop').classList.toggle('on', !!V.loop)
  drawLoopMarks()
}
function clearLoop() {
  V.loop = null; V.loopPick = null; player.setLoop(null); paintLoopBar()
  $('#btnLoop').classList.remove('on'); drawLoopMarks()
}
$('#loopGo').onclick = () => {
  const P = V.loopPick; if (!P || P.a == null) return
  const a = P.a, b = P.b == null ? P.a : P.b
  V.loopPick = null; paintLoopBar()
  const start = V.events[a].position / 1000
  const end = (V.events[b + 1] ? V.events[b + 1].position : player.duration * 1000) / 1000
  V.loop = { a: start, b: end, ia: a, ib: b }
  player.setLoop(start, end)
  player.seek(start)
  $('#btnLoop').classList.add('on')
  drawLoopMarks(); updateCursor(true)
  requestAnimationFrame(() => frameLoop(false))
  toast('Boucle activée · touche ⟲ pour la modifier ou l’arrêter')
}
$('#loopCancel').onclick = () => { if (V.loop && V.loopPick) { clearLoop(); toast('Boucle désactivée') } else cancelLoopPick() }
$('#btnLoop').onclick = () => {
  if (V.loopPick) { cancelLoopPick(); return }
  startLoopPick()
}
$('#btnFollow').onclick = () => { G.follow = !G.follow; saveGlobal(); $('#btnFollow').classList.toggle('on', G.follow); if (G.follow) scrollToCursor(true) }
$('#btnFollow').classList.toggle('on', G.follow)

// vitesse
function updateSpeedUI() {
  const v = Math.round(player.rate * 100)
  $('#speedLbl').textContent = v + ' %'; $('#speedVal').textContent = v + ' %'; $('#speed').value = v
  $$('#speedPop [data-s]').forEach(b => b.classList.toggle('on', +b.dataset.s === v))
}
function setRate(v) { player.setRate(v / 100); V.rate = v / 100; updateSpeedUI(); saveFilePrefs() }
$('#speed').addEventListener('input', e => setRate(+e.target.value))
$$('#speedPop [data-s]').forEach(b => b.onclick = () => setRate(+b.dataset.s))
$('#btnSpeed').onclick = e => togglePop('#speedPop', e.currentTarget, 'up')

// ---------- pistes ----------
function buildTrackList() {
  const list = $('#trackList'); list.innerHTML = ''
  V.mf.parts.forEach((p, i) => {
    const m = V.mix[i]
    const row = document.createElement('div')
    row.className = 'track'
    row.innerHTML = `
      <label class="show"><input type="checkbox"><span class="nm"></span></label>
      <button class="btn icon mute" title="Son"><svg class="ic"><use href="#i-vol"/></svg></button>
      <button class="btn icon solo" title="Solo">S</button>
      <div class="vol"><input type="range" min="0" max="100" step="1"></div>`
    row.querySelector('.nm').textContent = p.name
    const cb = row.querySelector('.show input'), mute = row.querySelector('.mute'), solo = row.querySelector('.solo'), vol = row.querySelector('.vol input')
    const paint = () => {
      cb.checked = !!V.visible[i]
      row.classList.toggle('hiddenpart', !V.visible[i])
      mute.classList.toggle('off', m.muted); mute.querySelector('use').setAttribute('href', m.muted ? '#i-mute' : '#i-vol')
      solo.classList.toggle('on', m.solo)
      vol.value = Math.round(m.volume * 100)
    }
    cb.onchange = () => { V.visible[i] = cb.checked; paint(); visibilityChanged() }
    mute.onclick = () => { m.muted = !m.muted; player.setPart(i, { muted: m.muted }); paint(); saveFilePrefs() }
    solo.onclick = () => { m.solo = !m.solo; player.setPart(i, { solo: m.solo }); paint(); saveFilePrefs() }
    vol.oninput = () => { m.volume = vol.value / 100; player.setPart(i, { volume: m.volume }); if (m.muted && m.volume > 0) { m.muted = false; player.setPart(i, { muted: false }) } paint(); saveFilePrefs() }
    row._paint = paint
    paint()
    list.appendChild(row)
    // son à la lecture : toute la partie, ou chaque portée (ex. piano : main droite au violon, main gauche au piano)
    const first = V.mf.parts.slice(0, i).reduce((n, q) => n + q.staves.length, 0)
    const snd = document.createElement('div'); snd.className = 'trsnd'
    if (p.staves.length > 1 && V.midi && V.midi.tracks.length === V.mf.parts.reduce((n, q) => n + q.staves.length, 0)) {
      p.staves.forEach((_, k) => {
        const lab = document.createElement('label')
        lab.textContent = p.staves.length === 2 ? (k === 0 ? '🫱 Main droite' : '🫲 Main gauche') : 'Portée ' + (k + 1)
        lab.appendChild(soundSelect('s' + (first + k))); snd.appendChild(lab)
      })
    } else { const lab = document.createElement('label'); lab.textContent = '🔈 Son'; lab.appendChild(soundSelect('p' + i)); snd.appendChild(lab) }
    list.appendChild(snd)
  })
  $('#noneWarn').hidden = V.visible.some(Boolean)
}
const rerenderSoon = debounce(() => { if (V.visible.some(Boolean)) renderVariant(false) }, 900)
// les cases cochées s'appliquent à la partition quand on ferme le panneau (croix)
function visibilityChanged() {
  const any = V.visible.some(Boolean)
  $('#noneWarn').hidden = any
  $('#applyHint').hidden = !any || JSON.stringify(V.visible) === JSON.stringify(V.renderedVisible)
}
function closeTracks() {
  $('#tracksPanel').classList.remove('open'); $('#btnTracks').classList.remove('on')
  // rien de coché : on revient à l'affichage actuel
  if (!V.visible.some(Boolean) && V.renderedVisible) { V.visible = V.renderedVisible.slice(); buildTrackList(); return }
  if (JSON.stringify(V.visible) !== JSON.stringify(V.renderedVisible)) { saveFilePrefs(); renderVariant(false) }
  $('#applyHint').hidden = true
}
const setAllMix = fn => { V.mix.forEach((m, i) => { fn(m, i); player.setPart(i, { muted: m.muted, solo: m.solo }) }); buildTrackList(); saveFilePrefs() }
$('#allShow').onclick = () => { V.visible = V.visible.map(() => true); buildTrackList(); visibilityChanged() }
$('#allHide').onclick = () => { V.visible = V.visible.map(() => false); buildTrackList(); visibilityChanged() }
$('#allSound').onclick = () => setAllMix(m => { m.muted = false; m.solo = false })
$('#allMute').onclick = () => setAllMix(m => { m.muted = true; m.solo = false })
$('#soundVisible').onclick = () => setAllMix((m, i) => { m.muted = !V.visible[i]; m.solo = false })
$('#btnTracks').onclick = () => { closePops(); if ($('#tracksPanel').classList.contains('open')) return closeTracks(); $('#tracksPanel').classList.add('open'); $('#btnTracks').classList.add('on') }
$('#tracksPanel [data-close]').onclick = closeTracks

// ---------- noms de notes ----------
function updateNamesUI() {
  const N = V ? V.notes : G
  $$('#namesSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === N.names))
  $('#namesLbl').textContent = N.names === 'letter' ? 'A B C' : N.names === 'solfege' ? 'Do Ré Mi' : 'Notes'
  $('#btnNames').classList.toggle('on', N.names !== 'off')
  $('#optOctave').checked = !!N.octave; $('#optAbove').checked = !!N.above; $('#optHideManual').checked = N.hideManual !== false
  $('#rowManual').hidden = !(V && V.mf.hasManualNames)
  ;['#optOctave', '#optAbove', '#optHideManual'].forEach(s => { $(s).disabled = N.names === 'off'; $(s).parentElement.style.opacity = N.names === 'off' ? .45 : 1 })
}
// noms de notes : réglage propre à chaque partition (gardé dans son fichier), défaut dans Options
$$('#namesSeg button').forEach(b => b.onclick = () => {
  if (!V || V.notes.names === b.dataset.v) return
  V.notes.names = b.dataset.v; saveFilePrefs(); updateNamesUI(); rerenderSoon()
})
for (const [id, k] of [['#optOctave', 'octave'], ['#optAbove', 'above'], ['#optHideManual', 'hideManual']]) {
  $(id).onchange = e => { if (!V) return; V.notes[k] = e.target.checked; saveFilePrefs(); updateNamesUI(); if (V.notes.names !== 'off') rerenderSoon() }
}
$('#btnNames').onclick = e => togglePop('#namesPop', e.currentTarget, 'down')

// ---------- popovers ----------
function togglePop(sel, anchor, dir) {
  const pop = $(sel)
  const wasOpen = !pop.hidden
  closePops()
  if (wasOpen) return
  pop.hidden = false
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight
  let left = Math.min(innerWidth - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2))
  pop.style.left = left + 'px'
  pop.style.top = (dir === 'up' ? r.top - ph - 8 : r.bottom + 8) + 'px'
  anchor.classList.add('popopen')
}
function closePops() { $$('.pop').forEach(p => p.hidden = true); $$('.popopen').forEach(b => b.classList.remove('popopen')) }
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.pop') && !e.target.closest('.popopen') && !e.target.closest('#btnNames') && !e.target.closest('#btnSpeed')) closePops()
})

// ---------- annotations ----------
let inkOn = false
function setInk(on, silent) {
  inkOn = on
  ink.setEnabled(on)
  $('#inkbar').hidden = !on
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === (on ? 'pen' : 'hand')))
  if (!on) { closePops(); ink.deselect && ink.deselect(); if (!silent && V && V.doc) commitDoc() }
}
$$('#modeSeg button').forEach(b => b.onclick = () => { closePops(); setInk(b.dataset.m === 'pen') })
const DEFAULT_PALETTE = ['#138a4a', '#d11a2a', '#1f5fd6', '#8b5a2b']
if (!Array.isArray(G.palette) || !G.palette.length) G.palette = DEFAULT_PALETTE.slice()
if (!G.palette.includes(G.color)) G.color = G.palette[0]
ink.tool = (G.tool === 'text' || G.tool === 'emoji') ? 'pen' : (G.tool || 'pen'); ink.shape = G.shape || 'ellipse'; ink.color = G.color; ink.size = G.size || 2; ink.fingerDraws = !G.fingerScroll
let editingColors = false
function renderSwatches() {
  const box = $('#swatches'); box.innerHTML = ''
  box.classList.toggle('editing', editingColors)
  for (const c of G.palette) {
    const b = document.createElement('button')
    b.className = 'swatch'; b.style.setProperty('--c', c); b.dataset.color = c; b.title = c
    b.onclick = () => {
      if (editingColors) {
        if (G.palette.length <= 1) { toast('Garde au moins une couleur'); return }
        G.palette = G.palette.filter(x => x !== c)
        if (G.color === c) { G.color = ink.color = G.palette[0] }
        saveGlobal(); renderSwatches(); paintInkbar(); return
      }
      ink.color = G.color = c
      if (ink.setSelectedColor(c)) { saveGlobal(); paintInkbar(); return }
      if (ink.tool === 'eraser' || ink.tool === 'hl') { ink.setTool('pen'); G.tool = 'pen' }
      saveGlobal(); paintInkbar()
    }
    box.appendChild(b)
  }
}
const TOOL_ICON = { pen: '#i-pen', hl: '#i-hl', text: '#i-text', eraser: '#i-eraser' }
function paintInkbar() {
  $('#toolIcon').setAttribute('href', TOOL_ICON[ink.tool] || '#i-pen')
  const emo = ink.tool === 'emoji', shp = ink.tool === 'shape'
  $('#toolSvg').style.display = emo || shp ? 'none' : ''
  $('#toolEmo').hidden = !emo && !shp
  if (emo) $('#toolEmo').textContent = ink.emoji || ''
  if (shp) { const sb = $(`#shapeRow [data-shape="${ink.shape}"] svg`); $('#toolEmo').innerHTML = sb ? sb.outerHTML : '' }
  $$('#shapeRow [data-shape]').forEach(b => b.classList.toggle('on', shp && b.dataset.shape === ink.shape))
  $('#toolPop [data-tool=emoji] .emo').textContent = ink.emoji || '〰️'
  const dot = $('#toolDot')
  dot.style.display = ink.tool === 'eraser' || emo ? 'none' : ''
  dot.style.setProperty('--s', (3 + ink.size * 2) + 'px')
  dot.style.setProperty('--c', ink.tool === 'hl' ? '#ffd400' : ink.color)
  $$('#toolPop [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === ink.tool))
  $$('#toolPop [data-size]').forEach(b => b.classList.toggle('on', +b.dataset.size === ink.size))
  $('#sizeRow').hidden = ink.tool === 'eraser' || ink.tool === 'hl'
  $$('#inkbar .swatch').forEach(b => b.classList.toggle('on', b.dataset.color === ink.color && !editingColors && ink.tool !== 'eraser' && ink.tool !== 'hl'))
  $('#optFinger').checked = !!G.fingerScroll
  $('#editColorsLbl').textContent = editingColors ? 'Terminer' : 'Retirer des couleurs'
}
$('#btnTool').onclick = e => togglePop('#toolPop', e.currentTarget, 'down')
$('#btnMore').onclick = e => togglePop('#morePop', e.currentTarget, 'down')
$$('#toolPop [data-tool]').forEach(b => b.onclick = () => {
  if (b.dataset.tool === 'emoji') { openEmojiPop(null); return }
  ink.setTool(b.dataset.tool); G.tool = b.dataset.tool; saveGlobal(); paintInkbar()
  if (b.dataset.tool === 'text') { closePops(); toast('Touche la page pour écrire · touche un texte pour le déplacer, tourner ou agrandir', 3500) }
  if (b.dataset.tool === 'eraser' || b.dataset.tool === 'hl') closePops()
})
$$('#shapeRow [data-shape]').forEach(b => b.onclick = () => {
  ink.setTool('shape'); ink.shape = G.shape = b.dataset.shape; G.tool = 'shape'; saveGlobal(); paintInkbar(); closePops()
})
$$('#toolPop [data-size]').forEach(b => b.onclick = () => { ink.size = G.size = +b.dataset.size; ink.setSelectedSize(+b.dataset.size); saveGlobal(); paintInkbar(); closePops() })
$('#colorPick').addEventListener('change', e => {
  const c = e.target.value.toLowerCase()
  if (!G.palette.includes(c)) G.palette.push(c)
  G.color = ink.color = c; editingColors = false
  if (ink.tool === 'eraser' || ink.tool === 'hl') { ink.setTool('pen'); G.tool = 'pen' }
  saveGlobal(); renderSwatches(); paintInkbar(); closePops()
})
$('#btnEditColors').onclick = () => { editingColors = !editingColors; renderSwatches(); paintInkbar(); closePops(); if (editingColors) toast('Touche une couleur pour la retirer · ⋯ puis « Terminer »', 3500) }
$('#optFinger').onchange = e => { G.fingerScroll = e.target.checked; ink.fingerDraws = !G.fingerScroll; saveGlobal() }
$('#btnUndo').onclick = () => ink.undo()
$('#btnRedo').onclick = () => ink.redo()
$('#btnClearPage').onclick = () => { closePops(); ink.clearPage(visibleInkPage()); toast('Page effacée (Annuler pour revenir)') }
// ---- emoji (tampons d'annotation) ----
const DEFAULT_EMOJIS = [
  ['〰️', 'Vibrato'], ['🔔', 'Laisser résonner'], ['⏸️', 'Pause / silence'], ['🫁', 'Respirer'],
  ['⏱️', 'Tempo / métronome'], ['🐢', 'Ralentir'], ['🐇', 'Accélérer'], ['⚓', 'Garder le tempo'],
  ['📈', 'Crescendo'], ['📉', 'Decrescendo'], ['🔊', 'Fort'], ['🤫', 'Doux'],
  ['🌊', 'Legato / lié'], ['✂️', 'Détaché / staccato'],
  ['🪶', 'Léger'], ['💪', 'Appuyé'], ['❤️', 'Expressif'], ['🎯', 'Justesse'],
  ['👂', 'Écouter'], ['👀', 'Attention'], ['⚠️', 'Passage difficile'], ['🔁', 'À travailler'],
  ['🔄', 'Changement de position'], ['😮‍💨', 'Détendre'], ['⭐', 'Bien joué'], ['❓', 'À revoir'],
]
if (!Array.isArray(G.emojis) || !G.emojis.length) G.emojis = DEFAULT_EMOJIS.map(([e, l]) => ({ e, l }))
ink.emoji = G.emoji || G.emojis[0].e
ink.onPickEmoji = cb => openEmojiPop(cb)
let emojiCb = null
function renderEmojis() {
  const box = $('#emojiGrid'); box.innerHTML = ''
  for (const it of G.emojis) {
    const b = document.createElement('button')
    b.innerHTML = `<b></b><small></small>`
    b.querySelector('b').textContent = it.e; b.querySelector('small').textContent = it.l || ''
    b.classList.toggle('on', !emojiCb && it.e === ink.emoji && ink.tool === 'emoji')
    b.onclick = () => pickEmoji(it.e)
    bindPressSimple(b, () => {
      if (G.emojis.length <= 1) return
      G.emojis = G.emojis.filter(x => x !== it); saveGlobal(); renderEmojis(); toast('Emoji retiré de la liste')
    })
    box.appendChild(b)
  }
}
function bindPressSimple(el, fn) {
  let t = 0
  el.addEventListener('pointerdown', () => { t = setTimeout(() => { t = -1; fn() }, 650) })
  const end = () => { if (t > 0) clearTimeout(t) }
  el.addEventListener('pointerup', end); el.addEventListener('pointerleave', end); el.addEventListener('pointercancel', end)
  el.addEventListener('click', e => { if (t === -1) { e.stopImmediatePropagation(); e.preventDefault(); t = 0 } }, true)
}
function openEmojiPop(cb) {
  emojiCb = cb
  renderEmojis()
  closePops()
  togglePop('#emojiPop', $('#btnTool'), 'down')
}
function pickEmoji(e) {
  closePops()
  if (emojiCb) { const cb = emojiCb; emojiCb = null; cb(e); return }
  ink.emoji = G.emoji = e
  ink.setTool('emoji'); G.tool = 'emoji'; saveGlobal(); paintInkbar()
  toast('Touche la partition pour poser ' + e + ' · touche un emoji posé pour le déplacer / agrandir', 3000)
}
$('#emojiAdd').onclick = () => {
  promptText('Ajouter un emoji', '', t => {
    t = (t || '').trim(); if (!t) return
    const [e, ...rest] = t.split(/\s+/)
    if (!G.emojis.some(x => x.e === e)) G.emojis.push({ e, l: rest.join(' ') })
    saveGlobal(); pickEmoji(e)
  }, 'Colle un emoji, puis un nom (ex. « 🎵 Chanter »)')
}
$('#emojiReset').onclick = () => { G.emojis = DEFAULT_EMOJIS.map(([e, l]) => ({ e, l })); saveGlobal(); renderEmojis(); toast('Liste d’emoji réinitialisée') }
renderSwatches(); paintInkbar()

// saisie de texte
ink.onEditText = (init, cb) => promptText('Texte', init, cb, 'Écris ton annotation…')

const saveInk = debounce(() => {
  if (!V || !V.key || !V.doc) return
  const pages = serializeInk()
  if (pages.some(p => p.length)) V.doc.ink[V.key] = pages
  else delete V.doc.ink[V.key]
  saveDoc(V.doc)
  if (TEACHER && !V.doc._demo) teacherAutoSend()
}, 500)
// prof : chaque modification part tout de suite chez l'élève (file d'attente, un envoi à la fois)
const teacherAutoSend = debounce(() => { if (V && V.doc) commitDoc(V.doc) }, 3000)

// ---------- navigation ----------
function backToLibrary() {
  if (!TEACHER && work) try { workStep(true) } catch { }   // fin de séance : heure de fermeture
  player.pause(); setPlayIcon(false)
  if (V && V.visible && V.visible.some(Boolean)) saveFilePrefs()   // config (pistes, son…) toujours gardée, même panneau ouvert
  flushDoc()
  setInk(false); closePops(); $('#tracksPanel').classList.remove('open')
  show('library'); renderLibrary(); refreshGuest(); setTimeout(() => presTick(true), 300)
}
$('#btnBack').onclick = backToLibrary
$('#vTag').onclick = () => {
  if (TEACHER) { setTag(V.entry); return }
  const order = ['', 'todo', 'wip', 'done'], cur = tagOf(V.entry)
  setTag(V.entry, order[(order.indexOf(cur) + 1) % order.length]); paintViewerTag()
}
bridge.onBack = () => {
  if (!$('#tuner').hidden) { closeTuner(); return true }
  if (!$('#settings').hidden) { $('#settings').hidden = true; return true }
  if (!$('#tutoDlg').hidden) { $('#tutoDlg').hidden = true; return true }
  if (!$('#scoreMenu').hidden) { $('#scoreMenu').hidden = true; return true }
  if (!$('#textDlg').hidden) { $('#textCancel').click(); return true }
  if ($$('.pop').some(p => !p.hidden)) { closePops(); return true }
  if ($('#tracksPanel').classList.contains('open')) { closeTracks(); return true }
  if (inkOn) { setInk(false); return true }
  if ($('#viewer').classList.contains('active')) { backToLibrary(); return true }
  return false
}
syncShareToNative()
bridge.onResume = () => { if ($('#library').classList.contains('active')) refreshGuest(true) }
bridge.onPause = () => { stopPreview(); if (tuner && !$('#tuner').hidden) closeTuner(); flushDoc(); if (player.playing) { player.pause(); setPlayIcon(false) } }
document.addEventListener('visibilitychange', () => { if (document.hidden && player.playing) { player.pause(); setPlayIcon(false) } })
document.addEventListener('keydown', e => {
  if (!$('#viewer').classList.contains('active') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click() }
  if (e.key === 'Escape') bridge.onBack()
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') ink.undo()
})

// =====================================================================
//  OPTIONS
// =====================================================================
// =====================================================================
//  ASSISTANT DE CONFIGURATION (élève, appli Android) : pCloud -> dossier Partoche -> liens pour le prof
// =====================================================================
const pcWait = new Map(); let pcSeq = 0
bridge.onPc = (id, json) => { const f = pcWait.get(id); if (f) { pcWait.delete(id); f(parseJ(json) || { error: 'réponse vide' }) } }
const pcCall = (action, args = {}) => new Promise(res => {
  if (!native || !native.pcCall) return res({ error: 'disponible dans l’appli Android' })
  const id = 'p' + (++pcSeq); pcWait.set(id, res); native.pcCall(id, action, JSON.stringify(args))
})
let wizMandatory = false, fCur = { id: 0, name: '/', parent: -1 }, fTrail = []
function wizStep(step) {
  $$('#wiz [data-step]').forEach(sec => sec.hidden = sec.dataset.step !== step)
  const k = { start: 0, pc: 1, folder: 1, done: 2 }[step]
  $$('#wiz .wizdots i').forEach((d, i) => { d.classList.toggle('on', i === k); d.classList.toggle('ok', i < k) })
  $('#wizTitle').textContent = { start: 'Bienvenue !', pc: 'Connexion à pCloud', folder: 'Ton dossier Partoche', done: 'C’est prêt !' }[step]
  $('#wizClose').hidden = wizMandatory && step !== 'done'
}
function openWizard(mandatory, step) {
  wizMandatory = !!mandatory
  $('#settings').hidden = true
  $('#wiz').hidden = false
  const info = nativeInfo() || {}
  $('#pcErr').hidden = true; $('#pcTfaRow').hidden = true
  $('#shMyName').value = G.myName || ''
  if (step === 'done') { showSummary(null); wizStep('done') }
  else wizStep('start')
}
$('#stNew').onclick = () => { bridge._wizLocal = true; native && native.pickNewRootFolder && native.pickNewRootFolder() }
$('#stExisting').onclick = () => { bridge._wizLocal = true; native && native.pickRootFolder && native.pickRootFolder() }
$('#stCloud').onclick = () => {
  const info = nativeInfo() || {}
  if (info.pcEmail) { $('#pcEmail').value = info.pcEmail; wizStep('folder'); browse(0) } else wizStep('pc')
}
$('#pcBack').onclick = e => { e.preventDefault(); wizStep('start') }
bridge.onRootSetup = json => { const r = parseJ(json); if (!r) return; bridge._wizLocal = false; if ($('#wiz').hidden) return; showSummary(r); wizStep('done') }
function closeWizard() { $('#wiz').hidden = true }
$('#wizClose').onclick = closeWizard
$('#pcGo').onclick = async () => {
  const err = m => { $('#pcErr').textContent = m; $('#pcErr').hidden = !m }
  err('')
  const tfa = !$('#pcTfaRow').hidden
  if (!tfa && (!$('#pcEmail').value.trim() || !$('#pcPwd').value)) return err('Indique ton email et ton mot de passe pCloud.')
  $('#pcGo').disabled = true; $('#pcGo').textContent = 'Connexion…'
  const r = tfa ? await pcCall('tfa', { code: $('#pcTfa').value.trim() }) : await pcCall('login', { email: $('#pcEmail').value.trim(), password: $('#pcPwd').value })
  $('#pcGo').disabled = false; $('#pcGo').textContent = 'Se connecter'
  if (r.needTfa) { $('#pcTfaRow').hidden = false; $('#pcTfa').focus(); return err('pCloud demande ton code de double authentification.') }
  if (r.error) return err(r.code === 2000
    ? 'pCloud refuse la connexion (' + r.error.replace(/^.*\[/, '[') + '). Vérifie le mot de passe en te connectant sur my.pcloud.com avec ton email (pas le bouton Google). Autre solution, sans connexion ici : « Revenir au choix » → dossier sur la tablette synchronisé avec pCloud.'
    : 'pCloud : ' + r.error + (r.code ? ' (code ' + r.code + ')' : '') + (tfa ? ' — vérifie le code (il change toutes les 30 s) et réessaie.' : ''))
  $('#pcPwd').value = ''
  wizStep('folder'); browse(0)
}
$('#pcWeb').onclick = async () => {
  $('#pcErr').hidden = true
  const r = await pcCall('weblogin', {})
  if (r.error) { if (r.error !== 'annulé') { $('#pcErr').textContent = 'pCloud : ' + r.error; $('#pcErr').hidden = false } return }
  toast('✓ Connecté à pCloud' + (r.email ? ' (' + r.email + ')' : ''), 3000)
  wizStep('folder'); browse(0)
}
async function browse(id, name) {
  $('#fErr').hidden = true
  $('#fList').innerHTML = '<div class="muted">Chargement…</div>'
  const r = await pcCall('folders', { folderid: id })
  if (r.error) { $('#fList').innerHTML = ''; $('#fErr').textContent = 'pCloud : ' + r.error; $('#fErr').hidden = false; return }
  if (id === 0) fTrail = []
  else { const k = fTrail.findIndex(t => t.id === id); if (k >= 0) fTrail = fTrail.slice(0, k + 1); else fTrail.push({ id, name: r.name || name }) }
  fCur = { id, name: id === 0 ? 'pCloud' : (r.name || name) }
  // fil d'Ariane
  const path = $('#fPath'); path.innerHTML = ''
  const crumb = (label, fid) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => browse(fid); path.appendChild(b) }
  crumb('☁️ pCloud', 0); for (const t of fTrail) { path.append(' › '); crumb(t.name, t.id) }
  // sous-dossiers ; « Partoche » mis en avant
  const list = $('#fList'); list.innerHTML = ''
  const fs = (r.folders || []).sort((a, b) => (b.name.toLowerCase() === 'partoche') - (a.name.toLowerCase() === 'partoche') || a.name.localeCompare(b.name, 'fr'))
  const looksLikeRoot = fs.some(f => /^(mscz|eleve|élève|prof|apksettings)$/i.test(f.name))
  for (const f of fs) {
    const b = document.createElement('button')
    b.innerHTML = '<span>📁</span><span style="flex:1"></span><span class="muted">›</span>'
    b.children[1].textContent = f.name
    if (f.name.toLowerCase() === 'partoche') b.classList.add('hot')
    b.onclick = () => browse(f.id, f.name)
    list.appendChild(b)
  }
  if (!fs.length) list.innerHTML = '<div class="muted">Dossier vide.</div>'
  $('#fUse').disabled = id === 0
  $('#fUse').textContent = id === 0 ? 'Ouvre un dossier' : `Utiliser « ${fCur.name} »`
  $('#fNew').hidden = fs.some(f => f.name.toLowerCase() === 'partoche')
  if (looksLikeRoot && id !== 0) { $('#fErr').textContent = '👍 Ce dossier ressemble à un dossier Partoche (MSCZ / MesNotes / Prof).'; $('#fErr').hidden = false; $('#fErr').style.color = '#2fb26a' } else $('#fErr').style.color = ''
}
$('#fNew').onclick = async () => {
  const r = await pcCall('mkdir', { parent: fCur.id, name: 'Partoche' })
  if (r.error) { $('#fErr').textContent = 'pCloud : ' + r.error; $('#fErr').hidden = false; return }
  browse(r.id, 'Partoche')
}
$('#fUse').onclick = async () => {
  if (!fCur.id) return
  $('#fUse').disabled = true; $('#fUse').textContent = 'Préparation…'
  const r = await pcCall('useRoot', { folderid: fCur.id })
  $('#fUse').disabled = false
  if (r.error) { $('#fErr').textContent = 'pCloud : ' + r.error; $('#fErr').hidden = false; $('#fUse').textContent = `Utiliser « ${fCur.name} »`; return }
  showSummary(r); wizStep('done')
  busy('Chargement des partitions…'); native.requestFiles()
}
function showSummary(r) {
  const info = nativeInfo() || {}
  const cloud = info.storage === 'pcloud'
  $('#shPc').hidden = !cloud; $('#shLocal').hidden = cloud
  $('#shMyName2').value = G.myName || ''
  const sh = G.share || {}
  $('#lkShare').value = sh.link || ''; $('#lkPwd').value = sh.pwd || ''; $('#lkUpload').value = sh.upload || ''
  $('#lkState').hidden = true
  if (cloud) pcCall('links').then(l => {   // liens déjà créés dans pCloud ?
    if (l && l.link) $('#shPcInfo').innerHTML = `✅ Lien de partage déjà existant${l.upload ? ' et lien de dépôt aussi' : ''}. Mets le mot de passe voulu et touche « Créer les liens » pour préparer le message (rien n'est recréé).`
  })
  const line = (ok, label, extra) => `<div>${ok ? '✅' : '🆕'} <b>${label}</b> ${extra || ''}</div>`
  if (r) {
    const c = new Set(r.created || [])
    $('#sumBox').innerHTML = `<div class="muted small">Dossier <b>${esc(r.root)}</b> ${r.local ? 'sur la tablette' : 'sur pCloud'}</div>` +
      line(!c.has('MSCZ'), esc(r.scores.name), c.has('MSCZ') ? '— créé : mets-y tes fichiers .mscz' : `— ${r.scores.count} partition(s)`) +
      line(!c.has('MesNotes'), 'MesNotes + Settings', `— tes annotations, et à part tes réglages, ton agenda et ton temps de travail`) +
      line(!c.has('Prof'), esc(r.prof.name), c.has('Prof') ? '— créé : ton prof y déposera ses annotations' : `— ${r.prof.count} envoi(s) du prof`)
  } else $('#sumBox').innerHTML = `<div>✅ <b>${esc(info.rootFolder || 'Dossier configuré')}</b></div>`
  $('#shOut').hidden = true; $('#shErr').hidden = true
}
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
$('#shMake').onclick = async () => {
  const pwd = $('#shNewPwd').value.trim(), me = $('#shMyName').value.trim()
  const err = m => { $('#shErr').textContent = m; $('#shErr').hidden = !m }
  if (pwd.length < 6) return err('Choisis un mot de passe d’au moins 6 caractères.')
  err(''); $('#shMake').disabled = true; $('#shMake').textContent = 'Création…'
  const r = await pcCall('share', { password: pwd })
  $('#shMake').disabled = false; $('#shMake').textContent = 'Créer les liens'
  if (r.error) return err('pCloud : ' + r.error)
  if (me) { G.myName = me; saveGlobal() }
  G.share = { link: r.link, pwd, upload: r.upload }; saveGlobal(); syncShareToNative(); share = null; refreshGuest(true)
  showShareMessage(me, r.link, pwd, r.upload)
}
// mode « dossier de la tablette » : vérifier les liens collés
$('#lkCheck').onclick = async () => {
  const st = $('#lkState'); st.hidden = false; st.innerHTML = 'Vérification…'
  const link = $('#lkShare').value.trim(), pwd = $('#lkPwd').value, up = $('#lkUpload').value.trim(), me = $('#shMyName2').value.trim()
  const out = []
  let okShare = false
  try {
    const pf = new PublicFolder(link, pwd); await pf.list()
    const names = (pf.root.contents || []).filter(c => c.isfolder).map(c => c.name.toLowerCase())
    const n = pf.files(pf.root, c => /\.(mscz|mscx)$/i.test(c.name)).length
    okShare = true
    out.push(`✅ <b>Lien de partage</b> : dossier « ${esc(pf.root.name)} », ${n} partition(s) visibles` + (names.some(x => /^(mscz|partitions)$/.test(x)) ? '' : ' — ⚠ je ne vois pas de dossier MSCZ dedans : est-ce bien ton dossier Partoche ?'))
  } catch (e) { out.push('❌ <b>Lien de partage</b> : ' + esc(e.code === 2258 || e.code === 1125 ? 'mot de passe incorrect ou manquant' : e.message)) }
  let okUp = false
  if (up) {
    try {
      const ck = await checkUploadLink(up)
      if (ck.ok) { okUp = true; out.push(`✅ <b>Lien de dépôt</b> : dossier « ${esc(ck.folder || 'Prof')} »`) }
      else out.push('❌ <b>Lien de dépôt</b> : ' + esc(ck.error) + ' — pas le lien de partage.')
    } catch (e) { out.push('❌ <b>Lien de dépôt</b> : ' + esc(e.message)) }
  } else out.push('ℹ️ Sans lien de dépôt, ton prof pourra lire et annoter, mais ses annotations ne te parviendront pas.')
  st.innerHTML = out.map(x => `<div>${x}</div>`).join('')
  if (!okShare) return
  if (me) { G.myName = me; }
  G.share = { link, pwd, upload: okUp ? up : '' }; saveGlobal(); syncShareToNative(); share = null; refreshGuest(true)
  showShareMessage(me, link, pwd, okUp ? up : '')
}
function showShareMessage(me, link, pwd, upload) {
  const pr = G.profile || {}
  const code = packCode({ k: 'e', n: me || '', l: link, p: pwd, u: upload || '', e: pr.emoji, c: pr.color })
  $('#shMsg').textContent = `Bonjour ! Voici mes partitions sur Partoche 🎻
Ouvre ce lien sur ton ordi ou ton iPad, tout se règle tout seul :
${PAGE_URL}#${code}

(Si le lien ne marche pas : ouvre ${PAGE_URL}, « Mes élèves » → « Coller un code », et colle :
${code})

Ensuite, ouvre un morceau et passe en Stylo pour annoter : en revenant à la liste, c'est envoyé chez moi.`
  $('#shOut').hidden = false
}
$('#shCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#shMsg').textContent); toast('Copié') } catch { toast('Sélectionne le texte pour le copier') } }
$('#shSend').onclick = () => { try { native.shareText($('#shMsg').textContent) } catch { } }
$('#wizDone').onclick = () => { lsSet('mcsz:setupDone', true); closeWizard(); try { native.requestFiles() } catch { } }
$('#setWizard').onclick = () => openWizard(false)
$('#shWizard').onclick = () => openWizard(false, 'done')
$('#setPcLogout').onclick = async () => { if (!confirm('Déconnecter ton compte pCloud de Partoche ?')) return; await pcCall('logout'); lsSet('mcsz:setupDone', false); location.reload() }
// dossier de la tablette choisi depuis l'assistant
const _onInfoWiz = () => { }

function nativeInfo() { try { return native && native.getInfo ? JSON.parse(native.getInfo()) : null } catch { return null } }
function paintSettings(info) {
  info = info || nativeInfo()
  const web = !native
  $('#setWebNote').hidden = !web
  ;['#setPickScores', '#setPickSave', '#setResetSave', '#setPickRoot'].forEach(id => { $(id).hidden = web })
  $('#setRoot').textContent = info && info.rootFolder ? '✓ ' + info.rootFolder + (info.pcEmail && info.storage === 'pcloud' ? '  ·  ' + info.pcEmail : '') : (info && info.scoresFolder ? 'Dossiers choisis séparément (réglages avancés)' : 'Pas encore configuré')
  $('#setPcLogout').hidden = !(info && info.storage === 'pcloud')
  ;['#setWizard', '#shWizard'].forEach(id => { $(id).hidden = web })
  if (info) {
    $('#setScores').textContent = info.scoresFolder || 'Aucun dossier choisi'
    let sv = info.saveFolder || 'Choisis d’abord le dossier des partitions'
    if (info.scoresFolder || info.saveCustom) sv += info.saveWritable ? '  ·  ✓ écriture OK' : '  ·  ⚠ pas d’accès en écriture (rechoisis le dossier)'
    $('#setSave').textContent = sv
    $('#setResetSave').hidden = !info.saveCustom
    $('#cloudWarn').hidden = !(info.saveProvider && !info.saveLocal)
    if (info.saveLocal) $('#setSave').textContent += '  ·  📱 dossier de la tablette'
    $('#setVersion').textContent = 'Partoche ' + (info.version || '')
  } else {
    $('#setScores').textContent = folderName || 'Fichiers ouverts à la main'
    $('#setSave').textContent = 'Dans le navigateur'
  }
  $$('#setNames button').forEach(b => b.classList.toggle('on', b.dataset.v === G.names))
  $$('#setLayout button').forEach(b => b.classList.toggle('on', b.dataset.v === (G.layout || 'auto')))
  $('#setFollow').checked = !!G.follow
  $('#setFinger').checked = !!G.fingerScroll
  try { $('#setAutoLog').checked = native && native.getAutoLog ? native.getAutoLog() : false; $('#setAutoLog').disabled = !native } catch { }
  const sc = shareCfg()
  if (document.activeElement !== $('#shLink')) $('#shLink').value = sc.link || ''
  if (document.activeElement !== $('#shPwd')) $('#shPwd').value = sc.pwd || ''
  if (TEACHER) { $('#setScores').textContent = 'Partage pCloud de ' + ownerName() + ' (lecture seule)'; $('#setSave').textContent = 'Ici, et envoyées à ' + ownerName() }
  $$('#setRole button').forEach(b => b.classList.toggle('on', b.dataset.v === (ROLE || 'eleve')))
  $('#profReset').hidden = !TEACHER
  paintProfile()
  $('#profNote').textContent = TEACHER ? 'Tes élèves les voient à côté de ton prénom et sur tes annotations' : 'Ton prof les voit à côté de ton prénom et sur tes annotations'
  $('#setRole').closest('.setrow').hidden = !!SHARE.teacher
  $('#setRoleNote').textContent = TEACHER ? 'Tu vois les partitions de tes élèves (bouton « Élève » en haut de la liste)' : 'Tes partitions, tes annotations'
  $('#setDemo').checked = DEMO
  const n = lsGet('mcsz:recent', []).length
  $('#setHistCount').textContent = n ? `${n} partition${n > 1 ? 's' : ''} dans l’historique` : 'Vide'
}
function saveShareFields() {
  G.share = { link: $('#shLink').value.trim(), pwd: $('#shPwd').value }
  saveGlobal(); share = null; $('#shState').textContent = ''
  syncShareToNative()
}
;['#shLink', '#shPwd'].forEach(id => $(id).addEventListener('change', saveShareFields))
$('#shTest').onclick = async () => {
  saveShareFields()
  $('#shState').textContent = 'Connexion…'
  try {
    await connectShare()
    $('#shState').textContent = `✓ Connecté · ${guestDocs.size} partition(s) annotée(s) par ton prof`
    if (V) loadGuestLayer()
  } catch (e) { $('#shState').textContent = '⚠ ' + (e.code === 1125 || e.code === 2258 ? 'mot de passe incorrect' : e.message) }
}
function paintProfile() {
  const pr = G.profile || {}
  if (document.activeElement !== $('#profEmoIn')) $('#profEmoIn').value = pr.emoji || ''
  $('#profColIn').value = /^#[0-9a-f]{6}$/i.test(pr.color || '') ? pr.color : (TEACHER ? '#2f7de1' : '#9b3fc0')
}
// tous les emojis : on les génère à la demande à partir des plages Unicode
function emojiList() {
  const ranges = [[0x1F600, 0x1F64F], [0x1F90C, 0x1F9FF], [0x1F300, 0x1F5FF], [0x1F680, 0x1F6FF], [0x1FA70, 0x1FAFF], [0x2600, 0x26FF], [0x2700, 0x27BF]]
  const out = []
  const test = document.createElement('canvas').getContext('2d'); test.font = '20px sans-serif'
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) {
    const ch = String.fromCodePoint(c)
    if (/\p{Extended_Pictographic}/u.test(ch)) out.push(ch)
  }
  return out
}
$('#profEmoIn').addEventListener('input', debounce(() => { const v = $('#profEmoIn').value.trim(); if (v) setProfile({ emoji: v }) }, 500))
$('#profColIn').addEventListener('input', debounce(e => setProfile({ color: e.target.value }), 250))
$('#profEmoAll').onclick = () => {
  const g = $('#profEmoGrid')
  if (!g.hidden) { g.hidden = true; return }
  if (!g.childElementCount) for (const em of emojiList()) { const b = document.createElement('button'); b.textContent = em; b.onclick = () => { setProfile({ emoji: em }); g.hidden = true }; g.appendChild(b) }
  g.hidden = false
}
function setProfile(p) { G.profile = Object.assign(TEACHER ? { emoji: '🎼', color: '#2f7de1' } : { emoji: '🎻', color: '#9b3fc0' }, G.profile || {}, p); saveGlobal(); paintProfile(); if (TEACHER) { paintMe(); paintTeacherColor() } else writeSettings(); presSend(true) }
$('#setProfReset').onclick = async () => {
  if (!confirm('Se déconnecter ? Ton prénom, ta liste d’élèves, leurs mots de passe et les annotations gardées dans ce navigateur seront effacés (celles déjà envoyées restent chez tes élèves).')) return
  try { if (V && V.doc) await commitDoc() } catch { }
  try { Object.keys(localStorage).filter(k => k.startsWith('mcsz:') && k !== 'mcsz:role').forEach(k => localStorage.removeItem(k)) } catch { }
  try { await new Promise(r => { const q = indexedDB.deleteDatabase('mcsz-player'); q.onsuccess = q.onerror = q.onblocked = r }) } catch { }
  location.reload()
}
$$('#setRole button').forEach(b => b.onclick = () => {
  if (b.dataset.v === ROLE) return
  flushDoc(); lsSet('mcsz:role', b.dataset.v); location.reload()
})
$('#setDemo').onchange = e => { flushDoc(); setDemo(e.target.checked) }
function openSettings(welcome) {
  $('#welcome').hidden = !welcome
  paintSettings()
  $('#settings').hidden = false
}
// Nouveau dossier de sauvegarde : on y recopie tout (réglages + annotations gardées dans l'appli)
bridge.onSaveFolderChanged = async () => {
  settingsBody = ''; writeSettings()
  const keys = await idbKeys('mcsz:doc:')
  let n = 0
  for (const k of keys) {
    const d = await idbGet(k)
    if (!d || !d.ink || !Object.keys(d.ink).length) continue
    const rel = k.slice('mcsz:doc:'.length)
    queueFile(rel.replace(/[\\/]/g, ' ~ ') + '.json', pretty({ app: 'Partoche', file: rel, updated: d.updated || Date.now(), prefs: d.prefs || {}, ink: d.ink }))
    n++
  }
  if (V && V.doc) V.doc._body = null
  nlog('dossier de sauvegarde changé : ' + n + ' partition(s) recopiée(s)')
  toast(n ? `${n} partition(s) annotée(s) recopiée(s) dans le nouveau dossier` : 'Nouveau dossier de sauvegarde enregistré', 4000)
  try { native.requestFiles() } catch { }
}
bridge.onInfo = json => { try { const i = JSON.parse(json); paintSettings(i); _onInfoWiz(i) } catch { } }
$('#btnSettings').onclick = () => openSettings(false)
$('#setClose').onclick = () => { $('#settings').hidden = true }
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') $('#settings').hidden = true })
$('#setPickScores').onclick = () => native && native.pickFolder()
$('#setPickRoot').onclick = () => native && native.pickRootFolder && native.pickRootFolder()
bridge.onRootError = m => toast(m, 5000)
$('#setPickSave').onclick = () => native && native.pickSaveFolder()
$('#setResetSave').onclick = () => { if (native) { native.resetSaveFolder(); paintSettings(); saveSettingsFile() } }
$$('#setNames button').forEach(b => b.onclick = () => { G.names = b.dataset.v; saveGlobal(); paintSettings() })
$$('#setLayout button').forEach(b => b.onclick = () => { G.layout = b.dataset.v; saveGlobal(); paintSettings() })
$('#setFollow').onchange = e => { G.follow = e.target.checked; saveGlobal(); $('#btnFollow').classList.toggle('on', G.follow) }
$('#setFinger').onchange = e => { G.fingerScroll = e.target.checked; ink.fingerDraws = !G.fingerScroll; saveGlobal(); paintInkbar() }
$('#setResetColors').onclick = () => { G.palette = DEFAULT_PALETTE.slice(); G.color = G.palette[0]; ink.color = G.color; saveGlobal(); renderSwatches(); paintInkbar(); toast('Couleurs réinitialisées') }
$('#setClearHist').onclick = () => { lsSet('mcsz:recent', []); saveSettingsFile(); paintSettings(); renderLibrary(); toast('Historique effacé') }
$('#saveState').onclick = () => { openSettings(false); showLog(); setTimeout(() => $('#logView').scrollIntoView({ block: 'center' }), 50) }
function showLog() {
  const v = $('#logView')
  v.textContent = native && native.getLog ? (native.getLog() || '(vide)') : 'Journal disponible dans l’appli Android.'
  v.hidden = false
  v.scrollTop = v.scrollHeight
}
$('#logShow').onclick = () => { if (!$('#logView').hidden) { $('#logView').hidden = true; return } showLog() }
$('#logClear').onclick = () => { if (native && native.clearLog) native.clearLog(); if (!$('#logView').hidden) showLog(); toast('Journal effacé') }
$('#logToSave').onclick = () => { if (native && native.copyLogToSave) { native.copyLogToSave(); toast('Copie de !Log.txt dans le dossier de sauvegarde…') } }
$('#setAutoLog').onchange = e => { try { native && native.setAutoLog && native.setAutoLog(e.target.checked) } catch { } }
$('#logExport').onclick = () => { if (native && native.exportLog) native.exportLog() }
bridge.onLogExported = ok => toast(ok ? 'Journal exporté' : 'Export du journal impossible')
$('#setClearSounds').onclick = async () => { try { await caches.delete('mcsz-soundfonts-v1') } catch { } player.instruments.clear(); toast('Cache des sons vidé') }

// =====================================================================
//  APERÇU 30 s DEPUIS LA BIBLIOTHÈQUE (démarre au refrain si on le trouve)
// =====================================================================
let preview = null            // {entry, state: 'loading'|'playing', timer, btn}
const previewStart = new Map() // rel -> {t, how}
function paintPv(btn, state) {
  if (!btn) return
  btn.classList.toggle('loading', state === 'loading')
  btn.classList.toggle('playing', state === 'playing')
  btn.querySelector('use').setAttribute('href', state === 'playing' ? '#i-pause' : '#i-play')
}
function allPvButtons(entry) { return $$('.pv').filter(b => b._entry === entry) }
function stopPreview() {
  if (!preview) return
  const p = preview; preview = null
  clearTimeout(p.timer); clearInterval(p.tick)
  try { player.pause(); if (player.master && player.ctx) player.master.gain.setValueAtTime(0.8, player.ctx.currentTime) } catch { }
  allPvButtons(p.entry).forEach(b => { paintPv(b, null); b.style.removeProperty('--p') })
}
async function togglePreview(entry, btn) {
  if (preview && preview.entry === entry) { stopPreview(); return }
  stopPreview()
  const me = preview = { entry, state: 'loading' }
  allPvButtons(entry).forEach(b => paintPv(b, 'loading'))
  try {
    const bytes = await getBytes(entry)
    const mf = new MsczFile(bytes, entry.name)
    const W = await engine()
    const sc = await W.load('mscz', mf.build({ visible: mf.parts.map(() => true), names: 'off' }), [], false)
    const midi = parseMidi(await sc.saveMidi(true, true))
    sc.destroy()
    if (preview !== me) return
    const saved = await idbGet('mcsz:doc:' + (entry.rel || entry.name))
    const mix = saved && saved.prefs && Array.isArray(saved.prefs.mix) && saved.prefs.mix.length === mf.parts.length ? saved.prefs.mix : mf.parts.map(() => ({ volume: 1, muted: false, solo: false }))
    player.setScore(midi, mf.parts.length, makeTrackToPart(mf, midi), mix)
    player.rate = 1; player.setLoop(null)
    let st = previewStart.get(entry.rel || entry.name)
    if (!st) { st = findChorus(player.notes, player.duration); previewStart.set(entry.rel || entry.name, st) }
    await player.loadInstruments()
    if (preview !== me) return
    player.seek(st.t)
    player.ensureCtx()
    player.master.gain.setValueAtTime(0.8, player.ctx.currentTime)
    await player.play()
    me.state = 'playing'
    allPvButtons(entry).forEach(b => paintPv(b, 'playing'))
    toast(`♪ ${baseName(entry.name)} — ${st.how} (${fmt(st.t)})`, 3500)
    const LEN = 30, t0 = performance.now()
    const end = Math.min(LEN, Math.max(3, player.duration - st.t))
    me.tick = setInterval(() => { const pr = Math.min(1, (performance.now() - t0) / 1000 / end); allPvButtons(entry).forEach(b => b.style.setProperty('--p', pr)) }, 200)
    // fondu de sortie
    me.timer = setTimeout(() => {
      try { player.master.gain.setTargetAtTime(0, player.ctx.currentTime, 0.6) } catch { }
      me.timer = setTimeout(() => { if (preview === me) stopPreview() }, 2200)
    }, (end - 2) * 1000)
    player.onEnd = () => { if (preview === me) stopPreview() }
  } catch (e) {
    nlog('aperçu impossible : ' + (e.message || e))
    if (preview === me) { stopPreview(); toast('Aperçu impossible pour cette partition') }
  }
}

/**
 * Cherche le refrain : la phrase (~8 s) qui revient le plus souvent, en privilégiant
 * les passages denses/forts et en évitant l'intro. Sinon : le passage le plus dense.
 */
function findChorus(notes, duration) {
  const STEP = 0.5, L = 16           // fenêtres de 0,5 s, phrase de 8 s
  const n = Math.ceil(duration / STEP)
  if (n < L * 2 + 4) return { t: 0, how: 'début' }
  const chroma = Array.from({ length: n }, () => new Float32Array(12))
  const energy = new Float32Array(n)
  for (const x of notes) {
    const a = Math.floor(x.t / STEP), b = Math.min(n - 1, Math.floor((x.t + Math.min(x.d, 2)) / STEP))
    const w = x.vel / 127
    for (let i = a; i <= b; i++) { if (x.prog >= 0) chroma[i][x.key % 12] += w; energy[i] += w }
  }
  for (const c of chroma) { let m = 0; for (const v of c) m += v * v; m = Math.sqrt(m) || 1; for (let k = 0; k < 12; k++) c[k] /= m }
  const sim = (i, j) => { let s = 0; for (let k = 0; k < 12; k++) s += chroma[i][k] * chroma[j][k]; return s }
  const segE = new Float32Array(n)
  for (let i = 0; i + L <= n; i++) { let e = 0; for (let k = 0; k < L; k++) e += energy[i + k]; segE[i] = e }
  const maxE = Math.max(...segE) || 1
  const minStart = Math.floor(5 / STEP)
  let best = -1, bestScore = 0, bestReps = 0
  const lastStart = Math.max(minStart, Math.floor((duration - 25) / STEP))   // garder ~25 s d'écoute
  for (let s = minStart; s + L <= n && s <= lastStart; s += 2) {
    if (segE[s] < maxE * 0.35) continue
    let reps = 0
    for (let t = 0; t + L <= n; t += 2) {
      if (Math.abs(t - s) < L) continue
      let acc = 0
      for (let k = 0; k < L; k++) acc += sim(s + k, t + k)
      if (acc / L > 0.88) { reps++; t += L - 2 }
    }
    const score = reps * (0.6 + 0.4 * segE[s] / maxE)
    if (score > bestScore * 1.15) { bestScore = score; best = s; bestReps = reps }   // à score proche, la 1re apparition gagne
  }
  if (best >= 0 && bestReps >= 1) {
    // recule au début de la phrase (première fenêtre après un creux)
    let s = best
    for (let k = 0; k < 4 && s > minStart && energy[s - 1] >= energy[s] * 0.5; k++) s--
    return { t: s * STEP, how: 'refrain' }
  }
  let dense = 0
  for (let i = minStart; i + L <= n; i++) if (segE[i] > segE[dense]) dense = i
  return { t: dense * STEP, how: 'passage le plus riche' }
}

// ---------- accordeur ----------
let tuner = null
function openTuner() {
  stopPreview()
  if (player.playing) { player.pause(); setPlayIcon(false) }
  if (!tuner) tuner = new Tuner($('#tuner'), { get: () => G.tuner || {}, set: v => { G.tuner = v; saveGlobal() } })
  $('#tuner').hidden = false
  if (native && native.keepScreenOn) try { native.keepScreenOn(true) } catch { }
  tuner.start()
}
function closeTuner() {
  $('#tuner').hidden = true
  if (tuner) tuner.stop()
  if (native && native.keepScreenOn) try { native.keepScreenOn($('#viewer').classList.contains('active')) } catch { }
}
$('#btnTuner').onclick = openTuner
$('#btnTunerLib').onclick = openTuner
$('#tunerClose').onclick = closeTuner

// iPad / iPhone : le son ne peut démarrer que pendant un geste -> on « réveille » l'audio au premier toucher
document.addEventListener('pointerdown', function unlockAudio() {
  try { const c = player.ensureCtx(); if (c.state !== 'running') c.resume() } catch { }
  document.removeEventListener('pointerdown', unlockAudio, true)
}, true)
// stockage du navigateur : demander qu'il ne soit pas effacé (annotations, élèves, mots de passe)
try { navigator.storage && navigator.storage.persist && navigator.storage.persist() } catch { }

// numéro de version, à côté de l'engrenage
$('#appVer').textContent = window.PARTOCHE_VERSION ? 'v' + window.PARTOCHE_VERSION : ''
{ const sv = document.querySelector('.spver'); if (sv && window.PARTOCHE_VERSION) sv.textContent = 'version ' + window.PARTOCHE_VERSION }

// écran d'accueil
setTimeout(() => { const sp = $('#splash'); if (sp) { sp.classList.add('out'); setTimeout(() => sp.remove(), 600) } }, 2400)

const needOnboard = !lsGet('mcsz:onboarded', false) && !SHARE.teacher
if (needOnboard) openOnboard()
else {
  setupLibrary()
  if (lsGet('mcsz:tutoPending', false)) setTimeout(() => startTour('lib'), 2200)
  // premier lancement : on demande le dossier
  // élève : assistant de configuration obligatoire la première fois
  if (native && !TEACHER && !DEMO && !lsGet('mcsz:setupDone', false)) openWizard(true)
}
// préchargement du moteur MuseScore en arrière-plan
setTimeout(() => engine().catch(() => { }), 300)

// ---- obtenir d'autres partitions (LibreScore) / la prof envoie une partition à l'élève ----
function openMore() {
  const dir = TEACHER ? '' : ((nativeInfo() || {}).storage === 'pcloud' ? 'Partoche / MSCZ' : 'MSCZ')
  $('#moreSend').hidden = !TEACHER
  $('#moreWhere').innerHTML = TEACHER
    ? 'Télécharge la partition (.mscz), puis <b>Envoyer à ' + esc(ownerName()) + '</b> : elle arrive dans son dossier de partitions.'
    : 'Mets les fichiers <b>.mscz</b> téléchargés dans ton dossier <b>' + dir + '</b> (dans pCloud) : ils apparaissent ici après <b>Actualiser</b>, et ton prof les voit aussi.'
  $('#moreDlg').hidden = false
}
$('#btnMore').onclick = openMore
$('#moreClose').onclick = () => { $('#moreDlg').hidden = true }
$('#moreFile').onchange = async e => {
  const list = [...e.target.files]; e.target.value = ''
  const st = curStudent(); if (!list.length || !st) return
  if (!st.upload) { toast('Il faut le lien de dépôt de ' + st.name + ' (Mes élèves → ✎)', 5000); return }
  let ok = 0
  for (const f of list) {
    busy('Envoi de « ' + f.name + ' » à ' + st.name + '…')
    try { await uploadToLink(st.upload, myName(), f.name, f); ok++ } catch (err) { toast('« ' + f.name + ' » : ' + err.message, 6000) }
  }
  busy(false)
  if (ok) {
    $('#moreDlg').hidden = true; toast('✓ ' + (ok > 1 ? ok + ' partitions envoyées' : 'Partition envoyée') + ' à ' + st.name, 5000)
    presPingTo(st.link, { ev: 'score' })   // l'appli de l'élève la range tout de suite
    setTimeout(() => { share = null; teacherLibrary() }, 2500)
  }
}

// ---- sauvegarde / restauration de la liste d'élèves (prof) ----
$('#stExport').onclick = () => {
  const data = { app: 'Partoche', kind: 'eleves', saved: new Date().toISOString(), me: lsGet('mcsz:me', ''), profile: G.profile || null, students: students(), code: studentsCode() }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const d = new Date(), p = n => String(n).padStart(2, '0')
  a.download = `Partoche-eleves-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  toast('💾 Sauvegarde téléchargée (elle contient les mots de passe : garde-la pour toi)', 5000)
}
$('#stImport').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return
  try {
    const txt = await f.text()
    if (/P1\./.test(txt) && !/^\s*\{/.test(txt)) {
      const r = applyCode(unpackCode(txt)); if (!r) throw new Error('code illisible')
      toast(`✓ ${r.add} élève(s) ajouté(s), ${r.upd} mis à jour`, 4000); renderStudents(); paintStudentBtn(); refreshStudentCards(); return
    }
    const d = JSON.parse(txt)
    if (!d || !Array.isArray(d.students)) throw new Error('ce n’est pas une sauvegarde Partoche')
    const l = students(); let add = 0, upd = 0
    for (const s of d.students) {
      if (!s || !s.link) continue
      const i = l.findIndex(x => x.id === s.id || parseLinkCode(x.link) === parseLinkCode(s.link))
      if (i >= 0) { l[i] = { ...l[i], ...s, id: l[i].id }; upd++ } else { l.push({ ...s, id: s.id || 's' + Date.now() + add }); add++ }
    }
    saveStudents(l)
    if (d.me && !lsGet('mcsz:me', '')) { lsSet('mcsz:me', d.me); $('#stMe').value = d.me }
    if (d.profile && !G.profile) { G.profile = d.profile; saveGlobal(); paintMe() }
    renderStudents(); paintStudentBtn(); refreshStudentCards()
    toast(`✓ Sauvegarde restaurée : ${add} élève(s) ajouté(s), ${upd} mis à jour`, 5000)
    if (!share) teacherLibrary()
  } catch (err) { toast('Restauration impossible : ' + err.message, 6000) }
}

if (_codeMsg) setTimeout(() => toast(_codeMsg, 6000), 1200)
// coller un code (invitation d'un élève ou sauvegarde)
$('#stPaste').onclick = () => promptText('Colle le code reçu', '', t => {
  const r = applyCode(unpackCode(t))
  if (!r) { toast('Code illisible : il doit commencer par P1.', 5000); return }
  toast(`✓ ${r.add} élève(s) ajouté(s), ${r.upd} mis à jour`, 4000)
  $('#stMe').value = lsGet('mcsz:me', '') || ''; G.profile = (lsGet('mcsz:global', {}) || {}).profile || G.profile
  paintMe(); renderStudents(); paintStudentBtn(); refreshStudentCards(); share = null; teacherLibrary()
}, 'P1.…')
$('#stCopyCode').onclick = async () => {
  const c = studentsCode()
  try { await navigator.clipboard.writeText(c); toast('📋 Code de sauvegarde copié : colle-le dans une note ou un mail à toi-même', 5000) }
  catch { promptText('Ton code de sauvegarde (copie-le)', c, () => { }) }
}

// ---- partitions reçues du prof : fenêtre « Nouveau » ----
function showNewScores(list) {
  const box = $('#newList'); box.innerHTML = ''
  const who = [...new Set(list.map(x => x.who))].join(', ')
  $('#newTitle').textContent = '🎼 ' + who + (list.length > 1 ? ' t’a envoyé ' + list.length + ' partitions' : ' t’a envoyé une partition')
  for (const x of list) {
    const e = files.find(f => f.name === x.name || f.rel === x.name)
    const b = document.createElement('button'); b.className = 'newitem'
    b.innerHTML = '<span class="tag t-new">Nouveau</span><b></b><span class="muted">Ouvrir ›</span>'
    b.querySelector('b').textContent = x.name.replace(/\.(mscz|mscx)$/i, '')
    b.onclick = () => { $('#newDlg').hidden = true; if (e) openScore(e); else toast('Pas encore dans la liste : touche ⟳ Actualiser') }
    box.appendChild(b)
  }
  $('#newDlg').hidden = false
}
$('#newClose').onclick = () => { $('#newDlg').hidden = true }
// prof : relit régulièrement la config de l'élève (tags, emoji)
setInterval(() => { if (TEACHER && share && !document.hidden && $('#library').classList.contains('active') && curStudent()) loadStudentProfile(curStudent()) }, 60000)


// =====================================================================
//  TEMPS DE TRAVAIL (appli de l'élève) — Settings/!Travail.json, lu par la page du prof
//  par jour et par partition : t = secondes avec la partition ouverte (appli au premier plan),
//  a = dont secondes « actives » (toucher, stylo ou lecture dans les 5 dernières minutes)
// =====================================================================
const WORK_FILE = '!Travail.json'
const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
let work = null, workDirty = false, workWrote = 0, workTick = Date.now(), lastAct = Date.now()
if (!TEACHER && !DEMO) {
  work = parseJ(nRead(WORK_FILE)) || lsGet('mcsz:work', null) || {}
  work = Object.assign({ app: 'Partoche', v: 1, days: {}, last: null, seen: 0 }, work)
  // total cumulé par partition (les jours ne sont gardés que 35 jours) : la première fois, on part de ce qu'on a
  if (!work.tot) { work.tot = {}; for (const d of Object.values(work.days)) for (const [k, x] of Object.entries(d)) work.tot[k] = (work.tot[k] || 0) + (x.t || 0) }
  ;['pointerdown', 'keydown', 'wheel'].forEach(ev => addEventListener(ev, () => { const was = Date.now() - lastAct; lastAct = Date.now(); if (was > 600000) setTimeout(() => workStep(), 10) }, { passive: true, capture: true }))
  setInterval(workStep, 15000)
  document.addEventListener('visibilitychange', () => { workStep(); if (document.hidden) workSave(true) })
  setTimeout(() => { work.seen = Date.now(); workDirty = true; workSave(true) }, 4000)
}
// Séances : heure d'ouverture et de fermeture de chaque partition (à la seconde près).
// Pendant la séance, un « battement » toutes les 15 s met à jour l'heure de fin (si l'appli est tuée, on perd au plus 15 s).
// Une séance s'arrête en fermant la partition, en quittant l'appli ou en mettant la tablette en veille.
let sess = null   // { s, a, b, i (secondes « sans y toucher ») }
function workStep(closing) {
  const now = Date.now(), dt = Math.max(0, Math.min(30, (now - workTick) / 1000)); workTick = now
  if (!work) return
  const onScore = V && V.entry && $('#viewer').classList.contains('active') && !V.entry.demo && !document.hidden
  const rel = onScore ? (V.entry.rel || V.entry.name) : null
  if (!document.hidden) { work.seen = now; workDirty = true }
  if (player.playing) lastAct = now
  const idle = now - lastAct
  // séance en cours sur une autre partition (ou plus de partition), ou 10 min sans rien toucher : on la termine
  if (sess && (closing || sess.s !== rel || idle > 600000)) { sess.b = Math.min(now, Math.max(sess.a, idle > 600000 ? lastAct + 600000 : now)); endSession() }
  // écran allumé tant qu'on travaille ; après 20 min sans toucher, la tablette peut se mettre en veille
  if (rel && native && native.keepScreenOn) { const on = idle < 1200000; if (on !== workScreen) { workScreen = on; try { native.keepScreenOn(on) } catch { } } }
  if (!rel || closing) { workSave(closing); return }
  if (idle > 600000) { workSave(); return }   // tablette posée, partition ouverte : on ne compte plus
  if (!sess) sess = { s: rel, a: now, b: now, i: 0 }
  const d = work.days[dayKey()] = work.days[dayKey()] || {}
  const x = d[rel] = d[rel] || { t: 0, a: 0 }
  x.t += dt
  work.tot[rel] = Math.round(((work.tot[rel] || 0) + dt) * 10) / 10
  if (idle < 300000) x.a += dt; else sess.i += dt
  sess.b = now
  work.last = { t: now, s: rel }
  lsSet('mcsz:work', work); lsSet('mcsz:sess', sess)   // copie locale à chaque battement
  workSave()
}
let workScreen = true
function endSession() {
  if (!sess) return
  if (sess.b - sess.a >= 5000) {   // on ignore les ouvertures de moins de 5 s
    work.sessions = (work.sessions || []).concat([{ s: sess.s, a: sess.a, b: sess.b, i: Math.round(sess.i) }]).slice(-400)
  }
  sess = null; lsSet('mcsz:sess', null); workDirty = true
}
// séance restée ouverte (appli tuée) : on la clôt à son dernier battement
if (!TEACHER && !DEMO && work) { const o = lsGet('mcsz:sess', null); if (o && o.s) { sess = o; endSession(); workSave(true) } }
addEventListener('pagehide', () => { try { workStep(true) } catch { } })
function workSave(force) {
  if (!work || !workDirty) return
  if (!force && Date.now() - workWrote < 180000) return   // pCloud : au plus une écriture toutes les 3 min
  const keep = Object.keys(work.days).sort().slice(-35); for (const k of Object.keys(work.days)) if (!keep.includes(k)) delete work.days[k]
  workDirty = false; workWrote = Date.now()
  lsSet('mcsz:work', work)
  queueFile(WORK_FILE, pretty(work))
}

// =====================================================================
//  PRÉSENCES DES ÉLÈVES (page du prof) — en ligne maintenant + temps de travail des 7 derniers jours
// =====================================================================
const fmtDur = s => { s = Math.round(s || 0); if (s < 60) return s ? '< 1 min' : '—'; const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') }
const fmtAgo = t => { if (!t) return 'jamais vu'; const s = (Date.now() - t) / 1000; if (s < 120) return 'à l’instant'; if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min'; if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h'; const j = Math.round(s / 86400); return 'il y a ' + j + ' jour' + (j > 1 ? 's' : '') }
const last7 = () => { const out = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push(d) } return out }
const dowS = d => d.toLocaleDateString(LOC, { weekday: 'short' }).replace(/\.$/, ''), dowN = d => d.toLocaleDateString(LOC, { weekday: 'narrow' })
const studentData = new Map()   // id -> { work, tags, err, at }
async function loadStudentData(st) {
  try {
    const pf = new PublicFolder(st.link, st.pwd); await pf.list()
    const find = n => pf.files(pf.root, c => c.name.toLowerCase() === n.toLowerCase())[0]
    const fw = find(WORK_FILE), fs = find('!Settings.json'), fc = find(COURS_FILE) || find(OLD_FILE), fq = find('!Demandes.json')
    if (fq) { try { const q = parseJ(await pf.text(fq.meta.fileid)); asksBy.set(st.id, (q && q.asks) || []); paintAsks() } catch { } }
    // mon dernier envoi d'agenda à cet élève (dans son dossier Prof)
    let fp = null
    for (const x of pf.files(pf.root, c => /\.json$/i.test(c.name))) { const d = parseAnyDrop(x.meta.name); if (d && isAgendaDoc(d.doc) && d.who.toLowerCase() === myName().toLowerCase() && (!fp || d.stamp > fp.stamp)) fp = { ...x, stamp: d.stamp } }
    const rd = x => x ? pf.text(x.meta.fileid).then(parseJ).catch(() => null) : null
    const [w, s, c, p] = await Promise.all([rd(fw), rd(fs), rd(fc), rd(fp)])
    const scoresDir = (pf.root.contents || []).find(x => x.isfolder && /^mscz$/i.test(x.name)) || pf.root
    const scores = pf.files(scoresDir, x => /\.(mscz|mscx)$/i.test(x.name)).map(x => x.rel).filter(r => !/(^|\/)files from /i.test(r))
    const o = { work: w, tags: (s && s.global && s.global.tags) || {}, scores, at: Date.now() }
    coursAbsorb(st, c, p)
    if (s && s.global && s.global.profile) adoptStudentLook(st, { e: s.global.profile.emoji, c: s.global.profile.color })
    studentData.set(st.id, o); return o
  } catch (e) { const o = { err: e.message, at: Date.now() }; studentData.set(st.id, o); return o }
}
const weekSecs = w => last7().reduce((n, d) => n + Object.values((w && w.days && w.days[dayKey(d)]) || {}).reduce((a, x) => a + (x.t || 0), 0), 0)
function presBars(st, w) {
  const col = st.color || '#4f8cff'
  const vals = last7().map(d => ({ d, s: Object.values((w && w.days && w.days[dayKey(d)]) || {}).reduce((a, x) => a + (x.t || 0), 0) }))
  const max = Math.max(1800, ...vals.map(v => v.s))
  return '<div class="pbars">' + vals.map(v => `<div class="pbar" title="${dowS(v.d)} ${v.d.getDate()} : ${fmtDur(v.s)}"><i style="height:${v.s ? Math.max(6, Math.round(v.s / max * 100)) : 0}%;background:${col}"></i><span>${dowN(v.d)}</span></div>`).join('') + '</div>'
}
function renderPresList() {
  const box = $('#presList'); box.innerHTML = ''
  for (const st of students()) {
    const data = studentData.get(st.id), w = data && data.work, on = presOf.get(st.id)
    const r = document.createElement('button'); r.className = 'presrow' + (presSel === st.id ? ' on' : '')
    r.style.setProperty('--sc', st.color || '#7a7f8c')
    const status = on ? '<span class="pon">● en ligne</span>' : (data ? (data.err ? '<span class="muted">pCloud injoignable</span>' : '<span class="muted">vu ' + fmtAgo(w && (w.seen || (w.last && w.last.t))) + '</span>') : '<span class="muted">…</span>')
    r.innerHTML = `<span class="pemo">${esc(st.emoji || (st.name || '?').charAt(0).toUpperCase())}</span><span class="pname"><b>${esc(st.name)}</b>${status}</span>${presBars(st, w)}<span class="pweek"><b>${fmtDur(weekSecs(w))}</b><small>7 jours</small></span>`
    r.onclick = () => { presSel = presSel === st.id ? null : st.id; renderPresList() }
    box.appendChild(r)
    if (presSel === st.id) box.appendChild(presDetail(st, data))
  }
  if (!students().length) box.innerHTML = '<p class="muted">Ajoute d’abord tes élèves (Mes élèves).</p>'
  paintPresBtn()
}
let presSel = null
function presDetail(st, data) {
  const d = document.createElement('div'); d.className = 'presdet'
  const w = data && data.work
  if (!data) { d.innerHTML = '<p class="muted">Chargement…</p>'; return d }
  if (data.err) { d.innerHTML = '<p class="muted">Impossible de lire le dossier de ' + esc(st.name) + ' : ' + esc(data.err) + '</p>'; return d }
  if (!w) { d.innerHTML = '<p class="muted">Pas encore de temps de travail : il faut la version 4.0 (ou plus) de l’appli sur la tablette de ' + esc(st.name) + '.</p>'; return d }
  const tags = data.tags || {}
  const lastS = w.last && w.last.s ? baseName(w.last.s.split('/').pop()) : ''
  let h = `<div class="pdlast">Dernière connexion : <b>${w.seen ? new Date(w.seen).toLocaleString(LOC, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—'}</b>${lastS ? ` · dernière partition : <b>${esc(lastS)}</b>` : ''}</div>`
  // à bosser : partitions taguées Nouveau / À faire / En cours, avec leur temps sur 7 jours
  const per = {}; for (const day of last7()) for (const [k, x] of Object.entries((w.days || {})[dayKey(day)] || {})) { per[k] = per[k] || { t: 0, a: 0 }; per[k].t += x.t || 0; per[k].a += x.a || 0 }
  const todo = Object.entries(tags).filter(([, t]) => ['new', 'todo', 'wip'].includes(t))
  if (todo.length) {
    h += '<h4>À bosser (7 jours)</h4><div class="pdtodo">' + todo.sort((a, b) => (per[b[0]] || {}).t - (per[a[0]] || {}).t || 0).map(([k, t]) => {
      const p = per[k]
      return `<div class="pdrow${p ? '' : ' none'}">${tagPill(t)}<span>${esc(baseName(k.split('/').pop()))}</span><b>${p ? fmtDur(p.t) : 'pas travaillée'}</b>${p && p.t - p.a > 60 ? `<small>dont ${fmtDur(p.t - p.a)} sans y toucher</small>` : ''}</div>`
    }).join('') + '</div>'
  }
  h += '<h4>Jour par jour</h4><div class="pddays">'
  for (const day of last7().reverse()) {
    const e = Object.entries((w.days || {})[dayKey(day)] || {}).sort((a, b) => b[1].t - a[1].t)
    const tot = e.reduce((n, [, x]) => n + x.t, 0)
    h += `<div class="pdday${tot ? '' : ' none'}"><span class="pdd">${dowS(day)} ${day.getDate()}</span><b>${fmtDur(tot)}</b><span class="pdscores">${e.map(([k, x]) => `<span class="pdchip">${tags[k] ? tagPill(tags[k]) : ''}${esc(baseName(k.split('/').pop()))} · ${fmtDur(x.t)}</span>`).join('')}</span></div>`
    const d0 = new Date(day); d0.setHours(0, 0, 0, 0); const d1 = d0.getTime() + 86400000
    const ss = (w.sessions || []).filter(x => x.a >= d0.getTime() && x.a < d1)
    if (ss.length) h += '<div class="pdsess">' + ss.map(x => `<span>${fmtLTime(new Date(x.a))} → ${fmtLTime(new Date(x.b))} · <b>${esc(baseName(x.s.split('/').pop()))}</b> · ${fmtDur((x.b - x.a) / 1000)}${x.i > 60 ? ` <i>(dont ${fmtDur(x.i)} sans y toucher)</i>` : ''}</span>`).join('') + '</div>'
  }
  d.innerHTML = h + '</div><p class="muted small">Chaque séance : heure d’ouverture → heure de fermeture de la partition (appli au premier plan ; une mise en veille coupe la séance). « Sans y toucher » = plus de 5 min sans toucher l’écran ni écouter.</p>'
  return d
}
async function openPresences() {
  $('#presDlg').hidden = false
  renderPresList()
  await Promise.all(students().map(async st => {
    const [, o] = await Promise.all([loadStudentData(st), st.link ? presPollTopic(presTopicFor(st.link)) : null])
    if (o) presOf.set(st.id, o); else presOf.delete(st.id)
    if (!$('#presDlg').hidden) renderPresList()
  }))
}
function paintPresBtn() {
  const n = students().filter(st => presOf.has(st.id)).length
  const b = $('#presCount'); if (!b) return
  b.hidden = !n; b.textContent = n
}
if (TEACHER) {
  $('#btnPres').hidden = false
  $('#btnPres').onclick = openPresences
  $('#presClose').onclick = () => { $('#presDlg').hidden = true }
  $('#presRefresh').onclick = () => { studentData.clear(); openPresences() }
  // sonde la présence de tous les élèves (pastille du bouton), toutes les 60 s
  const sweep = async () => {
    if (document.hidden) return
    for (const st of students()) { if (!st.link) continue; const o = await presPollTopic(presTopicFor(st.link)); if (o) presOf.set(st.id, o); else presOf.delete(st.id) }
    paintPresBtn(); if (!$('#presDlg').hidden) renderPresList()
  }
  setTimeout(sweep, 3000); setInterval(sweep, 60000)
}

// ---- langue de la page web (FR / EN / 한국어) ; l'appli Android reste en français ----
langPicker($('#langSel')); $('#langRow').hidden = !!native
translateDom(document.body)
document.querySelectorAll('a[href$="/guide.html"]').forEach(a => { a.href = a.href.replace(/guide\.html$/, guideUrl()) })


// =====================================================================
//  COURS & AGENDA — chaque côté écrit son fichier, lit celui de l'autre :
//   élève : Settings/!Agenda.json      prof : « <Prof> - !Agenda - <date>.json » via le lien de dépôt
//   un cours : { id, start 'AAAA-MM-JJTHH:MM', dur (min), ok:{e,p}, by, cancel, from, hw:{text,scores,at}, upd }
//   fusion : pour chaque id, la version la plus récente (upd) gagne. Confirmé quand ok.e && ok.p.
// =====================================================================
// fichier agenda à part, des deux côtés (anciens noms !Cours… encore lus)
var COURS_FILE = '!Agenda.json', COURS_DOC = '!Agenda', OLD_FILE = '!Cours.json', OLD_DOC = '!Cours.mscz'
const isAgendaDoc = d => d === COURS_DOC + '.json' || d === OLD_DOC + '.json'
const p2 = n => String(n).padStart(2, '0')
const isoOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
const dOf = s => new Date(s)
const lEnd = l => new Date(dOf(l.start).getTime() + (l.dur || 60) * 60000)
const lStatus = l => l.cancel ? 'cancel' : (l.ok && l.ok.e && l.ok.p) ? 'ok' : 'wait'
const ME = TEACHER ? 'p' : 'e', OTHER = TEACHER ? 'e' : 'p'
// fusion prof / élève avec « propriétaires » : l'acceptation de l'élève vient de son fichier, celle du prof
// et le travail à faire (hw) viennent du fichier du prof ; si l'horaire a changé, la version la plus récente gagne
const lKey = l => l.start + '|' + (l.dur || 60) + '|' + !!l.cancel
function coursMergeOwned(profList, eleveList) {
  const P = new Map((profList || []).map(x => [x.id, x])), E = new Map((eleveList || []).map(x => [x.id, x]))
  const out = []
  for (const id of new Set([...P.keys(), ...E.keys()])) {
    const p = P.get(id), e = E.get(id)
    if (!p || !e) { out.push(p || e); continue }
    let r
    if (lKey(p) !== lKey(e)) r = { ...((e.upd || 0) > (p.upd || 0) ? e : p) }
    else r = { ...p, ok: { e: !!(e.ok && e.ok.e), p: !!(p.ok && p.ok.p) }, upd: Math.max(p.upd || 0, e.upd || 0) }
    if (p.hw && (!r.hw || (p.hw.at || 0) >= (r.hw.at || 0))) r.hw = p.hw   // le travail à faire : c'est le prof qui a raison
    out.push(r)
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}
function coursMerge(...lists) {
  const m = new Map()
  for (const l of lists) for (const x of (l || [])) { if (!x || !x.id) continue; const c = m.get(x.id); if (!c || (x.upd || 0) > (c.upd || 0)) m.set(x.id, x) }
  return [...m.values()].sort((a, b) => a.start.localeCompare(b.start))
}
const fmtLDay = d => d.toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' })
const fmtLTime = d => d.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' })
const fmtLesson = l => fmtLDay(dOf(l.start)) + ' · ' + fmtLTime(dOf(l.start)) + '–' + fmtLTime(lEnd(l))
function waitLabel(l, otherName) {
  const st = lStatus(l)
  if (st === 'cancel') return '✕ Annulé'
  if (st === 'ok') return '✓ Confirmé'
  return l.ok[ME] ? '⏳ En attente de ' + otherName : '❓ À toi de confirmer'
}

// ---------- côté prof ----------
const coursBy = new Map()   // id élève -> liste fusionnée
function coursLocal(st) { return lsGet('mcsz:cours:' + st.id, []) }
function coursAbsorb(st, studentFile, myDrop) {
  if (!TEACHER) return
  const before = JSON.stringify(coursBy.get(st.id) || coursLocal(st))
  const l = coursMergeOwned(coursMerge(coursLocal(st), myDrop && myDrop.lessons), studentFile && studentFile.lessons)
  coursBy.set(st.id, l); lsSet('mcsz:cours:' + st.id, l)
  if (JSON.stringify(l) !== before) paintAgenda()
}
async function coursSendProf(st, list, quiet) {
  coursBy.set(st.id, list); lsSet('mcsz:cours:' + st.id, list); paintAgenda()
  if (!st.upload) { if (!quiet) toast('Il faut le lien de dépôt de ' + st.name + ' pour lui envoyer l’agenda', 5000); return }
  try {
    await uploadToLink(st.upload, myName(), dropName(myName(), COURS_DOC + '.json'), pretty({ app: 'Partoche', kind: 'agenda', author: myName(), updated: Date.now(), lessons: list, dispo: dispoFor(st) }))
    if (!quiet) toast('📅 Envoyé à ' + st.name + ' ✓', 2500)
    presPingTo(st.link, { ev: 'agenda' })
  } catch (e) { if (!quiet) toast('Envoi de l’agenda impossible (' + e.message + ')', 6000) }
  if (!quiet) pushDispoOthers(st.id)   // ses autres élèves voient le créneau devenir « occupé »
}
function allLessons() {
  const out = []
  for (const st of students()) for (const l of (coursBy.get(st.id) || coursLocal(st))) out.push({ l, st })
  return out.sort((a, b) => a.l.start.localeCompare(b.l.start))
}

// ---------- côté élève ----------
let coursMine = null
if (!TEACHER && !DEMO) {
  const onDisk = parseJ(nRead(COURS_FILE)) || parseJ(nRead(OLD_FILE))
  coursMine = coursMerge((onDisk || {}).lessons, (lsGet('mcsz:cours', null) || {}).lessons || lsGet('mcsz:cours', [])) 
  // fichier absent (nouveau dossier, ancien nom…) : on le réécrit pour que le prof le voie
  if (coursMine.length && !parseJ(nRead(COURS_FILE))) setTimeout(() => queueFile(COURS_FILE, pretty({ app: 'Partoche', kind: 'agenda', updated: Date.now(), lessons: coursMine })), 3000)
}
function coursSaveStudent(list) {
  coursMine = list; lsSet('mcsz:cours', list)
  queueFile(COURS_FILE, pretty({ app: 'Partoche', kind: 'agenda', updated: Date.now(), lessons: list }))
  paintAgenda()
  setTimeout(() => presPing({ ev: 'agenda' }), 8000)   // le temps que la file d'attente écrive le fichier
}
async function coursSyncStudent() {
  if (TEACHER || !coursMine || !share) return
  const g = guestDocs.get(COURS_DOC + '.json') || guestDocs.get(OLD_DOC + '.json'); if (!g) return
  const d = await shareJson(g.meta); if (!d || !d.lessons) return
  if (d.dispo) lsSet('mcsz:profDispo', d.dispo)
  const merged = coursMergeOwned(d.lessons, coursMine)
  if (JSON.stringify(merged) !== JSON.stringify(coursMine)) {
    const seen = lsGet('mcsz:coursSeen', {})
    const fresh = merged.filter(l => !l.cancel && !l.ok.e && (seen[l.id] || 0) < (l.upd || 0))
    coursSaveStudent(merged)
    if (fresh.length) toast('📅 ' + (g.who || 'Ton prof') + ' te propose un cours : ' + fmtLesson(fresh[0]), 7000)
  }
  coursHomework()
}
function coursWho() { return TEACHER ? null : ((guestDocs.get(COURS_DOC + '.json') || guestDocs.get(OLD_DOC + '.json') || {}).who || (pres.other && pres.other.n) || 'ton prof') }

// ---------- actions communes ----------
function lessonsFor(st) { return TEACHER ? (coursBy.get(st.id) || coursLocal(st)) : (coursMine || []) }
function commitLessons(st, list) { if (TEACHER) coursSendProf(st, list); else coursSaveStudent(list) }
// élève : prévenir le prof par un vrai message (WhatsApp, SMS, mail…), car sa page peut être fermée
function offerNotify(text) {
  if (TEACHER || !native || !native.shareText) return
  $('#ntTxt').textContent = text
  $('#ntDlg').hidden = false
  $('#ntSend').onclick = () => { $('#ntDlg').hidden = true; try { native.shareText(text + '\n' + PAGE_URL) } catch { } }
  $('#ntLater').onclick = () => { $('#ntDlg').hidden = true }
}
const profName = () => coursWho() || 'ton prof'
function lessonAct(st, id, fn) {
  const list = lessonsFor(st).map(x => ({ ...x, ok: { ...(x.ok || {}) } }))
  const l = list.find(x => x.id === id); if (!l) return
  fn(l); l.upd = Date.now()
  if (!TEACHER) { const s = lsGet('mcsz:coursSeen', {}); s[l.id] = l.upd; lsSet('mcsz:coursSeen', s) }
  commitLessons(st, list)
}
function proposeSeries(st, starts, dur, step) {
  const ser = 's' + Date.now().toString(36), t = Date.now()
  const ls = starts.map((start, i) => ({ id: ser + '-' + i, series: ser, step, start, dur: +dur || 60, by: ME, ok: { [ME]: true, [OTHER]: false }, upd: t }))
  commitLessons(st, coursMerge(lessonsFor(st), ls))
}
function proposeLesson(st, start, dur) {
  const l = { id: 'c' + Date.now().toString(36), start, dur: +dur || 60, by: ME, ok: { [ME]: true, [OTHER]: false }, upd: Date.now() }
  commitLessons(st, coursMerge(lessonsFor(st), [l]))
}

// ---------- fenêtre « proposer / déplacer » ----------
function lessonForm({ st, lesson, start }) {
  const dlg = $('#lessonDlg')
  $('#lfTitle').textContent = lesson ? 'Proposer un autre horaire' : 'Proposer un cours'
  const sel = $('#lfStudent'); sel.innerHTML = ''
  $('#lfStudentRow').hidden = !TEACHER || !!lesson
  if (TEACHER) for (const s of students()) { const o = document.createElement('option'); o.value = s.id; o.textContent = (s.emoji ? s.emoji + ' ' : '') + s.name; sel.appendChild(o) }
  if (st) sel.value = st.id
  const d = lesson ? dOf(lesson.start) : (start ? dOf(start) : (() => { const x = new Date(); x.setDate(x.getDate() + 7); x.setMinutes(0, 0, 0); return x })())
  $('#lfDate').value = isoOf(d).slice(0, 10); $('#lfTime').value = isoOf(d).slice(11)
  $('#lfDur').value = String((lesson && lesson.dur) || 60)
  $('#lfRepRow').hidden = !!lesson; $('#lfRep').value = '0'; $('#lfEndRow').hidden = true; $('#lfUntil').value = ''; $('#lfCount').value = '5'
  const dates = () => {
    const step = +$('#lfRep').value, first = dOf($('#lfDate').value + 'T' + ($('#lfTime').value || '10:00'))
    if (!step || lesson || isNaN(first)) return [first]
    const until = $('#lfUntil').value ? dOf($('#lfUntil').value + 'T23:59') : null, n = Math.min(52, Math.max(1, +$('#lfCount').value || 1))
    const out = []
    for (let d = new Date(first); out.length < (until ? 52 : n); d.setDate(d.getDate() + step)) { if (until && d > until) break; out.push(new Date(d)) }
    return out
  }
  const sum = () => {
    $('#lfEndRow').hidden = $('#lfRep').value === '0' || !!lesson; const ds = dates()
    const bad = ds.map(d => dispoConflict(isoOf(d), +$('#lfDur').value, lesson && lesson.id)).filter(Boolean)
    $('#lfSum').textContent = (ds.length > 1 ? ds.length + ' cours : du ' + fmtLDay(ds[0]) + ' au ' + fmtLDay(ds[ds.length - 1]) + '. ' : '') + (bad.length ? '⚠️ ' + bad[0] + (bad.length > 1 ? ' (et ' + (bad.length - 1) + ' autre(s))' : '') : '')
    $('#lfSum').classList.toggle('warnt', !!bad.length)
  }
  $('#lfBusy').hidden = !TEACHER || !!lesson
  $('#lfBusy').onclick = () => {
    const a = dOf($('#lfDate').value + 'T' + $('#lfTime').value); if (isNaN(a)) return
    const z = new Date(a.getTime() + (+$('#lfDur').value) * 60000)
    dlg.hidden = true; addBusy({ start: isoOf(a), end: isoOf(z) })
  }
  ;['#lfRep', '#lfCount', '#lfUntil', '#lfDate', '#lfTime', '#lfDur'].forEach(id => $(id).oninput = $(id).onchange = sum); sum()
  dlg.hidden = false
  $('#lfCancel').onclick = () => { dlg.hidden = true }
  $('#lfOk').onclick = () => {
    const s2 = TEACHER ? students().find(x => x.id === sel.value) : null
    if (TEACHER && !s2) { toast('Choisis un élève'); return }
    if (!$('#lfDate').value || !$('#lfTime').value) { toast('Choisis le jour et l’heure'); return }
    { const bad = dates().map(d => dispoConflict(isoOf(d), +$('#lfDur').value, lesson && lesson.id)).filter(Boolean); if (bad.length && !confirm(bad[0] + '\nEnvoyer quand même ?')) return }
    const iso = $('#lfDate').value + 'T' + $('#lfTime').value, dur = +$('#lfDur').value
    dlg.hidden = true
    const ds = dates()
    if (lesson) lessonAct(st, lesson.id, l => { l.from = l.start; l.start = iso; l.dur = dur; l.ok = { [ME]: true, [OTHER]: false }; l.by = ME; l.cancel = false })
    else if (ds.length > 1) proposeSeries(s2, ds.map(isoOf), dur, +$('#lfRep').value)
    else proposeLesson(s2, iso, dur)
    if (!lesson && ds.length > 1) { offerNotify(`Bonjour ${profName()} ! Je te propose ${ds.length} cours, ${fmtLTime(ds[0])}, du ${fmtLDay(ds[0])} au ${fmtLDay(ds[ds.length - 1])}. Tu peux accepter dans Partoche (Mon agenda) :`); return }
    const L = { start: iso, dur }
    offerNotify(lesson ? `Bonjour ${profName()} ! Je te propose de déplacer notre cours au ${fmtLesson(L)}. Tu peux accepter dans Partoche (Mon agenda) :` : `Bonjour ${profName()} ! Je te propose un cours le ${fmtLesson(L)}. Tu peux accepter dans Partoche (Mon agenda) :`)
  }
}

// ---------- fenêtre d'un cours ----------
function lessonCard(st, l) {
  const dlg = $('#lessonView'), box = $('#lvBody')
  const other = TEACHER ? st.name : coursWho()
  const s = lStatus(l)
  box.innerHTML = `<div class="lvhead" style="--sc:${(TEACHER ? st.color : (pres.other && pres.other.c)) || '#4f8cff'}">
    <span class="pemo">${esc(TEACHER ? (st.emoji || st.name.charAt(0)) : ((pres.other && pres.other.e) || '🎼'))}</span>
    <div><b>${esc(TEACHER ? 'Cours avec ' + st.name : 'Cours avec ' + other)}</b><div>${esc(fmtLesson(l))}</div>${l.from ? `<div class="muted small">${esc('Avant : ' + fmtLesson({ ...l, start: l.from }))}</div>` : ''}</div></div>
    <div class="lvstate s-${s}">${esc(waitLabel(l, other))}</div>`
  if (l.hw && (l.hw.text || (l.hw.scores || []).length)) box.innerHTML += `<div class="lvhw"><h4>À bosser</h4>${hwHtml(l.hw)}</div>`
  const acts = $('#lvActs'); acts.innerHTML = ''
  const btn = (txt, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = txt; b.onclick = () => { dlg.hidden = true; fn() }; acts.appendChild(b) }
  const ser = l.series ? lessonsFor(st).filter(x => x.series === l.series && lStatus(x) === 'wait' && !x.ok[ME]) : []
  if (ser.length > 1) btn('✓ Accepter les ' + ser.length + ' cours de la série', 'primary', () => {
    const ids = new Set(ser.map(x => x.id)), now = Date.now()
    const list = lessonsFor(st).map(x => ids.has(x.id) ? { ...x, ok: { ...x.ok, [ME]: true }, upd: now } : x)
    if (!TEACHER) { const sn = lsGet('mcsz:coursSeen', {}); ids.forEach(i => sn[i] = now); lsSet('mcsz:coursSeen', sn) }
    commitLessons(st, list)
    offerNotify(`Bonjour ${profName()} ! C’est d’accord pour les ${ser.length} cours (${fmtLTime(dOf(ser[0].start))}, à partir du ${fmtLDay(dOf(ser[0].start))}) 👍`)
  })
  if (s === 'wait' && !l.ok[ME]) btn(ser.length > 1 ? '✓ Seulement celui-ci' : '✓ Accepter', ser.length > 1 ? '' : 'primary', () => { lessonAct(st, l.id, x => { x.ok[ME] = true }); offerNotify(`Bonjour ${profName()} ! C’est d’accord pour le cours du ${fmtLesson(l)} 👍`) })
  if (s !== 'cancel' && lEnd(l) > new Date()) btn('🔁 Proposer un autre horaire', '', () => lessonForm({ st, lesson: l }))
  if (s !== 'cancel' && lEnd(l) > new Date()) btn('✕ Annuler le cours', 'danger', () => { if (confirm('Annuler ce cours ?')) { lessonAct(st, l.id, x => { x.cancel = true }); offerNotify(`Bonjour ${profName()} ! Je dois annuler le cours du ${fmtLesson(l)}, désolé. Je te propose un autre horaire dès que possible.`) } })
  if (TEACHER && s === 'ok') btn('📝 À bosser', '', () => hwForm(st, l))
  if (TEACHER) btn('🎼 Ses partitions', '', () => { if (!curStudent() || curStudent().id !== st.id) { lsSet('mcsz:student', st.id); share = null; presAfterSwitch(); teacherLibrary() } $('#agendaDlg').hidden = true })
  btn('Fermer', '', () => { })
  dlg.hidden = false
}
const hwHtml = hw => (hw.text ? `<p class="hwtext">${esc(hw.text).replace(/\n/g, '<br>')}</p>` : '') + ((hw.scores || []).length ? '<div class="hwscores">' + hw.scores.map(r => `<span class="hwchip" data-rel="${esc(r)}">🎼 ${esc(baseName(r.split('/').pop()))}</span>`).join('') + '</div>' : '')

// ---------- « À bosser » (prof : saisie ; élève : affichage à la fin du cours) ----------
async function hwForm(st, l) {
  const dlg = $('#hwDlg')
  $('#hwTitle').textContent = 'À bosser pour ' + st.name
  $('#hwSub').textContent = 'Cours du ' + fmtLesson(l)
  $('#hwText').value = (l.hw && l.hw.text) || ''
  const box = $('#hwScores'); box.innerHTML = '<span class="muted small">…</span>'
  dlg.hidden = false
  const data = studentData.get(st.id) || await loadStudentData(st)
  const chosen = new Set((l.hw && l.hw.scores) || [])
  box.innerHTML = ''
  for (const r of (data.scores || []).sort((a, b) => a.localeCompare(b, 'fr'))) {
    const b = document.createElement('button'); b.className = 'hwpick' + (chosen.has(r) ? ' on' : '')
    b.textContent = baseName(r.split('/').pop())
    b.onclick = () => { chosen.has(r) ? chosen.delete(r) : chosen.add(r); b.classList.toggle('on') }
    box.appendChild(b)
  }
  if (!box.childElementCount) box.innerHTML = '<span class="muted small">Aucune partition trouvée chez ' + esc(st.name) + '</span>'
  $('#hwCancel').onclick = () => { dlg.hidden = true }
  $('#hwOk').onclick = () => {
    dlg.hidden = true
    lessonAct(st, l.id, x => { x.hw = { text: $('#hwText').value.trim(), scores: [...chosen], at: Date.now(), by: myName() } })
  }
}
function coursHomework() {
  if (TEACHER || !coursMine) return
  const seen = lsGet('mcsz:hwSeen', {})
  const l = coursMine.filter(x => x.hw && x.hw.at && (seen[x.id] || 0) < x.hw.at).sort((a, b) => b.hw.at - a.hw.at)[0]
  if (!l || !$('#hwShow').hidden) return
  // les partitions à bosser passent en « À faire »
  G.tags = G.tags || {}
  for (const r of l.hw.scores || []) if (!G.tags[r] || G.tags[r] === 'done') G.tags[r] = 'todo'
  saveGlobal(); writeSettings(); if ($('#library').classList.contains('active')) renderLibrary()
  $('#hsTitle').textContent = '📝 À bosser pour le prochain cours'
  $('#hsSub').textContent = (l.hw.by || coursWho()) + ' · cours du ' + fmtLesson(l)
  $('#hsBody').innerHTML = hwHtml(l.hw)
  $$('#hsBody .hwchip').forEach(c => c.onclick = () => { const e = files.find(f => (f.rel || f.name) === c.dataset.rel); if (e) { $('#hwShow').hidden = true; markHw(); openScore(e) } })
  const markHw = () => { const s = lsGet('mcsz:hwSeen', {}); s[l.id] = l.hw.at; lsSet('mcsz:hwSeen', s) }
  $('#hsOk').onclick = () => { $('#hwShow').hidden = true; markHw() }
  $('#hwShow').hidden = false
}

// ---------- cours en cours : les deux en ligne autour de l'heure du cours ----------
let liveLesson = null
function lessonNow() {
  const now = Date.now()
  const pick = list => list.find(x => lStatus(x.l || x) === 'ok' && now >= dOf((x.l || x).start).getTime() - 10 * 60000 && now <= lEnd(x.l || x).getTime() + 15 * 60000)
  if (TEACHER) { const st = curStudent(); if (!st) return null; const l = pick(lessonsFor(st)); return l ? { st, l } : null }
  const l = pick(coursMine || []); return l ? { st: null, l } : null
}
function paintLive() {
  const el = $('#liveBar'); if (!el) return
  const n = lessonNow()
  const otherOn = TEACHER ? (n && presOf.has(n.st.id)) || !!pres.other : !!pres.other
  if (n && otherOn) {
    liveLesson = n
    el.hidden = false
    $('#liveTxt').textContent = '🎻 Cours en cours avec ' + (TEACHER ? n.st.name : coursWho()) + ' · jusqu’à ' + fmtLTime(lEnd(n.l))
    $('#liveEnd').hidden = !TEACHER
    $('#liveEnd').onclick = () => hwForm(n.st, n.l)
  } else {
    // fin de cours (prof) : on propose de noter le travail
    if (TEACHER && liveLesson && Date.now() > lEnd(liveLesson.l).getTime() - 5 * 60000 && !liveLesson.l.hw && !liveLesson.asked) { liveLesson.asked = true; hwForm(liveLesson.st, liveLesson.l) }
    el.hidden = true
  }
}
setInterval(paintLive, 30000)

// ---------- affichage : panneau « Prochains cours », agenda semaine, « Mes cours » ----------
let agWeek = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d })()
function upcoming() {
  const now = Date.now() - 60 * 60000
  if (TEACHER) return allLessons().filter(x => lEnd(x.l).getTime() > now && !x.l.cancel)
  return (coursMine || []).filter(l => lEnd(l).getTime() > now && !l.cancel).map(l => ({ l, st: null }))
}
function paintAgenda() {
  const pend = upcoming().filter(x => lStatus(x.l) === 'wait' && !x.l.ok[ME]).length
  const b = $('#agendaCount'); if (b) { b.hidden = !pend; b.textContent = pend }
  const side = $('#agendaSide')
  if (side) {
    side.hidden = !TEACHER
    if (TEACHER) {
      const list = $('#sideList'); list.innerHTML = ''
      let day = ''
      const up = upcoming().slice(0, 12)
      for (const { l, st } of up) {
        const d = dOf(l.start), k = d.toDateString()
        if (k !== day) { day = k; const h = document.createElement('div'); h.className = 'sday' + (k === new Date().toDateString() ? ' today' : ''); h.innerHTML = `<b>${d.toLocaleDateString(LOC, { day: 'numeric' })}</b><span>${esc(d.toLocaleDateString(LOC, { weekday: 'long' }) + ' · ' + d.toLocaleDateString(LOC, { month: 'long' }))}</span>`; list.appendChild(h) }
        const it = document.createElement('button'); it.className = 'sitem s-' + lStatus(l) + (l.ok[ME] ? '' : ' mine')
        it.style.setProperty('--sc', st.color || '#4f8cff')
        it.innerHTML = `<i></i><span class="stime">${fmtLTime(d)} – ${fmtLTime(lEnd(l))}</span><b>${esc((st.emoji ? st.emoji + ' ' : '') + st.name)}</b><span class="sstat">${esc(waitLabel(l, st.name))}</span>`
        it.onclick = () => lessonCard(st, l)
        list.appendChild(it)
      }
      if (!up.length) list.innerHTML = '<p class="muted small">Aucun cours prévu. Propose un horaire à un élève avec ＋.</p>'
    }
  }
  if (!$('#agendaDlg').hidden) renderAgenda()
}
function renderAgenda() {
  const dp = dispoNow(), PX = 44
  const H0 = Math.min(8, Math.floor(hm(dp.from) / 60)), H1 = Math.max(20, Math.ceil(hm(dp.to) / 60))
  const grid = $('#agGrid')
  $('#agTitle').textContent = TEACHER ? '📅 Mon agenda' : '📅 Disponibilités de ' + coursWho()
  const days = [...Array(7)].map((_, i) => { const d = new Date(agWeek); d.setDate(d.getDate() + i); return d })
  $('#agRange').textContent = days[0].toLocaleDateString(LOC, { day: 'numeric', month: 'short' }) + ' – ' + days[6].toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: 'numeric' })
  let h = '<div class="aghead"><span></span>' + days.map(d => `<span class="${d.toDateString() === new Date().toDateString() ? 'today' : ''}">${esc(d.toLocaleDateString(LOC, { weekday: 'short' }))} <b>${d.getDate()}</b></span>`).join('') + '</div><div class="agbody" style="height:' + (H1 - H0) * PX + 'px"><div class="aghours">'
  for (let x = H0; x < H1; x++) h += `<span style="top:${(x - H0) * PX}px">${p2(x)}:00</span>`
  h += '</div>'
  days.forEach((d, i) => { h += `<div class="agcol" data-i="${i}">` + [...Array(H1 - H0)].map((_, k) => `<div class="agslot" data-h="${H0 + k}"></div>`).join('') + '</div>' })
  h += '</div>'
  grid.innerHTML = h
  // indisponibilités : jours off, hors horaires, occupé
  const cols = grid.querySelectorAll('.agcol')
  const block = (i, a, b, cls, txt, onclick) => {
    const top = (a / 60 - H0) * PX, ht = (b - a) / 60 * PX; if (ht <= 0) return
    const e = document.createElement('div'); e.className = 'agbusy ' + cls; e.style.cssText = `top:${Math.max(0, top)}px;height:${ht + Math.min(0, top)}px`
    if (txt) e.textContent = txt
    if (onclick) { e.classList.add('click'); e.onclick = ev => { ev.stopPropagation(); onclick() } }
    cols[i].appendChild(e)
  }
  days.forEach((d, i) => {
    if ((dp.off || []).includes(d.getDay())) { block(i, H0 * 60, H1 * 60, 'off', TEACHER ? 'Jour off' : 'Pas dispo'); return }
    block(i, H0 * 60, hm(dp.from), 'out', ''); block(i, hm(dp.to), H1 * 60, 'out', '')
  })
  for (const b of busyList()) {
    const a = dOf(b.start), z = dOf(b.end)
    days.forEach((d, i) => {
      const d0 = new Date(d); d0.setHours(0, 0, 0, 0); const d1 = new Date(d0); d1.setDate(d1.getDate() + 1)
      if (z <= d0 || a >= d1) return
      const from = a < d0 ? H0 * 60 : a.getHours() * 60 + a.getMinutes(), to = z >= d1 ? H1 * 60 : z.getHours() * 60 + z.getMinutes()
      block(i, Math.max(from, H0 * 60), Math.min(to, H1 * 60), 'busy', TEACHER ? (b.note || 'Indisponible') : 'Occupé', TEACHER && b.id ? () => busyCard(b) : null)
    })
  }
  const items = (TEACHER ? allLessons() : (coursMine || []).map(l => ({ l, st: null }))).filter(x => !x.l.cancel)   // annulés : on ne les montre plus
  for (const { l, st } of items) {
    const d = dOf(l.start), i = Math.floor((new Date(d).setHours(0, 0, 0, 0) - agWeek.getTime()) / 86400000)
    if (i < 0 || i > 6) continue
    const top = ((d.getHours() + d.getMinutes() / 60) - H0) * PX, ht = Math.max(22, (l.dur || 60) / 60 * PX - 2)
    const e = document.createElement('button'); e.className = 'agev s-' + lStatus(l)
    e.style.cssText = `top:${top}px;height:${ht}px;--sc:${(st && st.color) || '#4f8cff'}`
    e.innerHTML = `<b>${esc(st ? (st.emoji ? st.emoji + ' ' : '') + st.name : 'Cours')}</b><span>${fmtLTime(d)}${lStatus(l) === 'wait' ? ' · ' + esc(l.ok[ME] ? 'en attente' : 'à confirmer') : ''}</span>`
    e.onclick = ev => { ev.stopPropagation(); lessonCard(st, l) }
    grid.querySelectorAll('.agcol')[i].appendChild(e)
  }
  grid.querySelectorAll('.agslot').forEach(sl => sl.onclick = () => {
    const d = new Date(days[+sl.parentElement.dataset.i]); d.setHours(+sl.dataset.h, 0, 0, 0)
    if (!TEACHER) { const why = dispoConflict(isoOf(d), 60); if (why) { toast('⛔ ' + why, 3500); return } }
    lessonForm({ st: TEACHER ? curStudent() : null, start: isoOf(d) })
  })
}
function renderMyLessons() {
  const box = $('#mlList'); box.innerHTML = ''
  const list = (coursMine || []).filter(l => !l.cancel && lEnd(l).getTime() > Date.now() - 14 * 86400000).sort((a, b) => a.start.localeCompare(b.start))
  for (const l of list) {
    const past = lEnd(l) < new Date()
    const r = document.createElement('button'); r.className = 'sitem s-' + lStatus(l) + (past ? ' past' : '') + (l.ok.e ? '' : ' mine')
    r.innerHTML = `<i></i><span class="stime">${esc(fmtLesson(l))}</span><span class="sstat">${esc(past && lStatus(l) === 'ok' ? (l.hw ? '📝 travail noté' : 'passé') : waitLabel(l, coursWho()))}</span>`
    r.onclick = () => { $('#myLessons').hidden = true; lessonCard(null, l) }
    box.appendChild(r)
  }
  if (!list.length) box.innerHTML = '<p class="muted">Aucun cours prévu pour l’instant.</p>'
}
$('#mlWeek').onclick = () => { $('#myLessons').hidden = true; $('#agendaDlg').hidden = false; renderAgenda() }
$('#btnAgenda').onclick = () => {
  if (TEACHER) { $('#agendaDlg').hidden = false; renderAgenda(); Promise.all(students().map(loadStudentData)).then(() => { paintAgenda(); renderAgenda() }) }
  else { $('#myLessons').hidden = false; renderMyLessons(); refreshGuest(true).then(coursSyncStudent).then(renderMyLessons) }
}
$('#agPrev').onclick = () => { agWeek.setDate(agWeek.getDate() - 7); renderAgenda() }
$('#agNext').onclick = () => { agWeek.setDate(agWeek.getDate() + 7); renderAgenda() }
$('#agToday').onclick = () => { agWeek = new Date(); agWeek.setHours(0, 0, 0, 0); agWeek.setDate(agWeek.getDate() - ((agWeek.getDay() + 6) % 7)); renderAgenda() }
$('#agNew').onclick = () => lessonForm({ st: curStudent() })
$('#agClose').onclick = () => { $('#agendaDlg').hidden = true }
$('#sideNew').onclick = () => lessonForm({ st: curStudent() })
$('#sideOpen').onclick = () => $('#btnAgenda').click()
$('#mlNew').onclick = () => { $('#myLessons').hidden = true; lessonForm({}) }
$('#mlClose').onclick = () => { $('#myLessons').hidden = true }
$('#lvClose').onclick = () => { $('#lessonView').hidden = true }
// synchro : élève toutes les 60 s via son lien de partage ; prof via la lecture des dossiers des élèves
if (!TEACHER && !DEMO) { setTimeout(() => coursSyncStudent().catch(() => { }), 5000); setInterval(() => { if (!document.hidden) refreshGuest(true).then(coursSyncStudent).catch(() => { }) }, 60000) }
if (TEACHER) { setTimeout(() => Promise.all(students().map(loadStudentData)).then(() => { paintAgenda(); paintAsks(); teacherTodo() }), 2500); setInterval(() => { if (!document.hidden) Promise.all(students().map(loadStudentData)).then(paintAgenda) }, 120000) }
paintAgenda()

// logo = options (sur tablette, l'engrenage peut être hors de l'écran)
$('#brandBtn').onclick = () => openSettings(false)
// hauteur réelle de l'en-tête du lecteur (sur deux lignes sur tablette) pour placer les panneaux en dessous
try { new ResizeObserver(() => { const h = $('#viewer .bar').offsetHeight; if (h) document.documentElement.style.setProperty('--bar-h', (h - (parseFloat(getComputedStyle($('#viewer .bar')).paddingTop) || 0)) + 'px') }).observe($('#viewer .bar')) } catch { }

// ---- prof : notifications du navigateur (si elle les autorise) + compteur dans l'onglet ----
const canNotif = () => !native && 'Notification' in window
function notifyProf(title, body, tag) {
  if (!TEACHER) return
  const done = lsGet('mcsz:notified', {}); if (tag && done[tag]) return
  if (tag) { done[tag] = Date.now(); const k = Object.keys(done); if (k.length > 200) delete done[k[0]]; lsSet('mcsz:notified', done) }
  const T = window.__t || (x => x)
  if (canNotif() && Notification.permission === 'granted') { try { new Notification(T(title), { body: T(body), icon: 'img/logo.svg', tag: tag || undefined }) } catch { } }
}
function profWatch() {
  if (!TEACHER) return
  const pend = upcoming().filter(x => lStatus(x.l) === 'wait' && !x.l.ok[ME])
  for (const { l, st } of pend) notifyProf('📅 ' + st.name + ' propose un cours', fmtLesson(l), 'c:' + l.id + ':' + l.upd)
  document.title = (pend.length ? '(' + pend.length + ') ' : '') + 'Partoche'
}
if (TEACHER) {
  setInterval(profWatch, 30000); setTimeout(profWatch, 5000)
  // élève qui arrive en ligne
  const wasOn = new Set()
  setInterval(() => { for (const st of students()) { const on = presOf.has(st.id); if (on && !wasOn.has(st.id)) notifyProf((st.emoji ? st.emoji + ' ' : '') + st.name + ' est en ligne', 'sur Partoche', 'on:' + st.id + ':' + Math.floor(Date.now() / 1800000)); on ? wasOn.add(st.id) : wasOn.delete(st.id) } }, 20000)
  $('#notifRow').hidden = !canNotif()
  const paintNotif = () => { const p = canNotif() ? Notification.permission : 'denied'; $('#notifState').textContent = p === 'granted' ? '✓ activées' : p === 'denied' ? 'bloquées par le navigateur' : ''; $('#setNotif').hidden = p !== 'default' }
  if (canNotif()) { paintNotif(); $('#setNotif').onclick = () => Notification.requestPermission().then(paintNotif) }
  // demande au premier clic sur l'agenda
  $('#btnAgenda').addEventListener('click', () => { if (canNotif() && Notification.permission === 'default') Notification.requestPermission().then(paintNotif) })
}
// ---- couleur de l'en-tête : celle du prof (son emoji) sur sa page ----
function paintTeacherColor() {
  if (!TEACHER) return
  const c = /^#[0-9a-f]{6}$/i.test((G.profile || {}).color || '') ? G.profile.color : '#2f7de1'
  document.body.style.setProperty('--tc', c)
}
paintTeacherColor()

// relit l'envoi du prof dans le dossier partagé de l'élève : présent et identique ?
async function verifyDrop(fname, key) {
  const stem = fname.replace(/\.json$/i, '')
  for (let k = 0; k < 4; k++) {
    try {
      await new Promise(r => setTimeout(r, k ? 1500 : 600))
      const pf = await connectShare()
      const f = pf.files(pf.root, c => c.name === fname || c.name.startsWith(stem + ' ('))[0]
      if (!f) continue
      const d = parseJ(await pf.text(f.meta.fileid))
      if (d && JSON.stringify(d.ink) === key) return true
    } catch { }
  }
  return false
}

// ---- temps réel : abonnement ntfy (SSE) au canal du partage : présence, nouvelles annotations, agenda ----
const presDocOf = file => h32(file || '', 7)
function presPing(extra) { presPingTo(shareCfg().link, extra) }
function presPingTo(link, extra) {
  const topic = presTopicFor(link); if (!topic || DEMO || navigator.onLine === false) return
  const pr = G.profile || {}
  fetch(PRES + topic, { method: 'POST', body: JSON.stringify({ r: TEACHER ? 'p' : 'e', n: TEACHER ? myName() : '', e: pr.emoji || '', c: pr.color || '', d: presDoc(), ...extra }) }).catch(() => { })
}
let sse = null, sseTopic = ''
function sseSync() {
  const topic = !document.hidden && !DEMO ? presTopic() : ''
  if (topic === sseTopic && (sse || !topic)) return
  if (sse) { try { sse.close() } catch { } sse = null }
  sseTopic = topic; if (!topic || !window.EventSource) return
  sse = new EventSource(PRES + topic + '/sse')
  sse.onmessage = ev => {
    let o; try { const m = JSON.parse(ev.data); if (m.event && m.event !== 'message') return; o = JSON.parse(m.message) } catch { return }
    if (!o || o.r !== (TEACHER ? 'e' : 'p')) return
    o.t = Date.now()
    if (!o.off) { const was = !!pres.other; pres.other = o; if (!was) { pres.was = false } paintNet(); paintPresence(); if (V && V.doc && V.doc._under) paintUnder() }
    if (!TEACHER && (o.ev === 'ink' || o.ev === 'agenda' || o.ev === 'score')) setTimeout(() => { try { native && native.tidyNow && native.tidyNow() } catch { } }, 1500)   // range tout de suite le dépôt du prof
    if (!TEACHER && o.ev === 'ink' && V && V.doc && o.d === presDocOf(V.doc._file)) loadGuestLayer(true)
    if (!TEACHER && o.ev === 'agenda') refreshGuest(true).then(coursSyncStudent).catch(() => { })
    if (!TEACHER && o.ev === 'avis') refreshGuest(true).then(asksSyncStudent).catch(() => { })
    if (TEACHER && o.ev === 'ask') { const st = curStudent(); if (st) loadStudentData(st).then(() => notifyProf('💬 ' + st.name + ' te demande ton avis', '', 'ask:' + Date.now())) }
    if (TEACHER && o.ev === 'agenda') { const st = curStudent(); if (st) loadStudentData(st).then(paintAgenda) }
  }
}
setInterval(sseSync, 5000); document.addEventListener('visibilitychange', sseSync); setTimeout(sseSync, 2000)

// « 20261002-165527 » -> « il y a 3 min » (qui est à jour ?)
function stampAgo(st) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(st || ''); if (!m) return ''
  const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return 'modifié ' + ago(t)
}
// le bouton du calque de l'autre suit la présence (« en direct » quand le prof est sur la même partition)
setInterval(() => { if (V && V.doc && $('#viewer').classList.contains('active') && V.doc._under) paintUnder() }, 15000)

// =====================================================================
//  DISPONIBILITÉS DU PROF : horaires (08:00–20:00 par défaut), jours off, indisponibilités.
//  Gardées dans ses réglages ; envoyées à chaque élève avec l'agenda, sous forme anonyme :
//  les élèves voient « Occupé », jamais les noms des autres ni ses notes.
// =====================================================================
const hm = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : 0 }
const DISPO0 = { from: '08:00', to: '20:00', off: [], busy: [] }
function dispoNow() {
  if (TEACHER) return Object.assign({}, DISPO0, G.dispo || {})
  return Object.assign({}, DISPO0, lsGet('mcsz:profDispo', {}) || {})
}
// créneaux occupés : prof = ses indispos (avec notes) ; élève = ce qu'elle lui a envoyé (anonyme)
function busyList() {
  const dp = dispoNow()
  return (dp.busy || []).filter(b => b && b.start && b.end)
}
// ce que voit l'élève st : indispos + cours des autres élèves, sans nom ni note
function dispoFor(st) {
  const dp = dispoNow(), busy = (dp.busy || []).map(b => ({ start: b.start, end: b.end }))
  for (const o of students()) if (o.id !== st.id) for (const l of (coursBy.get(o.id) || coursLocal(o))) if (!l.cancel && lEnd(l) > new Date(Date.now() - 86400000)) busy.push({ start: l.start, end: isoOf(lEnd(l)) })
  return { from: dp.from, to: dp.to, off: dp.off || [], busy }
}
// la raison si le créneau tombe mal, sinon ''
function dispoConflict(start, dur, ignoreId) {
  const dp = dispoNow(), a = dOf(start); if (isNaN(a)) return ''
  const z = new Date(a.getTime() + (dur || 60) * 60000), who = TEACHER ? 'Tu n’es' : coursWho() + ' n’est'
  if ((dp.off || []).includes(a.getDay())) return who + ' pas disponible le ' + a.toLocaleDateString(LOC, { weekday: 'long' })
  const m0 = a.getHours() * 60 + a.getMinutes(), m1 = m0 + (dur || 60)
  if (m0 < hm(dp.from) || m1 > hm(dp.to)) return 'En dehors des horaires (' + dp.from + ' – ' + dp.to + ')'
  const all = TEACHER ? allLessons().filter(x => !x.l.cancel && x.l.id !== ignoreId).map(x => ({ start: x.l.start, end: isoOf(lEnd(x.l)) })).concat(busyList()) : busyList()
  for (const b of all) if (dOf(b.start) < z && dOf(b.end) > a) return who + ' pas disponible à ce moment-là'
  return ''
}
let pushT = 0
function pushDispoOthers(exceptId) {
  clearTimeout(pushT)
  pushT = setTimeout(() => { for (const st of students()) if (st.id !== exceptId && st.upload) coursSendProf(st, coursBy.get(st.id) || coursLocal(st), true) }, 4000)
}
function saveDispo(p) { G.dispo = Object.assign({}, dispoNow(), p); saveGlobal(); paintAgenda(); if (!$('#agendaDlg').hidden) renderAgenda(); pushDispoOthers(null) }
function addBusy(b) {
  const note = prompt('Note (pour toi seule, tes élèves verront « Occupé ») :', '') ; if (note === null) return
  saveDispo({ busy: [...(dispoNow().busy || []), { id: 'b' + Date.now().toString(36), start: b.start, end: b.end, note: note.trim() }] })
  toast('⛔ Indisponibilité ajoutée', 2500)
}
function busyCard(b) {
  if (!confirm((b.note ? b.note + '\n' : '') + fmtLDay(dOf(b.start)) + ' ' + fmtLTime(dOf(b.start)) + ' – ' + fmtLTime(dOf(b.end)) + '\n\nSupprimer cette indisponibilité ?')) return
  saveDispo({ busy: (dispoNow().busy || []).filter(x => x.id !== b.id) })
}
// fenêtre « Mes disponibilités »
function openDispo() {
  const dp = dispoNow()
  $('#dpFrom').value = dp.from; $('#dpTo').value = dp.to
  const days = $('#dpDays'); days.innerHTML = ''
  ;[1, 2, 3, 4, 5, 6, 0].forEach(n => {
    const d = new Date(2026, 0, 4 + n)   // 4 janv. 2026 = dimanche
    const b = document.createElement('button'); b.className = 'hwpick' + ((dp.off || []).includes(n) ? ' on' : '')
    b.textContent = d.toLocaleDateString(LOC, { weekday: 'long' }); b.dataset.n = n
    b.onclick = () => b.classList.toggle('on')
    days.appendChild(b)
  })
  paintBusyList()
  const t = new Date(); t.setDate(t.getDate() + 1)
  $('#dpDate').value = isoOf(t).slice(0, 10); $('#dpDateEnd').value = ''; $('#dpA').value = '09:00'; $('#dpB').value = '12:00'; $('#dpAll').checked = false; $('#dpNote').value = ''
  $('#dispoDlg').hidden = false
}
function paintBusyList() {
  const box = $('#dpList'); box.innerHTML = ''
  const list = (dispoNow().busy || []).filter(b => dOf(b.end) > new Date()).sort((a, b) => a.start.localeCompare(b.start))
  for (const b of list) {
    const a = dOf(b.start), z = dOf(b.end)
    const allDay = fmtLTime(a) === '00:00' && (z - a) % 86400000 === 0
    const r = document.createElement('div'); r.className = 'dprow'
    r.innerHTML = `<span>⛔</span><b></b><span class="muted"></span><button class="btn chipbtn" title="Supprimer">🗑</button>`
    r.querySelector('b').textContent = allDay ? fmtLDay(a) + ((z - a) > 86400000 ? ' → ' + fmtLDay(new Date(z - 1)) : '') + ' (journée)' : fmtLDay(a) + ' · ' + fmtLTime(a) + '–' + fmtLTime(z)
    r.querySelector('.muted').textContent = b.note || ''
    r.querySelector('button').onclick = () => { saveDispo({ busy: (dispoNow().busy || []).filter(x => x.id !== b.id) }); paintBusyList() }
    box.appendChild(r)
  }
  if (!list.length) box.innerHTML = '<p class="muted small">Aucune indisponibilité à venir.</p>'
}
$('#dpAll').onchange = () => { $('#dpTimes').hidden = $('#dpAll').checked; $('#dpEndRow').hidden = !$('#dpAll').checked }
$('#dpAdd').onclick = () => {
  if (!$('#dpDate').value) { toast('Choisis le jour'); return }
  let a, z
  if ($('#dpAll').checked) { a = dOf($('#dpDate').value + 'T00:00'); z = dOf(($('#dpDateEnd').value || $('#dpDate').value) + 'T00:00'); z.setDate(z.getDate() + 1) }
  else { a = dOf($('#dpDate').value + 'T' + $('#dpA').value); z = dOf($('#dpDate').value + 'T' + $('#dpB').value) }
  if (!(z > a)) { toast('La fin doit être après le début'); return }
  saveDispo({ busy: [...(dispoNow().busy || []), { id: 'b' + Date.now().toString(36), start: isoOf(a), end: isoOf(z), note: $('#dpNote').value.trim() }] })
  $('#dpNote').value = ''; paintBusyList(); toast('⛔ Indisponibilité ajoutée', 2000)
}
$('#dpSave').onclick = () => {
  const from = $('#dpFrom').value || '08:00', to = $('#dpTo').value || '20:00'
  if (hm(to) <= hm(from)) { toast('L’heure de fin doit être après le début'); return }
  saveDispo({ from, to, off: $$('#dpDays .hwpick.on').map(b => +b.dataset.n) })
  $('#dispoDlg').hidden = true; toast('✓ Disponibilités enregistrées, envoyées à tes élèves', 3000)
}
$('#dpClose').onclick = () => { $('#dispoDlg').hidden = true }
$('#agDispo').onclick = openDispo
$('#agDispo').hidden = !TEACHER

// ---------- éditeur de tags perso ----------
function openLabelEditor(after) {
  const dlg = $('#labelDlg'), box = $('#ldList')
  let defs = JSON.parse(JSON.stringify(labelDefs()))
  const paint = () => {
    box.innerHTML = ''
    defs.forEach((d, i) => {
      const r = document.createElement('div'); r.className = 'ldrow'
      r.innerHTML = `<input class="txt emoin" maxlength="8"><input class="txt ldname" maxlength="24"><input type="color"><span class="ldprev"></span><button class="btn chipbtn" title="Supprimer">🗑</button>`
      const [e, n, c] = r.querySelectorAll('input'), prev = r.querySelector('.ldprev')
      e.value = d.e; n.value = d.n; c.value = /^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#888888'
      const upd = () => { d.e = e.value.trim() || '🏷️'; d.n = n.value.trim() || 'Tag'; d.c = c.value; prev.innerHTML = labelPill(d) }
      e.oninput = n.oninput = c.oninput = upd; upd()
      r.querySelector('button').onclick = () => { defs.splice(i, 1); paint() }
      box.appendChild(r)
    })
  }
  paint()
  $('#ldAdd').onclick = () => { defs.push({ id: 'u' + Date.now().toString(36), e: '⭐', n: 'Nouveau tag', c: '#4f8cff' }); paint(); box.lastChild && box.lastChild.querySelector('.ldname').select() }
  $('#ldReset').onclick = () => { if (confirm('Remettre les tags proposés ? (tes tags perso seront retirés de la liste)')) { defs = JSON.parse(JSON.stringify(LABELS0)); paint() } }
  $('#ldSave').onclick = () => { G.labelDefs = defs; saveGlobal(); writeSettings(); dlg.hidden = true; renderLibrary(); after && after() }
  $('#ldCancel').onclick = () => { dlg.hidden = true; after && after() }
  dlg.hidden = false
}
$('#setLabels') && ($('#setLabels').onclick = () => { $('#settings').hidden = true; openLabelEditor() })

// =====================================================================
//  DEMANDES D'AVIS : l'élève pose une question sur un morceau, le prof répond.
//   élève : Settings/!Demandes.json   prof : « <Prof> - !Avis - <date>.json » (dépôt)
// =====================================================================
const ASK_FILE = '!Demandes.json', AVIS_DOC = '!Avis'
let asksMine = null
if (!TEACHER && !DEMO) asksMine = ((parseJ(nRead(ASK_FILE)) || lsGet('mcsz:asks', null) || {}).asks) || []
const avisReplies = () => lsGet('mcsz:avis', {})
function saveAsks(list) {
  asksMine = list; lsSet('mcsz:asks', { asks: list })
  queueFile(ASK_FILE, pretty({ app: 'Partoche', kind: 'demandes', updated: Date.now(), asks: list }))
  setTimeout(() => presPing({ ev: 'ask' }), 8000)
  paintAsks()
}
function askTeacher(entry) {
  promptText('💬 Ta question à ton prof sur « ' + baseName(entry.name) + ' »', '', t => {
    t = (t || '').trim(); if (!t) return
    saveAsks([...(asksMine || []), { id: 'q' + Date.now().toString(36), rel: entry.rel || entry.name, text: t, at: Date.now() }])
    toast('💬 Demande envoyée à ton prof', 3000)
    offerNotify(`Bonjour ${profName()} ! J’ai une question sur « ${baseName(entry.name)} » : ${t}`)
  }, 'Ex. tu peux me dire si ce morceau est faisable pour moi ? Quel doigté mesure 12 ?')
}
// élève : réponses du prof (dans son dossier Prof)
async function asksSyncStudent() {
  if (TEACHER || !share) return
  const g = guestDocs.get(AVIS_DOC + '.json'); if (!g) return
  const d = await shareJson(g.meta); if (!d || !d.replies) return
  const before = avisReplies(), seen = lsGet('mcsz:avisSeen', {})
  lsSet('mcsz:avis', d.replies)
  const fresh = Object.entries(d.replies).filter(([id, r]) => r && r.at && (seen[id] || 0) < r.at && (!before[id] || before[id].at !== r.at))
  if (fresh.length) toast('💬 ' + (g.who || 'Ton prof') + ' a répondu à ' + (fresh.length > 1 ? fresh.length + ' demandes' : 'ta demande'), 6000)
  paintAsks()
}
// prof : demandes de chaque élève + ses réponses
const asksBy = new Map()
function teacherReplies(st) { return lsGet('mcsz:avis:' + st.id, {}) }
async function sendReplies(st, replies) {
  lsSet('mcsz:avis:' + st.id, replies); paintAsks()
  if (!st.upload) { toast('Il faut le lien de dépôt de ' + st.name, 4000); return }
  try { await uploadToLink(st.upload, myName(), dropName(myName(), AVIS_DOC + '.json'), pretty({ app: 'Partoche', kind: 'avis', author: myName(), updated: Date.now(), replies })); toast('💬 Réponse envoyée à ' + st.name + ' ✓', 2500); presPingTo(st.link, { ev: 'avis' }) }
  catch (e) { toast('Envoi impossible (' + e.message + ')', 5000) }
}
function unanswered() {
  if (TEACHER) { let n = 0; for (const st of students()) { const r = teacherReplies(st); for (const a of asksBy.get(st.id) || []) if (!r[a.id]) n++ } return n }
  const r = avisReplies(), seen = lsGet('mcsz:avisSeen', {})
  return (asksMine || []).filter(a => r[a.id] && (seen[a.id] || 0) < r[a.id].at).length
}
function paintAsks() {
  const n = unanswered(), b = $('#asksCount'); if (b) { b.hidden = !n; b.textContent = n }
  $('#btnAsks').hidden = TEACHER ? false : !(asksMine && asksMine.length)
  if (!$('#asksDlg').hidden) renderAsks()
}
function renderAsks() {
  const box = $('#askList'); box.innerHTML = ''
  const item = (st, a, reply) => {
    const e = files.find(f => (f.rel || f.name) === a.rel)
    const d = document.createElement('div'); d.className = 'askrow' + (reply ? ' done' : '')
    d.innerHTML = `<div class="askhead">${st ? `<span class="pemo" style="--sc:${st.color || '#888'}">${esc(st.emoji || st.name.charAt(0))}</span><b>${esc(st.name)}</b> · ` : ''}<span class="askscore">🎼 ${esc(baseName(a.rel.split('/').pop()))}</span><span class="muted small">${esc(fmtLDay(new Date(a.at)))}</span></div><p class="askq"></p>`
    d.querySelector('.askq').textContent = a.text
    if (reply) { const r = document.createElement('p'); r.className = 'askr'; r.textContent = reply.text; d.appendChild(r) }
    if (TEACHER) {
      const ta = document.createElement('textarea'); ta.rows = 2; ta.placeholder = 'Ta réponse…'; ta.value = reply ? reply.text : ''
      const bt = document.createElement('button'); bt.className = 'btn primary'; bt.textContent = reply ? 'Modifier la réponse' : 'Répondre'
      bt.onclick = () => { const t = ta.value.trim(); if (!t) return; const rs = { ...teacherReplies(st), [a.id]: { text: t, at: Date.now() } }; sendReplies(st, rs) }
      d.append(ta, bt)
    }
    if (e) { const o = document.createElement('button'); o.className = 'btn chipbtn'; o.textContent = 'Ouvrir la partition'; o.onclick = () => { $('#asksDlg').hidden = true; if (TEACHER && curStudent() && curStudent().id !== st.id) { lsSet('mcsz:student', st.id); share = null; presAfterSwitch(); teacherLibrary(); return } openScore(e) }; d.appendChild(o) }
    box.appendChild(d)
  }
  if (TEACHER) {
    for (const st of students()) { const r = teacherReplies(st); for (const a of (asksBy.get(st.id) || []).slice().sort((x, y) => (!!r[x.id] - !!r[y.id]) || y.at - x.at)) item(st, a, r[a.id]) }
  } else {
    const r = avisReplies(), seen = lsGet('mcsz:avisSeen', {})
    for (const a of (asksMine || []).slice().sort((x, y) => y.at - x.at)) { item(null, a, r[a.id]); if (r[a.id]) seen[a.id] = r[a.id].at }
    lsSet('mcsz:avisSeen', seen); setTimeout(paintAsks, 0)
  }
  if (!box.childElementCount) box.innerHTML = '<p class="muted">' + (TEACHER ? 'Aucune demande de tes élèves pour l’instant.' : 'Aucune demande. Dans la liste, appui long sur une partition → « Demander l’avis de mon prof ».') + '</p>'
}
$('#btnAsks').onclick = () => { $('#asksDlg').hidden = false; renderAsks(); if (TEACHER) Promise.all(students().map(loadStudentData)).then(renderAsks); else refreshGuest(true).then(asksSyncStudent).then(renderAsks).catch(() => { }) }
$('#asksClose').onclick = () => { $('#asksDlg').hidden = true }
if (!TEACHER && !DEMO) { setTimeout(() => asksSyncStudent().catch(() => { }), 6000); setInterval(() => { if (!document.hidden) asksSyncStudent().catch(() => { }) }, 60000) }
setTimeout(paintAsks, 1000)

// ---- prof : à l'ouverture de la page, ce qui attend une réponse passe en premier ----
let todoShown = false
function teacherTodo(force) {
  if (!TEACHER || (todoShown && !force)) return
  const pend = upcoming().filter(x => lStatus(x.l) === 'wait' && !x.l.ok[ME])
  const nAsk = unanswered()
  if (!pend.length && !nAsk) { if (force) toast('Rien en attente 👍'); return }
  todoShown = true
  const box = $('#todoList'); box.innerHTML = ''
  const T = window.__t || (x => x)
  // une série (ex. tous les vendredis) = une seule ligne
  const groups = []
  for (const x of pend) { const g = x.l.series && groups.find(g => g.st.id === x.st.id && g.series === x.l.series); if (g) g.ls.push(x.l); else groups.push({ st: x.st, series: x.l.series, ls: [x.l] }) }
  for (const { st, ls } of groups) {
    const l = ls[0], many = ls.length > 1
    const r = document.createElement('div'); r.className = 'todorow'
    r.style.setProperty('--sc', st.color || '#4f8cff')
    const what = many ? T('propose {0} cours').replace('{0}', ls.length) : T(l.from ? 'propose de déplacer le cours' : 'propose un cours')
    const when = many ? T('à partir du') + ' ' + fmtLesson(l) : fmtLesson(l) + (l.from ? ' (' + T('avant :') + ' ' + fmtLesson({ ...l, start: l.from }) + ')' : '')
    r.innerHTML = `<span class="pemo">${esc(st.emoji || st.name.charAt(0))}</span><div><b>${esc(st.name)}</b> <span class="notr">${esc(what)}</span><div class="muted small notr">${esc(when)}</div></div>`
    const ok = document.createElement('button'); ok.className = 'btn primary'; ok.textContent = many ? T('✓ Tout accepter') : '✓ Accepter'
    ok.onclick = () => {
      const ids = new Set(ls.map(x => x.id)), now = Date.now()
      commitLessons(st, lessonsFor(st).map(x => ids.has(x.id) ? { ...x, ok: { ...x.ok, [ME]: true }, upd: now } : x))
      r.remove(); if (!box.childElementCount) $('#todoDlg').hidden = true
    }
    const see = document.createElement('button'); see.className = 'btn'; see.textContent = 'Voir'
    see.onclick = () => { $('#todoDlg').hidden = true; lessonCard(st, l) }
    r.append(ok, see); box.appendChild(r)
  }
  if (nAsk) {
    const r = document.createElement('div'); r.className = 'todorow'
    r.innerHTML = `<span class="pemo">💬</span><div class="notr"><b>${esc(T(nAsk > 1 ? '{0} demandes d’avis' : '{0} demande d’avis').replace('{0}', nAsk))}</b> ${esc(T('sans réponse'))}</div>`
    const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = 'Répondre'
    b.onclick = () => { $('#todoDlg').hidden = true; $('#btnAsks').click() }
    r.appendChild(b); box.appendChild(r)
  }
  $('#todoDlg').hidden = false
}
$('#todoAgenda').onclick = () => { $('#todoDlg').hidden = true; $('#btnAgenda').click() }
$('#todoLater').onclick = () => { $('#todoDlg').hidden = true }


// ---------- Tuto pour les élèves (prof) : la page « démarrer », à partager ----------
const TUTO_URL = PAGE_URL + 'demarrer.html'
const tutoMsg = () => `Bonjour ! Pour nos cours, installe Partoche sur ta tablette 🎻
Tout est expliqué ici, étape par étape (10 minutes) :
${TUTO_URL}

À la fin, l'appli te prépare un message à m'envoyer : je te retrouve alors dans ma liste d'élèves.`
function openTuto() {
  const f = $('#tutoFrame')
  if (!f.src) f.src = 'demarrer.html'
  $('#tutoWa').href = 'https://wa.me/?text=' + encodeURIComponent(tutoMsg())
  $('#tutoMail').href = 'mailto:?subject=' + encodeURIComponent('Partoche : pour nos cours de musique') + '&body=' + encodeURIComponent(tutoMsg())
  $('#tutoOpen').href = 'demarrer.html'
  $('#tutoDlg').hidden = false
}
$('#btnTuto').onclick = openTuto
$('#tutoClose').onclick = () => { $('#tutoDlg').hidden = true }
$('#tutoShare').onclick = async () => {
  if (navigator.share) { try { await navigator.share({ title: 'Partoche', text: tutoMsg() }); return } catch (e) { if (e && e.name === 'AbortError') return } }
  try { await navigator.clipboard.writeText(tutoMsg()); toast('Message copié : colle-le à ton élève (WhatsApp, SMS, email…)', 4000) } catch { toast('Utilise WhatsApp ou Email ci-dessous') }
}
$('#tutoCopy').onclick = async () => { try { await navigator.clipboard.writeText(TUTO_URL); toast('Lien copié') } catch { prompt('Lien du tuto :', TUTO_URL) } }
$('#stTuto').onclick = () => { $('#studentsDlg').hidden = true; openTuto() }
Object.defineProperty(window, '__V', { get: () => V })   // débogage

// ---------- temps passé sur la partition ouverte : cette séance + total cumulé ----------
const fmtClock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0') }
const fmtTot = s => { s = Math.round(s || 0); if (s < 60) return s + ' s'; const m = Math.floor(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') }
function paintWorkTime() {
  const el = $('#wTime')
  const on = work && V && V.entry && !V.entry.demo && $('#viewer').classList.contains('active')
  el.hidden = !on; if (!on) return
  const rel = V.entry.rel || V.entry.name, now = Date.now()
  const live = sess && sess.s === rel
  const cur = live ? (now - sess.a) / 1000 : 0
  const tot = ((work.tot && work.tot[rel]) || 0) + (live ? Math.min(30, (now - workTick) / 1000) : 0)
  el.innerHTML = `⏱ séance <b>${live ? fmtClock(cur) : '—'}</b><br><span class="wtot">total <b>${fmtTot(tot)}</b></span>`
}
setInterval(() => { paintWorkTime(); if ($('#tracksPanel').classList.contains('open')) paintDevVol() }, 1000)

// ---------- volume : général (jusqu'à 300 %, avec avertissement) + volume média de la tablette ----------
function paintVol() {
  const v = Math.round((G.vol || 1) * 100)
  $('#masterVol').value = v
  $('#masterVolLbl').textContent = v + ' %'
  $('#masterVolLbl').classList.toggle('hot', v > 100)
  $('#masterWarn').hidden = v <= 100
}
player.setBoost(G.vol || 1); paintVol()
$('#masterVol').addEventListener('input', e => {
  let v = +e.target.value; if (Math.abs(v - 100) <= 5) v = 100   // un petit « cran » à 100 %
  G.vol = v / 100; player.setBoost(G.vol); paintVol()
})
$('#masterVol').addEventListener('change', () => saveGlobal())
function paintDevVol() {
  const r = native && native.getMediaVolume ? parseJ(native.getMediaVolume()) : null
  $('#devVolRow').hidden = !r
  if (!r) return
  $('#devVol').max = r.max; $('#devVol').value = r.cur
  $('#devVolLbl').textContent = Math.round(r.cur / Math.max(1, r.max) * 100) + ' %'
}
$('#devVol').addEventListener('input', e => { try { native.setMediaVolume(+e.target.value) } catch { } paintDevVol() })
$('#btnTracks').addEventListener('click', () => { paintVol(); paintDevVol() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintDevVol() })

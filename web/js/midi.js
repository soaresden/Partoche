// Mini parseur MIDI (format 0/1) -> notes en secondes, une piste = une portée MuseScore

export function parseMidi(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let p = 0
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]); p += n; return s }
  const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f) } while (b & 0x80); return v }
  if (str(4) !== 'MThd') throw new Error('MIDI invalide')
  const hlen = dv.getUint32(p); p += 4
  const ntracks = dv.getUint16(p + 2)
  const division = dv.getUint16(p + 4)
  p += hlen
  const tracks = []
  const tempos = []
  for (let t = 0; t < ntracks && p < u8.length; t++) {
    const id = str(4); const len = dv.getUint32(p); p += 4
    const end = p + len
    if (id !== 'MTrk') { p = end; continue }
    const tr = { name: '', notes: [], programs: {}, volume: {} }
    const open = new Map()
    let tick = 0, status = 0
    while (p < end) {
      tick += vlq()
      let b = u8[p]
      if (b & 0x80) { status = b; p++ } else if (status === 0) { p++; continue }
      if (status === 0xff) {
        const type = u8[p++]; const l = vlq()
        if (type === 0x03) { tr.name = new TextDecoder().decode(u8.subarray(p, p + l)) }
        else if (type === 0x51) tempos.push({ tick, uspq: (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2] })
        p += l
        status = 0
        continue
      }
      if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l; status = 0; continue }
      const type = status & 0xf0, ch = status & 0x0f
      if (type === 0xc0 || type === 0xd0) {
        const d = u8[p++]
        if (type === 0xc0 && tr.programs[ch] == null) tr.programs[ch] = d
        continue
      }
      const d1 = u8[p++], d2 = u8[p++]
      if (type === 0x90 && d2 > 0) {
        const key = ch * 128 + d1
        const n = { tick, ch, key: d1, vel: d2, endTick: tick }
        if (!open.has(key)) open.set(key, [])
        open.get(key).push(n)
        tr.notes.push(n)
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        const q = open.get(ch * 128 + d1)
        if (q && q.length) q.shift().endTick = tick
      } else if (type === 0xb0 && d1 === 7 && tr.volume[ch] == null) {
        tr.volume[ch] = d2
      }
    }
    p = end
    tracks.push(tr)
  }
  // carte des tempos
  tempos.sort((a, b) => a.tick - b.tick)
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 })
  let acc = 0
  for (let i = 0; i < tempos.length; i++) {
    if (i > 0) acc += (tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].uspq / 1e6 / division
    tempos[i].sec = acc
  }
  const toSec = tick => {
    let lo = 0, hi = tempos.length - 1
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tempos[m].tick <= tick) lo = m; else hi = m - 1 }
    const t = tempos[lo]
    return t.sec + (tick - t.tick) * t.uspq / 1e6 / division
  }
  let duration = 0
  for (const tr of tracks) for (const n of tr.notes) {
    n.t = toSec(n.tick)
    n.d = Math.max(0.05, toSec(n.endTick) - n.t)
    duration = Math.max(duration, n.t + n.d)
  }
  return { tracks, duration }
}

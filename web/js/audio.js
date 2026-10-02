// Moteur audio : échantillons General MIDI (FluidR3) chargés à la demande + mise en cache,
// repli sur synthé intégré si hors-ligne. Volume / mute / solo par piste à la volée.

export const GM = ['acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet', 'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer', 'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion', 'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics', 'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2', 'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani', 'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit', 'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2', 'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet', 'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina', 'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead', 'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep', 'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi', 'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai', 'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal', 'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot']
const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/'
const CACHE = 'mcsz-soundfonts-v1'
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function noteToMidi(n) {
  const m = n.match(/^([A-G])(b|#)?(-?\d)$/)
  if (!m) return null
  return (parseInt(m[3], 10) + 1) * 12 + PC[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0)
}

async function fetchSoundfont(name) {
  const url = SF_BASE + name + '-mp3.js'
  let text = null
  let cache = null
  try { cache = await caches.open(CACHE) } catch { }
  if (cache) {
    try { const r = await cache.match(url); if (r) text = await r.text() } catch { }
  }
  if (!text) {
    const r = await fetch(url)
    if (!r.ok) throw new Error('soundfont ' + r.status)
    text = await r.text()
    if (cache) { try { await cache.put(url, new Response(text)) } catch { } }
  }
  const out = new Map()
  const re = /"([A-G]b?-?\d)":\s*"data:audio\/[a-z0-9]+;base64,([^"]+)"/g
  let m
  while ((m = re.exec(text))) { const k = noteToMidi(m[1]); if (k != null) out.set(k, m[2]) }
  return out
}

function b64ToBuf(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u.buffer
}

export class Player {
  constructor() {
    this.ctx = null
    this.notes = []
    this.duration = 0
    this.parts = []          // {gain, volume, muted, solo}
    this.instruments = new Map() // prog -> {samples:Map(midi->b64), buffers:Map(midi->AudioBuffer), failed}
    this.playing = false
    this.rate = 1
    this.loop = null
    this.voices = new Set()
    this.onEnd = null
    this._pos = 0
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' })
      this.master = this.ctx.createGain(); this.master.gain.value = 0.8
      const comp = this.ctx.createDynamicsCompressor()
      comp.threshold.value = -12; comp.ratio.value = 4
      this.master.connect(comp).connect(this.ctx.destination)
      const len = this.ctx.sampleRate
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const d = this.noise.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      for (const p of this.parts) this._makePartGain(p)
    }
    return this.ctx
  }

  _makePartGain(p) {
    if (!this.ctx || p.gain) return
    p.gain = this.ctx.createGain()
    p.gain.connect(this.master)
    this._applyGain(p)
  }

  /** midi: résultat parseMidi, staffToPart: tableau index piste -> index partie */
  setScore(midi, partCount, trackToPart, partState, progFor) {
    this.stop()
    for (const p of this.parts) if (p.gain) p.gain.disconnect()
    this.parts = partState.map(s => ({ volume: s.volume ?? 1, muted: !!s.muted, solo: !!s.solo, gain: null }))
    while (this.parts.length < partCount) this.parts.push({ volume: 1, muted: false, solo: false, gain: null })
    const notes = []
    midi.tracks.forEach((tr, ti) => {
      const part = trackToPart(ti, tr)
      if (part == null) return
      for (const n of tr.notes) {
        const drum = n.ch === 9
        const orig = tr.programs[n.ch] ?? 0
        const prog = drum ? -1 : (progFor ? progFor(ti, part, orig) : orig)   // son choisi par l'élève (ex. main droite au violon)
        const vol = tr.volume[n.ch] != null ? tr.volume[n.ch] / 127 : 0.8
        notes.push({ t: n.t, d: n.d, key: n.key, vel: n.vel, prog, part, vol })
      }
    })
    notes.sort((a, b) => a.t - b.t)
    this.notes = notes
    this.duration = midi.duration
    this._pos = 0
    if (this.ctx) for (const p of this.parts) this._makePartGain(p)
    this.progsNeeded = new Map()
    for (const n of notes) {
      if (n.prog < 0) continue
      if (!this.progsNeeded.has(n.prog)) this.progsNeeded.set(n.prog, new Set())
      this.progsNeeded.get(n.prog).add(n.key)
    }
  }

  /** Charge les échantillons nécessaires. onProgress(done,total) */
  async loadInstruments(onProgress) {
    const ctx = this.ensureCtx()
    const progs = Array.from(this.progsNeeded.keys())
    let done = 0
    onProgress && onProgress(0, progs.length)
    await Promise.all(progs.map(async prog => {
      let inst = this.instruments.get(prog)
      if (!inst) {
        inst = { samples: null, buffers: new Map(), failed: false }
        this.instruments.set(prog, inst)
        try { inst.samples = await fetchSoundfont(GM[prog] || GM[0]) } catch (e) { inst.failed = true }
      }
      if (inst.samples && inst.samples.size) {
        const keys = Array.from(inst.samples.keys())
        const want = new Set()
        for (const k of this.progsNeeded.get(prog)) want.add(nearest(keys, k))
        await Promise.all(Array.from(want).map(async sk => {
          if (inst.buffers.has(sk)) return
          try { inst.buffers.set(sk, await ctx.decodeAudioData(b64ToBuf(inst.samples.get(sk)))) } catch { }
        }))
      }
      done++; onProgress && onProgress(done, progs.length)
    }))
    return progs.filter(p => this.instruments.get(p).failed).length
  }

  // ---- mixage ----
  _audible(p) {
    const anySolo = this.parts.some(x => x.solo)
    return !p.muted && (!anySolo || p.solo)
  }
  _applyGain(p) {
    if (!p.gain) return
    const v = this._audible(p) ? p.volume : 0
    p.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }
  setPart(i, patch) {
    Object.assign(this.parts[i], patch)
    for (const p of this.parts) this._applyGain(p)
  }

  // ---- transport ----
  get position() {
    if (!this.playing) return this._pos
    return this.t0Score + (this.ctx.currentTime - this.t0Ctx) * this.rate
  }

  seek(t) {
    t = Math.max(0, Math.min(t, this.duration))
    if (this.playing) { this._stopVoices(); this._anchor(t) } else this._pos = t
  }

  setRate(r) {
    const pos = this.position
    this.rate = r
    if (this.playing) { this._stopVoices(); this._anchor(pos) }
  }

  setLoop(a, b) { this.loop = (a != null && b != null && b > a) ? { a, b } : null }

  _anchor(t) {
    this.t0Ctx = this.ctx.currentTime + 0.06
    this.t0Score = t
    let lo = 0, hi = this.notes.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.notes[m].t < t - 0.001) lo = m + 1; else hi = m }
    this.idx = lo
  }

  async play() {
    const ctx = this.ensureCtx()
    if (ctx.state !== 'running') await ctx.resume()
    if (this.playing) return
    if (this._pos >= this.duration - 0.05) this._pos = 0
    this.playing = true
    this._anchor(this._pos)
    this._timer = setInterval(() => this._tick(), 25)
    this._tick()
  }

  pause() {
    if (!this.playing) return
    this._pos = this.position
    this.playing = false
    clearInterval(this._timer)
    this._stopVoices()
  }

  stop() {
    this.pause()
    this._pos = this.loop ? this.loop.a : 0
  }

  _stopVoices() {
    const now = this.ctx ? this.ctx.currentTime : 0
    for (const v of this.voices) {
      try { v.g.gain.cancelScheduledValues(now); v.g.gain.setTargetAtTime(0, now, 0.015); v.src.stop(now + 0.1) } catch { }
    }
    this.voices.clear()
  }

  _tick() {
    if (!this.playing) return
    const ctx = this.ctx
    let pos = this.position
    if (this.loop && pos >= this.loop.b) {
      const over = this.t0Ctx + (this.loop.b - this.t0Score) / this.rate
      this.t0Ctx = over; this.t0Score = this.loop.a
      let lo = 0, hi = this.notes.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.notes[m].t < this.loop.a - 0.001) lo = m + 1; else hi = m }
      this.idx = lo
      pos = this.position
    }
    if (!this.loop && pos >= this.duration + 0.3) {
      this.pause(); this._pos = 0
      this.onEnd && this.onEnd()
      return
    }
    const horizon = pos + 0.25 * this.rate
    const limit = this.loop ? this.loop.b : Infinity
    while (this.idx < this.notes.length && this.notes[this.idx].t < horizon) {
      const n = this.notes[this.idx++]
      if (n.t >= limit) { this.idx = this.notes.length; break }
      const p = this.parts[n.part]
      if (!p || !this._audible(p) || p.volume <= 0) continue
      const when = Math.max(ctx.currentTime, this.t0Ctx + (n.t - this.t0Score) / this.rate)
      const dur = Math.min(n.d, (this.loop ? limit : Infinity) - n.t) / this.rate
      this._voice(n, when, Math.max(0.03, dur), p)
    }
  }

  _voice(n, when, dur, p) {
    const ctx = this.ctx
    const amp = Math.pow(n.vel / 127, 1.6) * n.vol * 0.9
    if (n.prog < 0) return this._drum(n.key, when, amp, p)
    const inst = this.instruments.get(n.prog)
    const g = ctx.createGain()
    g.connect(p.gain)
    let src
    const buf = inst && inst.buffers.size ? pickBuffer(inst, n.key) : null
    const release = n.prog < 8 || (n.prog >= 8 && n.prog < 16) || n.prog === 46 || n.prog === 45 ? 0.35 : 0.12
    if (buf) {
      src = ctx.createBufferSource()
      src.buffer = buf.buffer
      src.playbackRate.value = Math.pow(2, (n.key - buf.key) / 12)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(amp, when + 0.006)
    } else {
      src = ctx.createOscillator()
      src.type = 'triangle'
      src.frequency.value = 440 * Math.pow(2, (n.key - 69) / 12)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(amp * 0.5, when + 0.01)
    }
    g.gain.setTargetAtTime(0, when + dur, release / 3)
    src.connect(g)
    src.start(when)
    src.stop(when + dur + release * 2)
    const v = { src, g }
    this.voices.add(v)
    src.onended = () => { this.voices.delete(v); g.disconnect() }
  }

  _drum(key, when, amp, p) {
    const ctx = this.ctx
    const g = ctx.createGain(); g.connect(p.gain)
    let src, decay
    if (key === 35 || key === 36) { // grosse caisse
      src = ctx.createOscillator(); src.frequency.setValueAtTime(120, when); src.frequency.exponentialRampToValueAtTime(40, when + 0.15); decay = 0.25
    } else if ([41, 43, 45, 47, 48, 50].includes(key)) { // toms
      src = ctx.createOscillator(); const f = 80 + (key - 41) * 15; src.frequency.setValueAtTime(f * 1.5, when); src.frequency.exponentialRampToValueAtTime(f, when + 0.1); decay = 0.3
    } else {
      src = ctx.createBufferSource(); src.buffer = this.noise
      const f = ctx.createBiquadFilter()
      if (key === 38 || key === 40 || key === 37 || key === 39) { f.type = 'bandpass'; f.frequency.value = 1800; decay = 0.18 }
      else if (key === 42 || key === 44 || key === 46) { f.type = 'highpass'; f.frequency.value = 7000; decay = key === 46 ? 0.35 : 0.06 }
      else if ([49, 51, 52, 55, 57, 59].includes(key)) { f.type = 'highpass'; f.frequency.value = 5000; decay = 1.2 }
      else { f.type = 'bandpass'; f.frequency.value = 3000; decay = 0.12 }
      src.connect(f); f.connect(g)
      src._filter = f
    }
    if (!src._filter) src.connect(g)
    g.gain.setValueAtTime(amp, when)
    g.gain.exponentialRampToValueAtTime(0.001, when + decay)
    src.start(when); src.stop(when + decay + 0.05)
    const v = { src, g }
    this.voices.add(v)
    src.onended = () => { this.voices.delete(v); g.disconnect() }
  }
}

function nearest(keys, k) {
  let best = keys[0], bd = 1e9
  for (const x of keys) { const d = Math.abs(x - k); if (d < bd) { bd = d; best = x } }
  return best
}
function pickBuffer(inst, key) {
  if (inst.buffers.has(key)) return { buffer: inst.buffers.get(key), key }
  let best = null, bd = 1e9
  for (const [k, b] of inst.buffers) { const d = Math.abs(k - key); if (d < bd) { bd = d; best = { buffer: b, key: k } } }
  return best
}

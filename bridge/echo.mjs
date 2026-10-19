/**
 * Was that the owner, or the laptop's own speakers? Checked before a hands-free
 * burst goes to Scribe.
 *
 * The owner, 2026-10-12: AYRA should hear them, not a video, a laptop app or a
 * voice coming out of the speakers. Chrome's echo cancelling only removes sound
 * Chrome itself plays, so everything else reaches the microphone in full and
 * every phrase after a pause became a paid name check. The fix compares two
 * loudness curves, which needs no extra microphone and no recording:
 *
 *   - the speakers': Windows' own peak meter on the default playback device,
 *     read ~60 times a second by bridge/meter.ps1;
 *   - the burst's: its loudness every 20 ms.
 *
 * Sound from the speakers rises and falls at the microphone exactly as it did
 * at the speakers a moment earlier; the owner's voice does not. So: slide the
 * speaker curve across the moments the burst may have come from, take the best
 * match, and call it the speakers' when they were playing through most of the
 * burst AND the curves move together.
 *
 * It fails open. No meter, a gap in its numbers, too little speech to tell, an
 * error — the burst is the owner's and goes for its check as before. A missed
 * echo costs one name check; a missed owner costs being ignored.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_RATE } from './wake.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'meter.ps1')

/** One step of both loudness curves: the face's detector step (listen-worklet.js). */
export const FRAME_MS = 20
/**
 * How long before its arrival the burst may have ended, in meter time. The face
 * sends a burst the moment it ends (750 ms of quiet is inside it), so the end is
 * close to the arrival — plus the microphone's own delay, the speakers' delay
 * (Bluetooth adds up to ~0.3 s) and a busy page. Searched in FRAME_MS steps.
 */
export const LAG_MIN_MS = 0
export const LAG_MAX_MS = 1600
/** The speakers count as playing above this peak (0..1). */
export const SPEAKERS_ON = 0.02
/** …for at least this share of the burst's speech. */
export const ACTIVE_SHARE = 0.5
/**
 * …and the two curves must agree at least this well (Pearson, -1..1).
 * Measured live 2026-10-12 (real microphone, laptop speakers): three clips of
 * "Hey AYRA" played by a laptop app, another Chrome and the owner's own
 * recording matched at 0.70, 0.58 and 0.80 — 0.55 left too little room.
 */
export const MIN_CORR = 0.5
/** A match this strong is the speakers even when the microphone hears more on top. */
export const STRONG_CORR = 0.7
/** A speech step this much louder (dB) than the speakers explain is someone else talking… */
export const OVER_DB = 6
/** …and when this share of the speech steps is, it is the owner over the speakers. */
export const OVER_SHARE = 0.35
/** A 20 ms step is speech when it is within this many dB of the burst's loudest. */
const SPEECH_DB = 25
/** …and above this level at all (RMS, 0..1): a burst of near-silence is not judged. */
const SPEECH_FLOOR = 0.002
/** Fewer speech steps than this (200 ms) is too little to tell: fail open. */
const MIN_SPEECH_FRAMES = 10
/** A lag is only tried when the meter has numbers for this share of the burst. */
const COVERAGE = 0.8
/** Added before the logarithm, so silence is a floor rather than minus infinity. */
const LOG_EPS = 1e-3
/** Only the end of a burst is judged: the face never sends more than 2.5 s. */
const JUDGE_MAX_MS = 4000
/** After the meter stops on its own: wait, start it again, give up after a few quick failures. */
const RESTART_MS = 5000
const QUICK_FAIL_MS = 60_000
const MAX_QUICK_FAILS = 3

/** Int16 PCM as bytes (a Buffer or Uint8Array, little-endian, any offset) or an Int16Array. */
function sampleReader(pcm) {
  if (pcm instanceof Int16Array) return { n: pcm.length, at: (i) => pcm[i] }
  return {
    n: Math.floor(pcm.length / 2),
    at: (i) => {
      const v = pcm[2 * i] | (pcm[2 * i + 1] << 8)
      return v >= 0x8000 ? v - 0x10000 : v
    },
  }
}

/**
 * The burst's loudness: RMS (0..1) of each `frameMs` of 16 kHz PCM16. Frames
 * are counted back from the END, because the end is what lines up with the
 * arrival time; a part-frame at the start is dropped.
 */
export function micEnvelope(pcm, frameMs = FRAME_MS) {
  const { n, at } = sampleReader(pcm)
  const per = Math.round((SAMPLE_RATE * frameMs) / 1000)
  const frames = Math.floor(n / per)
  const skip = n - frames * per
  const env = new Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = skip + f * per, end = i + per; i < end; i++) {
      const x = at(i)
      sum += x * x
    }
    env[f] = Math.sqrt(sum / per) / 32768
  }
  return env
}

/** First index whose time is ≥ t (samples sorted by time). */
function firstFrom(samples, t) {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid][0] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The speakers' loudness on the burst's grid: one value per `stepMs` from
 * `fromMs` to `toMs`, from meter samples `[epochMs, peak]` sorted by time. Each
 * step is the loudest sample inside it; a step with none borrows the nearest
 * sample within one step (the meter ticks every ~16 ms and is sometimes late),
 * and is NaN — unknown — beyond that.
 */
export function resample(samples, fromMs, toMs, stepMs = FRAME_MS) {
  const n = Math.max(0, Math.round((toMs - fromMs) / stepMs))
  const out = new Array(n).fill(NaN)
  let i = firstFrom(samples, fromMs)
  for (let f = 0; f < n; f++) {
    const a = fromMs + f * stepMs
    const b = a + stepMs
    while (i < samples.length && samples[i][0] < a) i++
    let j = i
    let loudest = -1
    while (j < samples.length && samples[j][0] < b) loudest = Math.max(loudest, samples[j++][1])
    if (loudest >= 0) {
      out[f] = loudest
      continue
    }
    const mid = a + stepMs / 2
    const before = i > 0 ? samples[i - 1] : null
    const after = i < samples.length ? samples[i] : null
    const db = before ? mid - before[0] : Infinity
    const da = after ? after[0] - mid : Infinity
    if (Math.min(db, da) <= stepMs) out[f] = db <= da ? before[1] : after[1]
  }
  return out
}

/**
 * How closely two loudness curves move together: Pearson's r of their
 * logarithms (loudness is heard in ratios, and a quiet microphone copy of the
 * speakers is the same curve shifted down). Pairs with a NaN are skipped; a flat
 * curve or fewer than three pairs gives 0.
 */
export function correlate(a, b) {
  let n = 0
  let sa = 0
  let sb = 0
  const xs = []
  const ys = []
  for (let i = 0, len = Math.min(a.length, b.length); i < len; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const x = Math.log10(Math.max(0, a[i]) + LOG_EPS)
    const y = Math.log10(Math.max(0, b[i]) + LOG_EPS)
    xs.push(x)
    ys.push(y)
    sa += x
    sb += y
    n++
  }
  if (n < 3) return 0
  const ma = sa / n
  const mb = sb / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - ma
    const dy = ys[i] - mb
    cov += dx * dy
    va += dx * dx
    vb += dy * dy
  }
  if (va < 1e-12 || vb < 1e-12) return 0
  return cov / Math.sqrt(va * vb)
}

const round2 = (x) => Math.round(x * 100) / 100

/**
 * The verdict on one burst, pure.
 *
 * @param {number[]} micEnv      the burst's loudness, one value per FRAME_MS (micEnvelope)
 * @param {Array<[number, number]>} speakerSamples  meter samples [epochMs, peak], sorted
 * @param {number} arrivedAt     when the burst reached the bridge (epoch ms)
 * @param {number} [burstMs]     the burst's length (default: micEnv.length frames)
 * @returns {{ fromSpeakers: boolean, corr: number, active: number, why: string, lagMs: number | null }}
 *
 * Every lag from LAG_MIN_MS to LAG_MAX_MS is tried; a lag's score is the LOWER
 * of two matches — over the whole burst, and over its speech steps alone. The
 * whole-burst match sees the quiet-loud-quiet shape every burst has; on its own
 * it would call the owner the speakers whenever they spoke just as a video's
 * voice resumed. The speech-only match sees the syllables, which differ between
 * the owner and a video; on its own, a few steps of it match by chance. Both
 * must agree.
 */
export function judgeBurst(micEnv, speakerSamples, arrivedAt, burstMs = micEnv.length * FRAME_MS) {
  const verdict = (fromSpeakers, why, corr = 0, active = 0, lagMs = null) => ({
    fromSpeakers,
    corr: round2(corr),
    active: round2(active),
    why,
    lagMs,
  })
  const frames = micEnv.length
  if (!frames) return verdict(false, 'no audio')
  if (!speakerSamples?.length) return verdict(false, 'no speaker data')

  const loudest = Math.max(...micEnv)
  const bar = Math.max(SPEECH_FLOOR, loudest * 10 ** (-SPEECH_DB / 20))
  const speech = []
  for (let i = 0; i < frames; i++) if (micEnv[i] >= bar) speech.push(i)
  if (speech.length < MIN_SPEECH_FRAMES) return verdict(false, 'too little speech to tell')
  const micSpeech = speech.map((i) => micEnv[i])

  // The speakers over every moment the burst may have come from, once.
  const steps = Math.round(burstMs / FRAME_MS)
  const from = arrivedAt - LAG_MAX_MS - steps * FRAME_MS
  const grid = resample(speakerSamples, from, arrivedAt - LAG_MIN_MS, FRAME_MS)

  let best = null
  for (let lag = LAG_MIN_MS; lag <= LAG_MAX_MS; lag += FRAME_MS) {
    const off = Math.round((LAG_MAX_MS - lag) / FRAME_MS) + (steps - frames)
    if (off < 0 || off + frames > grid.length) continue
    const spk = grid.slice(off, off + frames)
    let known = 0
    for (const v of spk) if (Number.isFinite(v)) known++
    if (known < frames * COVERAGE) continue
    const whole = correlate(micEnv, spk)
    const inSpeech = correlate(
      micSpeech,
      speech.map((i) => spk[i]),
    )
    const score = Math.min(whole, inSpeech)
    if (!best || score > best.score) best = { score, lag, spk }
  }
  if (!best) return verdict(false, 'no speaker data')

  // Unknown steps count as silent: when in doubt, it was the owner.
  let playing = 0
  for (const i of speech) if (best.spk[i] > SPEAKERS_ON) playing++
  const active = playing / speech.length
  const over = louderThanSpeakers(micSpeech, speech.map((i) => best.spk[i]))
  const out = (fromSpeakers, why) => ({ ...verdict(fromSpeakers, why, best.score, active, best.lag), over: round2(over) })
  if (active < ACTIVE_SHARE) return out(false, 'speakers quiet')
  if (best.score < MIN_CORR) return out(false, 'a different sound')
  // The owner talking over a video: the curves still half-match, because the
  // video is in the microphone too, but many speech steps are far louder than
  // the speakers explain. Measured 2026-10-13: two bursts dropped at 0.52 and
  // 0.64 that were likely the owner. A strong match is the speakers whatever.
  if (best.score < STRONG_CORR && over >= OVER_SHARE) return out(false, 'someone talking over the speakers')
  return out(true, 'speakers')
}

/**
 * The share of speech steps where the microphone is much louder (OVER_DB)
 * than the speakers account for. Fitted, not assumed: the room, the volume and
 * the microphone's own gain set how loud the speakers come back, so the line
 * from speaker level to microphone level is fitted over this burst (log scale)
 * and only what stands well above it counts.
 */
export function louderThanSpeakers(mic, spk) {
  const n = Math.min(mic.length, spk.length)
  if (n < 2) return 0
  const x = []
  const y = []
  for (let i = 0; i < n; i++) {
    x.push(Math.log10(Math.max(Number.isFinite(spk[i]) ? spk[i] : 0, LOG_EPS)))
    y.push(Math.log10(Math.max(mic[i], LOG_EPS / 10)))
  }
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
  }
  const a = sxx > 1e-9 ? sxy / sxx : 0
  const b = my - a * mx
  let above = 0
  for (let i = 0; i < n; i++) if (y[i] - (a * x[i] + b) > OVER_DB / 20) above++
  return above / n
}

/** bridge/meter.ps1, hidden; it exits when its stdin closes. */
function spawnPowerShellMeter() {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * The speaker meter, kept running while hands-free is on, and the judge of each
 * burst against its last `keepMs` of numbers.
 *
 * @param {{ spawnMeter?: (() => import('node:child_process').ChildProcess) | null,
 *           log?: (m: string) => void, now?: () => number, keepMs?: number, restartMs?: number }} [options]
 *   spawnMeter — starts meter.ps1 (default: on Windows only; elsewhere there is
 *                no meter and every burst is the owner's)
 * @returns {{ start: () => void, stop: () => void, running: () => boolean,
 *             judge: (pcm: Uint8Array | Int16Array, arrivedAt?: number) =>
 *               { fromSpeakers: boolean, corr: number, active: number, why: string, lagMs: number | null } }}
 */
export function createSpeakerMeter({
  spawnMeter = process.platform === 'win32' ? spawnPowerShellMeter : null,
  log = () => {},
  now = Date.now,
  keepMs = 15000,
  restartMs = RESTART_MS,
} = {}) {
  let child = null
  /** Epoch ms of the meter's 0, from its last `start` line; null until the first. */
  let base = null
  let wanted = false
  let restart = null
  let quickFails = 0
  /** [epochMs, peak], oldest first; `head` skips the expired ones until a compaction. */
  let samples = []
  let head = 0

  const forget = () => {
    samples = []
    head = 0
    base = null
  }

  const take = (line) => {
    if (line.startsWith('start ')) {
      const b = Number(line.slice(6))
      if (Number.isFinite(b)) base = b
      return
    }
    if (base === null) return
    const space = line.indexOf(' ')
    if (space < 0) return
    const rel = Number(line.slice(0, space))
    const peak = Number(line.slice(space + 1))
    if (!Number.isFinite(rel) || !Number.isFinite(peak)) return
    // A fresh `start` can land a few ms off the last one: keep time moving forward.
    const last = samples.length > head ? samples[samples.length - 1][0] : -Infinity
    const t = Math.max(base + rel, last)
    samples.push([t, Math.min(1, Math.max(0, peak))])
    while (head < samples.length && t - samples[head][0] > keepMs) head++
    if (head > 1024) {
      samples = samples.slice(head)
      head = 0
    }
  }

  const launch = () => {
    if (!spawnMeter) return
    let proc
    try {
      proc = spawnMeter()
    } catch (err) {
      log(`[gnosis] speaker meter could not start (${err?.message ?? err}) — name checks go on without it`)
      return
    }
    child = proc
    forget()
    const startedAt = now()
    let buffer = ''
    let stderr = ''
    proc.stdout?.setEncoding?.('utf8')
    proc.stdout?.on('data', (chunk) => {
      if (child !== proc) return
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, at).trim())
        buffer = buffer.slice(at + 1)
      }
      // Nothing it says is ever this long; don't let a broken pipe grow forever.
      if (buffer.length > 4096) buffer = ''
    })
    proc.stderr?.setEncoding?.('utf8')
    proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-600)))
    proc.stdin?.on?.('error', () => {})
    let gone = false
    const ended = (why) => {
      if (gone) return
      gone = true
      if (child !== proc) return // stopped on purpose
      child = null
      forget()
      if (!wanted) return
      const reason = stderr.trim().split('\n')[0]?.trim() || why
      quickFails = now() - startedAt < QUICK_FAIL_MS ? quickFails + 1 : 1
      if (quickFails >= MAX_QUICK_FAILS) {
        log(`[gnosis] speaker meter keeps stopping (${reason}) — name checks go on without it`)
        return
      }
      log(`[gnosis] speaker meter stopped (${reason}) — starting it again`)
      restart = setTimeout(() => {
        restart = null
        if (wanted && !child) launch()
      }, restartMs)
      restart.unref?.()
    }
    proc.on('error', (err) => ended(err?.message ?? String(err)))
    proc.on('exit', (code) => ended(`exit ${code}`))
  }

  const running = () => child !== null && base !== null

  return {
    start() {
      wanted = true
      quickFails = 0
      clearTimeout(restart)
      restart = null
      if (!child) launch()
    },
    stop() {
      wanted = false
      clearTimeout(restart)
      restart = null
      const proc = child
      child = null
      forget()
      if (!proc) return
      try {
        proc.stdin?.end?.()
      } catch {
        // already closed
      }
      proc.kill?.()
    },
    running,
    judge(pcm, arrivedAt = now()) {
      if (!running()) return { fromSpeakers: false, corr: 0, active: 0, why: 'no meter', lagMs: null }
      try {
        const bytes = pcm instanceof Int16Array ? pcm.length * 2 : pcm.length
        const keep = Math.round((SAMPLE_RATE * 2 * JUDGE_MAX_MS) / 1000)
        const tail = bytes > keep ? pcm.subarray(pcm instanceof Int16Array ? pcm.length - keep / 2 : pcm.length - keep) : pcm
        const env = micEnvelope(tail)
        const burstMs = env.length * FRAME_MS
        const lo = firstFrom(samples, arrivedAt - LAG_MAX_MS - burstMs - 2 * FRAME_MS)
        const hi = firstFrom(samples, arrivedAt + 2 * FRAME_MS)
        return judgeBurst(env, samples.slice(Math.max(lo, head), hi), arrivedAt, burstMs)
      } catch (err) {
        return { fromSpeakers: false, corr: 0, active: 0, why: `error: ${err?.message ?? err}`, lagMs: null }
      }
    },
  }
}

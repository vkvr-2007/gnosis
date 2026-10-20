/**
 * Voice ID: Gnosis knows the owner's voice, ported from Gnosis v1 (gnosis/voice/voice_id.py), the
 * owner's list item 7. Everything here runs on the laptop; no audio goes anywhere for it.
 *
 * A voice print is a speaker embedding from NVIDIA's TitaNet (nemo_en_titanet_small, through
 * sherpa-onnx), downloaded once into the data folder. The owner says "learn my voice" and reads a
 * short passage aloud: the segments heard over the next minute (at least 12 s of speech) become the
 * print, kept in voiceprint.json. After that every spoken request is compared with it (cosine).
 * Measured 2026-10-20 on two ElevenLabs voices: the same voice scored 0.73-0.82, another 0.14-0.24;
 * a real room scores lower than clean speech, so the line is 0.45.
 *
 * Not the owner's voice: he still answers questions, but every tool except searching the web is
 * refused, in code (server.mjs wraps the gate). Typed requests and segments under a second (a
 * "yes", a "stop") are not judged.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { dataPath } from './paths.mjs'
import { createSdkMcpServer, tool } from './sdk.mjs'

export const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx'
export const MODEL_FILE = dataPath('models', 'nemo_en_titanet_small.onnx')
export const PRINT_FILE = dataPath('voiceprint.json')
export const THRESHOLD = 0.45
export const SAMPLE_RATE = 16000
/** Speech needed to learn a voice, and how long "learn my voice" listens for it. */
export const ENROL_SECONDS = 12
const ENROL_WINDOW_MS = 90_000
/** Shorter than this, a voice can't be told apart. */
const MIN_SECONDS = 1

/** A passage to read aloud for "learn my voice". */
export const PASSAGE = 'The morning light came through the window while I made a cup of coffee. ' +
  'I checked my messages, looked at the weather, and planned the rest of the day. ' +
  'There is a meeting at eleven, and later I want to finish my work and go for a walk in the evening.'

const unit = (v) => {
  const n = Math.hypot(...v)
  return n ? v.map((x) => x / n) : v
}
export const cosine = (a, b) => a.reduce((t, x, i) => t + x * b[i], 0)

/** 16-bit PCM → samples in [-1, 1], with how loud it is (RMS). */
export function toSamples(pcm) {
  const n = Math.floor(pcm.length / 2)
  const f = new Float32Array(n)
  let sq = 0
  for (let i = 0; i < n; i++) {
    f[i] = pcm.readInt16LE(i * 2) / 32768
    sq += f[i] * f[i]
  }
  return { samples: f, seconds: n / SAMPLE_RATE, rms: n ? Math.sqrt(sq / n) : 0 }
}

/** The TitaNet model: downloaded once (40 MB) from the sherpa-onnx project's releases. */
export async function ensureModel({ file = MODEL_FILE, url = MODEL_URL, fetchImpl = fetch, log = console.log } = {}) {
  if (existsSync(file)) return file
  log('[gnosis] voice ID: getting the voice model (40 MB, once)')
  mkdirSync(dirname(file), { recursive: true })
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`The voice model couldn't be downloaded (${res.status}).`)
  const tmp = `${file}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  renameSync(tmp, file)
  return file
}

/** sherpa-onnx's TitaNet, loaded on first use: (samples) → embedding. */
export async function titanet(file = MODEL_FILE) {
  const { default: sherpa } = await import('sherpa-onnx-node')
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: file, numThreads: 2 })
  return (samples) => {
    const s = ex.createStream()
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    return Array.from(ex.compute(s))
  }
}

/**
 * @param {{ file?: string, threshold?: number, embedder?: () => Promise<(samples: Float32Array) => number[]>,
 *           now?: () => number, log?: (s: string) => void }} opts
 */
export function createVoiceId({ file = PRINT_FILE, threshold = THRESHOLD, embedder = async () => titanet(await ensureModel()),
  now = Date.now, log = console.log } = {}) {
  let saved = null
  try {
    saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  } catch {
    saved = null
  }
  let embed = null
  const getEmbed = async () => (embed ??= await embedder())
  let enrolling = null // { until, prints: number[][], seconds }
  let last = null // the latest verdict: { owner, score, text, at }

  const api = {
    enrolled: () => Boolean(saved?.print),
    enrolling: () => Boolean(enrolling && now() < enrolling.until),
    /** Starts learning: the next minute and a half of speech becomes the print. */
    async startEnrolment() {
      await getEmbed() // the model first, so the owner isn't reading into nothing
      enrolling = { until: now() + ENROL_WINDOW_MS, prints: [], seconds: 0 }
      last = null
    },
    /**
     * One finished segment from the microphone. While learning, it adds to the print; otherwise it
     * is judged. Returns what happened, for the log.
     */
    async hear(pcm, text = '') {
      const { samples, seconds, rms } = toSamples(pcm)
      if (enrolling && now() < enrolling.until) {
        if (seconds < MIN_SECONDS || rms < 0.01) return { enrol: 'skipped' }
        const e = await getEmbed()
        enrolling.prints.push(unit(e(samples)))
        enrolling.seconds += seconds
        if (enrolling.seconds < ENROL_SECONDS) return { enrol: 'more', seconds: enrolling.seconds }
        const dims = enrolling.prints[0].length
        const mean = Array.from({ length: dims }, (_, i) => enrolling.prints.reduce((t, p) => t + p[i], 0) / enrolling.prints.length)
        saved = { print: unit(mean), seconds: Math.round(enrolling.seconds), segments: enrolling.prints.length, at: new Date(now()).toISOString() }
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(saved))
        enrolling = null
        log(`[gnosis] voice ID: learned the owner's voice from ${saved.seconds} s of speech`)
        return { enrol: 'done', seconds: saved.seconds }
      }
      if (enrolling) enrolling = null // the minute ran out
      if (!saved?.print || seconds < MIN_SECONDS) {
        last = null
        return { judged: false }
      }
      const e = await getEmbed()
      const score = cosine(saved.print, unit(e(samples)))
      last = { owner: score >= threshold, score, text, at: now() }
      return { judged: true, owner: last.owner, score }
    },
    /**
     * Who said this request: { owner, score } for a spoken one judged in the last 20 s whose words
     * match, otherwise null (typed, too short, or no print).
     */
    verdictFor(request) {
      if (!last || now() - last.at > 20_000) return null
      const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const a = norm(last.text)
      const b = norm(request)
      if (!a || !b || !(b.includes(a) || a.includes(b))) return null
      return { owner: last.owner, score: last.score }
    },
    forget() {
      saved = null
      enrolling = null
      last = null
      rmSync(file, { force: true })
    },
    status: () => (saved?.print ? { enrolled: true, seconds: saved.seconds, at: saved.at } : { enrolled: false }),
  }
  return api
}

/** What a guest (not the owner's voice) may still have Gnosis do: search and read the web. */
export const GUEST_TOOLS = new Set(['WebSearch', 'WebFetch', 'mcp__ayra_research__research', 'mcp__ayra_voice__voice_id_status'])

/** The voice ID tools (server ayra_voice). */
export function voiceIdServer(voice, { showText = null } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  return createSdkMcpServer({
    name: 'gnosis_voice',
    tools: [
      tool('learn_my_voice',
        'Learn the owner\'s voice, so only they can have you act ("learn my voice", "set up voice ID"). Then ask them to ' +
          'read the passage shown aloud, at their normal distance from the laptop, and stay quiet while they read.',
        {},
        async () => {
          try {
            await voice.startEnrolment()
          } catch (err) {
            return fail(`The voice model couldn't be loaded: ${err?.message ?? err}`)
          }
          showText?.('READ THIS ALOUD', PASSAGE)
          return text(`Listening for the next 90 seconds. Ask the owner to press Space and read this aloud (the passage is on screen): "${PASSAGE}"`)
        }),
      tool('voice_id_status', 'Whether you know the owner\'s voice, and since when.', {}, async () => {
        const s = voice.status()
        return text(voice.enrolling() ? 'Learning the owner\'s voice right now.'
          : s.enrolled ? `I know the owner's voice, learned from ${s.seconds} s of speech on ${s.at.slice(0, 10)}.` : 'I don\'t know the owner\'s voice yet.')
      }),
      tool('forget_my_voice', 'Forget the owner\'s voice print, turning voice ID off. The owner approves it first.', { confirm: z.boolean().optional() },
        async () => {
          voice.forget()
          return text('Forgot the voice print. Voice ID is off until it learns the voice again.')
        }),
    ],
  })
}

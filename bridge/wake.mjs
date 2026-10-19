/**
 * Her name, from any app: the wake check for hands-free mode.
 *
 * The owner, 2026-10-11: "make AYRA listen if I say AYRA from anywhere". The
 * first version spotted the name offline with sherpa-onnx; on the owner's own
 * voice it caught nothing — three clear "Hey, Aira"s in a recording, 0 hits at
 * any setting, though it caught "okay" and "play" in the same audio. Every
 * model small enough to run free on the laptop failed the same way (a 20M
 * streaming recogniser wrote "Y… I'll get bid some songs", Whisper tiny "Yeah,
 * I know"); ElevenLabs Scribe wrote "Hey, Aira." each time. So the check is
 * Scribe — kept cheap by never streaming the room:
 *
 *   - the face's own speech detector (listen-worklet.js) sends only a short
 *     burst — at most CLIP_MS — of speech that began after a quiet moment;
 *   - sound that hardly stops (music, a video, a call) is never sent at all;
 *   - a burst that came out of the laptop's own speakers (a video's voice
 *     after a pause, an app, a TTS voice) is dropped here, before the cap and
 *     before Scribe — bridge/echo.mjs compares it with the speakers' meter;
 *   - at most `perHour` checks an hour (AYRA_WAKE_CHECKS_PER_HOUR, default 120).
 *
 * The words go back to the face, and wake.ts (the one place her name and its
 * mishearings live) decides whether they are her name spoken to her.
 *
 * Protocol on `/wake` (face ↔ bridge, loopback only):
 *   face → bridge  binary: one burst, 16 kHz mono Int16 PCM
 *   bridge → face  { type: 'ready' } · { type: 'heard', text } ·
 *                  { type: 'error', code, message } (code: 'no_key' · 'limit' — the hourly cap)
 */

export const SAMPLE_RATE = 16000
/** The longest burst checked: long enough for "Hey AYRA" and a little after it. */
export const CLIP_MS = 2500
export const PER_HOUR = 120

/** Int16 PCM → a WAV file, the shape Scribe's upload takes. */
export function toWav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, Buffer.from(pcm)])
}

/** One burst through ElevenLabs Scribe; resolves to its words (or '' when it heard none). */
export async function scribe(pcm, { key, language = 'en', keyterms = [], fetchImpl = fetch } = {}) {
  const form = new FormData()
  form.append('model_id', 'scribe_v1')
  form.append('language_code', language)
  // Her name as a key term: without it the owner's "Hey Aira" came back as
  // "Hey, Aaron" or "Hey, Adam"; with it, "Hey AYRA" — and music stayed
  // "[background music]" (2026-10-11).
  for (const k of keyterms) form.append('keyterms', k)
  form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'burst.wav')
  const res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  })
  if (!res.ok) throw new Error(`Scribe ${res.status}`)
  const data = await res.json()
  return String(data?.text ?? '').trim()
}

/**
 * One face's `/wake` connection: bursts in, words out, within the hourly cap.
 *
 * @param {{ send: (d: string) => void, on: Function, close: () => void, readyState: number, OPEN: number }} client
 * @param {{ key: string | null, transcribe?: (pcm: Uint8Array) => Promise<string>,
 *           perHour?: number, now?: () => number, log?: (m: string) => void, onAudio?: (pcm: Uint8Array) => void,
 *           speakers?: { judge: (pcm: Uint8Array, arrivedAt: number) => { fromSpeakers: boolean, corr: number } } }} options
 *   transcribe — injected so tests needn't call ElevenLabs
 *   onAudio    — sees each burst (data/logs/wake.pcm when recording is on)
 *   speakers   — the speaker meter (echo.mjs createSpeakerMeter); `now` must be
 *                epoch ms when it is given, since the judge lines the burst up
 *                with the meter by its arrival time
 */
export function relayWake(client, { key, keyterms = [], language = 'en', transcribe, perHour = PER_HOUR, now = Date.now, log = () => {}, onAudio, checks = [], speakers, record = () => {} }) {
  const toFace = (msg) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(msg))
  }
  if (!key && !transcribe) {
    toFace({ type: 'error', code: 'no_key', message: 'hands-free needs the ElevenLabs key' })
    client.close()
    return
  }
  const hear = transcribe ?? ((pcm) => scribe(pcm, { key, keyterms, language }))
  /** One line of the hearing log; whatever goes wrong there, hearing goes on. */
  const note = (entry) => {
    try {
      record(entry)
    } catch {
      /* the log is for tuning, never in the way */
    }
  }
  /**
   * What the speaker meter makes of a burst (echo.mjs), or null without one.
   * Any doubt or error and it is the owner's: the meter fails open too.
   */
  const judge = (pcm, t) => {
    if (!speakers) return null
    try {
      return speakers.judge(pcm, t) ?? null
    } catch {
      return null
    }
  }
  const meterOf = (v) => (v ? { corr: v.corr, active: v.active, over: v.over, why: v.why } : {})
  toFace({ type: 'ready' })
  let warned = false
  client.on('message', async (data, isBinary) => {
    if (!isBinary) return faceNote(data)
    onAudio?.(data)
    const t = now()
    const ms = Math.round((data.length / (SAMPLE_RATE * 2)) * 1000)
    // Out of the laptop's own speakers: nobody calling her — no check,
    // nothing counted, nothing for the face.
    const v = judge(data, t)
    if (v?.fromSpeakers) {
      log(`[gnosis] wake: that burst came from the speakers (corr ${Number(v.corr).toFixed(2)}) — ignored`)
      note({ kind: 'burst', ms, result: 'speakers', ...meterOf(v) })
      return
    }
    // The hourly cap, shared by every open face (`checks` is the bridge's list).
    while (checks.length && t - checks[0] > 3_600_000) checks.shift()
    if (checks.length >= perHour) {
      note({ kind: 'burst', ms, result: 'cap' })
      if (!warned) {
        warned = true
        log(`[gnosis] wake: ${perHour} checks this hour — pausing them until the hour is up`)
        toFace({ type: 'error', code: 'limit', message: `${perHour} name checks this hour; say it again a little later, or press the hotkey` })
      }
      return
    }
    warned = false
    checks.push(t)
    // At most CLIP_MS of audio, whatever the face sent.
    const pcm = data.subarray(0, Math.round((SAMPLE_RATE * 2 * CLIP_MS) / 1000))
    try {
      const text = await hear(pcm)
      note({ kind: 'burst', ms, result: text ? 'heard' : 'nothing', text: clipped(text), checkMs: now() - t, ...meterOf(v) })
      if (text) toFace({ type: 'heard', text })
    } catch (err) {
      note({ kind: 'burst', ms, result: 'error', error: clipped(err?.message ?? String(err)) })
      log(`[gnosis] wake: ${err?.message ?? err}`)
    }
  })

  /**
   * The face's side of the story, for the same log: a stretch of speech it
   * did not send (the room was busy, no quiet before it) and what it made of
   * the words that came back (her name or not, and why not).
   */
  function faceNote(data) {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg?.type !== 'note' || !['skip', 'decision'].includes(msg.event)) return
    note({
      kind: 'face',
      event: msg.event,
      ...(typeof msg.why === 'string' ? { why: clipped(msg.why, 40) } : {}),
      ...(typeof msg.text === 'string' ? { text: clipped(msg.text) } : {}),
      ...(typeof msg.woke === 'boolean' ? { woke: msg.woke } : {}),
    })
  }
}

/** A short piece of text for the hearing log. */
const clipped = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Live hearing — the face streams the microphone here, and this streams it on
 * to ElevenLabs Scribe v2 Realtime and hands the words back as they are heard.
 *
 * Why it replaced upload-and-transcribe (2026-10-03, the owner's live test):
 * each spoken clip was recorded whole, uploaded, then transcribed — about a
 * second after the speaker stopped, every time — and the detector that decided
 * when to record ran on the page's animation clock, which Chrome pauses for a
 * tab that is not in front. Streaming fixes the first: partial words arrive
 * while the owner is still talking and the final text about 150 ms after they
 * stop. The face's AudioWorklet fixes the second.
 *
 * The relay sits in the bridge rather than the browser talking to ElevenLabs
 * directly, so the key never reaches the page and the page CSP stays closed.
 *
 * Face → bridge, on the `/listen` socket:
 *   binary            16 kHz mono PCM, 16-bit little-endian
 *   {type:'commit'}   the speaker stopped: finalise what was sent
 *   {type:'warm'}     she is about to listen: open the session now (≈0.5 s)
 * Bridge → face:
 *   {type:'partial', text}   words so far — for the caption
 *   {type:'final', text}     the finished segment
 *   {type:'error', code, message}   e.g. quota_exceeded: the face falls back
 *
 * The upstream session opens on `warm` or on the first audio, whichever comes
 * first, and closes after IDLE_MS without any (ElevenLabs also closes an idle
 * session itself after about 15 s), so a quiet room costs next to nothing.
 * Audio sent before the session is ready is held and flushed in order —
 * measured, the session starts about 0.55 s after the request.
 */

export const SAMPLE_RATE = 16000
const UPSTREAM = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
/** Close the upstream session after this long with no speech. */
const IDLE_MS = 20_000
/** ElevenLabs' own error message types — any of these is reported to the face. */
const ERRORS = new Set([
  'error', 'auth_error', 'quota_exceeded', 'rate_limited', 'resource_exhausted',
  'session_time_limit_exceeded', 'input_error', 'chunk_size_exceeded',
  'insufficient_audio_activity', 'transcriber_error', 'unaccepted_terms',
  'commit_throttled', 'queue_overflow',
])

/** The upstream URL for a language and the words to listen out for. */
export function upstreamUrl({ language = 'en', keyterms = [] } = {}) {
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: `pcm_${SAMPLE_RATE}`,
    language_code: language,
    // Ending a segment is the face's call: its detector already decides that
    // for barge-in, so one decision rather than two that can disagree.
    commit_strategy: 'manual',
  })
  for (const k of keyterms) q.append('keyterms', k)
  return `${UPSTREAM}?${q}`
}

/** One audio chunk in ElevenLabs' message shape. */
export const audioMessage = (pcm, commit = false) => ({
  message_type: 'input_audio_chunk',
  audio_base_64: pcm.length ? Buffer.from(pcm).toString('base64') : '',
  commit,
  sample_rate: SAMPLE_RATE,
})

/**
 * Relay one face connection.
 *
 * @param {{ send: (data: string) => void, on: Function, readyState: number, OPEN: number }} client
 * @param {{ key: string, language?: string, keyterms?: string[],
 *           connect?: (url: string, key: string) => any, log?: (msg: string) => void }} options
 *   connect — opens the upstream socket; injected so tests can fake it
 */
export function relayListening(client, { key, language, keyterms, connect, log = () => {} }) {
  let upstream = null
  let ready = false
  let held = [] // messages waiting for the upstream session to start
  let idle = null

  const toFace = (msg) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(msg))
  }

  const closeUpstream = () => {
    if (idle) clearTimeout(idle)
    idle = null
    const u = upstream
    upstream = null
    ready = false
    held = []
    try {
      u?.close()
    } catch {
      /* already gone */
    }
  }

  const touch = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(closeUpstream, IDLE_MS)
    idle.unref?.()
  }

  const open = () => {
    const u = connect(upstreamUrl({ language, keyterms }), key)
    upstream = u
    u.on('message', (raw) => {
      if (u !== upstream) return
      let m
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      const type = m.message_type
      if (type === 'session_started') {
        ready = true
        for (const msg of held) u.send(JSON.stringify(msg))
        held = []
      } else if (type === 'partial_transcript') {
        if (m.text) toFace({ type: 'partial', text: m.text })
      } else if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
        toFace({ type: 'final', text: m.text ?? '' })
      } else if (ERRORS.has(type) || m.error) {
        const message = String(m.error ?? m.message ?? type)
        log(`[gnosis] listen: ElevenLabs ${type}: ${message}`)
        toFace({ type: 'error', code: type, message })
        // An auth or quota failure will not cure itself mid-session.
        if (type !== 'insufficient_audio_activity' && type !== 'commit_throttled') closeUpstream()
      }
    })
    u.on('close', () => {
      if (u === upstream) {
        upstream = null
        ready = false
        held = []
      }
    })
    u.on('error', (err) => {
      if (u !== upstream) return
      log(`[gnosis] listen: upstream failed — ${err?.message ?? err}`)
      toFace({ type: 'error', code: 'unavailable', message: String(err?.message ?? err) })
      closeUpstream()
    })
  }

  const forward = (msg) => {
    if (!upstream) open()
    touch()
    if (ready) upstream.send(JSON.stringify(msg))
    else held.push(msg)
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      forward(audioMessage(data))
      return
    }
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    // A commit with nothing sent has nothing to finalise.
    if (msg.type === 'commit' && upstream) forward(audioMessage(new Uint8Array(0), true))
    if (msg.type === 'warm' && !upstream) {
      open()
      touch()
    }
  })
  client.on('close', closeUpstream)

  return { close: closeUpstream }
}

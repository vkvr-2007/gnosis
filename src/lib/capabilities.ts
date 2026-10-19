import { BRIDGE_HTTP_URL } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret.
 */

export type Capabilities = {
  /** ElevenLabs speech-to-text (Scribe) is reachable via the bridge. */
  stt: boolean
  /** ElevenLabs text-to-speech is reachable via the bridge. */
  tts: boolean
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Jarvis" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as { stt?: boolean; tts?: boolean }
      current = { stt: Boolean(h.stt), tts: Boolean(h.tts) }
      probed = true
      return current
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // boot on a health check that is only an optimisation.
  }
  probed = true
  // Asked again until the bridge answers. Gnosis starts with Windows, so his window often opens
  // before the bridge is up (or while it restarts); asked only once, he stayed on the Windows voice
  // until the window was reloaded (the owner, 2026-10-18: "eleven labs voice is not working").
  if (!retrying) {
    retrying = true
    setTimeout(() => {
      retrying = false
      void probeCapabilities()
    }, 10_000)
  }
  return current
}

let retrying = false

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.tts) return 'ElevenLabs voice'
  return 'browser speech'
}

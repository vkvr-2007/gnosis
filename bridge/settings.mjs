/**
 * The owner's settings, from the Settings screen: kept in his data folder (settings.json), so an
 * update of the app never resets them. config/identity.json holds the defaults; these override them.
 *   honorific   what Gnosis calls the owner ("Vaarsh")
 *   voiceId     the ElevenLabs voice he speaks with
 *   quietHours  "23:00-07:00", or "off": ordinary notices wait until it's over
 * The morning briefing's time is kept by the schedule (server.mjs), and the keys by secrets.mjs.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './paths.mjs'

export const SETTINGS_FILE = dataPath('settings.json')
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function readSettings(file = SETTINGS_FILE) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}

/**
 * Checks a change from the Settings screen; returns the cleaned values, or throws with a sentence
 * the owner can act on.
 */
export function cleanSettings(patch = {}) {
  const out = {}
  if ('honorific' in patch) {
    const h = String(patch.honorific ?? '').replace(/\s+/g, ' ').trim()
    if (h.length > 40) throw new Error('Your name can be at most 40 letters.')
    out.honorific = h
  }
  if ('voiceId' in patch) {
    const v = String(patch.voiceId ?? '').trim()
    if (v && !/^[A-Za-z0-9]{10,40}$/.test(v)) throw new Error('A voice ID is the letters and digits from ElevenLabs, like uPAdReDjrJ1KtAcuguzK.')
    out.voiceId = v
  }
  if ('quietHours' in patch) {
    const q = String(patch.quietHours ?? '').trim()
    const [from, to] = q.split('-')
    if (q !== 'off' && !(TIME.test(from ?? '') && TIME.test(to ?? ''))) throw new Error('Quiet hours are two times, like 23:00-07:00, or off.')
    out.quietHours = q
  }
  if ('briefing' in patch) {
    const b = String(patch.briefing ?? '').trim()
    if (b !== 'off' && !TIME.test(b)) throw new Error('The briefing time is like 08:00, or off.')
    out.briefing = b
  }
  return out
}

/** Saves changes over what is there; returns the whole settings. */
export function writeSettings(patch, file = SETTINGS_FILE) {
  const next = { ...readSettings(file), ...patch }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2))
  renameSync(`${file}.tmp`, file)
  return next
}

/** config/identity.json with the owner's settings over it. */
export function withSettings(identity, settings = readSettings()) {
  const out = structuredClone(identity)
  if (typeof settings.honorific === 'string') out.honorific = settings.honorific
  if (settings.voiceId) out.voice = { ...out.voice, elevenLabsId: settings.voiceId }
  return out
}

/**
 * The avatar face's decisions, kept apart from its drawing so they can be
 * tested without a browser: which pose AYRA takes for what the app is doing,
 * how far her mouth opens for a given loudness.
 *
 * The avatar replaced the upstream 3D reactor, which was heavy on the owner's
 * laptop (about 1.5 CPU cores and 1 GB in Chrome, 48 fps, measured
 * 2026-10-03). An SVG character animated with CSS transforms costs a small
 * fraction of that.
 */
import type { Phase } from '../store'

export type Pose =
  | 'sleep' // before INITIALISE — dozing
  | 'idle' // standing by for the wake word
  | 'wave' // booting up, or just heard her name
  | 'listen' // hand to ear while you talk
  | 'think' // finger on chin while the model works
  | 'magic' // hairpins glowing while a tool runs
  | 'talk' // lip-syncing the answer, one hand gesturing
  | 'oops' // something went wrong — worried, sweat drop
  | 'snack' // left alone long enough, she nibbles some bread

export const POSES: readonly Pose[] = ['sleep', 'idle', 'wave', 'listen', 'think', 'magic', 'talk', 'oops', 'snack']

/** What each pose shows: eyes, mouth, which arms are raised, which little effects play. */
export type Look = {
  eyes: 'open' | 'happy' | 'closed'
  mouth: 'smile' | 'talk' | 'o' | 'grin' | 'nom' | 'worried' | 'sleep'
  arms: readonly string[]
  fx: readonly string[]
}

export const LOOKS: Record<Pose, Look> = {
  sleep: { eyes: 'closed', mouth: 'sleep', arms: [], fx: ['zzz', 'phones'] },
  idle: { eyes: 'open', mouth: 'smile', arms: [], fx: [] },
  wave: { eyes: 'open', mouth: 'grin', arms: ['wave'], fx: ['sparkles'] },
  listen: { eyes: 'open', mouth: 'smile', arms: [], fx: ['phones'] }, // Gnosis: headphones on, nodding along
  think: { eyes: 'open', mouth: 'o', arms: ['think'], fx: ['dots'] },
  magic: { eyes: 'open', mouth: 'smile', arms: ['magic-l', 'magic-r'], fx: ['laptop'] },
  talk: { eyes: 'open', mouth: 'talk', arms: ['talk'], fx: [] },
  oops: { eyes: 'open', mouth: 'worried', arms: [], fx: ['sweat'] },
  snack: { eyes: 'happy', mouth: 'nom', arms: ['snack'], fx: [] },
}

/** Idle for this long and she starts snacking — then a nibble every SNACK_EVERY_MS. */
export const SNACK_AFTER_MS = 45_000
export const SNACK_EVERY_MS = 60_000
export const SNACK_FOR_MS = 6_000

/** How long a fresh error keeps her looking worried before she recovers. */
export const OOPS_FOR_MS = 3_500

/** True during the few seconds of each idle minute she spends eating. */
export function snacking(idleMs: number): boolean {
  if (idleMs < SNACK_AFTER_MS) return false
  return (idleMs - SNACK_AFTER_MS) % SNACK_EVERY_MS < SNACK_FOR_MS
}

/**
 * The pose for this moment.
 *
 * `oops` is a short reaction to a new error, not a state: a standing error such
 * as "microphone access denied" would otherwise leave her worried for the whole
 * session. The caller decides how long a reaction lasts (OOPS_FOR_MS).
 */
export function poseFor(phase: Phase, { oops = false, idleMs = 0 }: { oops?: boolean; idleMs?: number } = {}): Pose {
  switch (phase) {
    case 'offline':
      return 'sleep'
    case 'boot':
    case 'waking':
      return 'wave'
    case 'listening':
      return oops ? 'oops' : 'listen'
    case 'thinking':
      return 'think'
    case 'tooling':
      return 'magic'
    case 'speaking':
      return 'talk'
    case 'dormant':
      return oops ? 'oops' : snacking(idleMs) ? 'snack' : 'idle'
  }
}

/**
 * Mouth opening, 0..1, from the 0..1 output loudness.
 *
 * A small floor stops breath noise and silence between words from fluttering
 * the mouth, and the steps keep the face from re-rendering on every tiny
 * change of level — eight shapes read as talking; sixty do not read any better.
 */
export function mouthOpen(level: number): number {
  const v = Math.min(1, Math.max(0, (level - 0.03) * 2.4))
  return Math.round(v * 8) / 8
}

/** Milliseconds until the next blink: people blink every 2–6 s, irregularly. */
export function nextBlinkMs(random: number): number {
  return Math.round(2_400 + Math.min(1, Math.max(0, random)) * 3_600)
}

/** A `?pose=` URL override, for previewing a pose without talking. */
export function poseOverride(search: string): Pose | null {
  const p = new URLSearchParams(search).get('pose')
  return p && (POSES as readonly string[]).includes(p) ? (p as Pose) : null
}

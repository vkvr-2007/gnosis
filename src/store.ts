import { create } from 'zustand'
import type { BladeLink, DataCard, Research } from './lib/research'

export type Phase =
  | 'offline'   // waiting for the click that unlocks audio
  | 'boot'      // startup sequence
  | 'dormant'   // powered down, waiting for the wake word
  | 'waking'    // wake word hit, spin-up animation
  | 'listening' // capturing speech
  | 'thinking'  // model is generating
  | 'tooling'   // an MCP tool is running
  | 'speaking'  // reading the answer back

/**
 * A blade — the one surface AYRA puts things on: an answer's figures and its
 * sources, an article, a picture, a video. Docked they sit in a column beside
 * her; any one can be thrown full screen.
 */
export type Blade = {
  id: string
  title: string
  kind: 'article' | 'image' | 'gallery' | 'video' | 'embed' | 'markup' | 'research' | 'sources' | 'data'
  /** article / image / video / embed. */
  url?: string
  /** gallery. */
  images?: string[]
  /** markup — model-authored HTML, sanitised before it renders. */
  html?: string
  /** research — the research agent's live state (bridge/research.mjs). */
  research?: Research
  /** sources — the links the answer used: at most five, eight in researcher mode. */
  links?: BladeLink[]
  /** data — the figures that answer the question. */
  data?: DataCard
  /**
   * article: the words restyled ('reader') or the real page ('live').
   * data: where the answer came from ('live', or a saved run: 'cache', 'offline').
   */
  mode?: 'reader' | 'live' | 'cache' | 'offline'
  /** data, from a saved run: when it was saved (ISO). */
  savedAt?: string
  /** data: the answer's confidence in words, "High (82%)". */
  confidence?: string
  /** The id of a card this one takes the place of (a research progress card). */
  replaces?: string
  /** 'long': two minutes before it closes by itself, whatever its hold. */
  life?: 'long'
  size: 'compact' | 'tall' | 'wide' | 'full'
  hold: 'turn' | 'sticky'
  /** The owner pressed Keep: it stays, through the next answer too. */
  kept?: boolean
}

/** Something AYRA wants to do that the owner chose to be asked about first. */
export type Approval = {
  id: string
  /** What kind of thing it is — "deletes something for good". */
  reason: string
  /** Exactly what would happen — the command, the file, the button. */
  detail: string
  tool: string
  /** "Always on linkedin.com" when it can be allowed ahead of time, else ''. */
  always?: string
}

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** What of `text` she said out loud (the rest is in her log only — bridge/spoken.mjs). */
  said?: string
  /** Tool names invoked while producing this turn, for the HUD readout. */
  tools?: string[]
}

/** How she listens: Space each time, or her name from anywhere (hands-free). */
export type Hearing = 'push' | 'hands-free'

/**
 * Who answers (the owner, 2026-10-12: "keep AYRA as it is and add this research
 * agent module as an option, so when I press R she goes into researcher mode").
 * 'normal' is AYRA as she always was; 'research' sends every question to the
 * researcher (bridge/deep.mjs) — sub-agents over Reddit, Quora, GitHub and the
 * rest, their results ranked, one answer.
 */
export type Mode = 'normal' | 'research'

/** Remembered per browser, like how she listens ('ayra.hearing'). */
export const MODE_KEY = 'ayra.mode'

/** A remembered mode, whatever was stored there: only 'research' turns it on. */
export function parseMode(saved: unknown): Mode {
  return saved === 'research' ? 'research' : 'normal'
}

/**
 * What she says as the mode changes. Never her own name: in hands-free the
 * spotter would hear her say it and wake on her own voice.
 */
export function modeLine(mode: Mode): string {
  return mode === 'research'
    ? "Researcher mode. Ask me anything and I'll dig through Reddit, Quora, GitHub and the rest."
    : 'Back to normal mode.'
}

/**
 * The ask frame the face sends (src/lib/bridge.ts). Researcher mode names
 * itself; a normal question's frame is exactly what it always was, so a bridge
 * that knows nothing of modes reads it as before.
 */
export function askFrame(
  text: string,
  id: string,
  mode: Mode = 'normal',
): { type: 'ask'; text: string; id: string; mode?: 'research' } {
  return mode === 'research' ? { type: 'ask', text, id, mode: 'research' } : { type: 'ask', text, id }
}

type State = {
  phase: Phase
  hearing: Hearing
  /** Normal, or researcher mode (R). */
  mode: Mode
  /** 0..1 loudness — the mic, or AYRA's own voice while she speaks. */
  level: number
  /** What JARVIS is currently reading aloud or has just said. */
  caption: string
  turns: Turn[]
  activeTool: string | null
  error: string | null
  connected: string[]
  /** Name of the speech-synthesis voice in use, shown in the HUD. */
  voice: string
  /** Blades currently open, oldest first — the history, not the screen order (see dockOrder). */
  blades: Blade[]
  /** The blade the user has pulled forward, or null for "the top one". */
  focusedBlade: string | null
  /** A blade thrown to full screen, or null. */
  expandedBlade: string | null
  /**
   * Ids of cards that have closed. A late update for one of them (the research
   * engine's last progress frame, a frame still in flight when the owner
   * pressed X) must not bring it back.
   */
  gone: ReadonlySet<string>
  /** Actions waiting for the owner's yes, oldest first. */
  approvals: Approval[]

  setVoice: (v: string) => void
  pushBlade: (b: Blade) => void
  closeBlade: (id: string) => void
  clearBlades: () => void
  /** Keep (or let go of) a card: kept cards never close by themselves or with the next turn. */
  keepBlade: (id: string, kept: boolean) => void
  focusBlade: (id: string | null) => void
  expandBlade: (id: string | null) => void
  addApproval: (a: Approval) => void
  removeApproval: (id: string) => void
  clearApprovals: () => void
  setPhase: (p: Phase) => void
  setHearing: (h: Hearing) => void
  setMode: (m: Mode) => void
  setLevel: (l: number) => void
  setCaption: (c: string) => void
  setActiveTool: (t: string | null) => void
  setError: (e: string | null) => void
  setConnected: (c: string[]) => void
  pushTurn: (t: Turn) => void
  /** `spoken` false: shown in her log, not said (the bubble's caption follows what is said). */
  appendToLastTurn: (text: string, spoken?: boolean) => void
}

/**
 * Six is the ceiling: three show in the dock and the rest wait their turn, and
 * past six the waiting ones are history nobody will come back to. The oldest
 * falls off — never a kept card, nor a research run still going.
 */
export const MAX_BLADES = 6

/** How many closed ids are remembered. Ids are unique per card, so this only bounds memory. */
const GONE_MAX = 300

/** A card the 6-cap may not take away. */
function protectedCard(b: Blade): boolean {
  return b.kept === true || (b.kind === 'research' && b.research?.status === 'running')
}

/** The closed set with these ids added, oldest forgotten first. */
function remember(gone: ReadonlySet<string>, ids: string[]): ReadonlySet<string> {
  if (!ids.length) return gone
  const next = new Set(gone)
  for (const id of ids) {
    next.delete(id)
    next.add(id)
  }
  for (const id of next) {
    if (next.size <= GONE_MAX) break
    next.delete(id)
  }
  return next
}

/** Focus and full screen let go of a card that is no longer there. */
function settle(
  s: Pick<State, 'focusedBlade' | 'expandedBlade'>,
  blades: Blade[],
): Pick<State, 'focusedBlade' | 'expandedBlade'> {
  const alive = (id: string | null) => (id && blades.some((b) => b.id === id) ? id : null)
  return { focusedBlade: alive(s.focusedBlade), expandedBlade: alive(s.expandedBlade) }
}

/**
 * The docked column, top to bottom: the research progress card, then the
 * figures, then the sources, then anything else — newest first within a kind —
 * so an answer's two cards always sit together at the top. The first `max` are
 * shown; the rest wait until those close.
 */
const DOCK_RANK: Partial<Record<Blade['kind'], number>> = { research: 0, data: 1, sources: 2 }

export function dockOrder(blades: Blade[], max = 3): { visible: Blade[]; hidden: Blade[] } {
  const ordered = blades
    .map((b, i) => ({ b, i, rank: DOCK_RANK[b.kind] ?? 3 }))
    .sort((x, y) => x.rank - y.rank || y.i - x.i)
    .map((x) => x.b)
  return { visible: ordered.slice(0, max), hidden: ordered.slice(max) }
}

/**
 * Whether a blade frame belongs on screen (src/lib/bridge.ts). The bridge
 * stamps each one with the turn it came from (`ask`); a frame from a turn the
 * owner has already talked over — a slow search landing after the next
 * question — is dropped rather than put up beside the new answer. An
 * unstamped frame is no turn's in particular and always passes.
 */
export function bladeIsCurrent(ask: unknown, current: string | null): boolean {
  if (typeof ask !== 'string' || !ask) return true
  return ask === current
}

/**
 * Cards close by themselves (the owner, 2026-10-06: "it's not closing itself").
 * Long enough to read a handful of results; a sticky card or a research result
 * ('long') stays two minutes. A finished research progress card goes almost at
 * once — its results are already up beside it.
 */
export const TURN_MS = 40_000
export const LONG_MS = 120_000
export const RESEARCH_DONE_MS = 3_000

/**
 * How long a card stays before closing by itself, or null for never. A page, a
 * video or a player is something to read or watch, not glance at, so those
 * never close on their own; nor does a research run that is still going. A
 * finished researcher-mode board is the report itself, not a progress card:
 * the bridge sends it once more with `life: 'long'`, and it stays.
 */
export function bladeLife(blade: Blade): number | null {
  if (blade.kind === 'article' || blade.kind === 'video' || blade.kind === 'embed') return null
  if (blade.kind === 'research') {
    const status = blade.research?.status
    if (status === 'running') return null
    if (status === 'done') return blade.life === 'long' ? LONG_MS : RESEARCH_DONE_MS
  }
  if (blade.life === 'long' || blade.hold === 'sticky') return LONG_MS
  return TURN_MS
}

export const useStore = create<State>((set) => ({
  phase: 'offline',
  hearing: 'push',
  mode: 'normal',
  level: 0,
  caption: '',
  turns: [],
  activeTool: null,
  error: null,
  connected: [],
  voice: '',
  blades: [],
  focusedBlade: null,
  expandedBlade: null,
  gone: new Set<string>(),
  approvals: [],

  setVoice: (voice) => set({ voice }),
  /**
   * A blade with an id already on screen is an update: it is replaced where it
   * stands and the focus stays where the owner left it (the research card
   * updates five times a second; stealing focus each time would make [ and ]
   * useless). Only a new id is appended and focused.
   *
   * `replaces` closes that card in the same update, so the research progress
   * card and its results never flash up together. A new data or sources card
   * closes the older ones of its kind — one answer's figures on screen, not
   * three answers'. A card that has closed stays closed.
   */
  pushBlade: (blade) =>
    set((s) => {
      if (!blade || typeof blade.id !== 'string' || !blade.id || s.gone.has(blade.id)) return {}
      const at = s.blades.findIndex((b) => b.id === blade.id)
      if (at >= 0) {
        const old = s.blades[at]
        const blades = [...s.blades]
        blades[at] = { ...blade, kept: old.kept === true || blade.kept === true }
        const closed = blade.replaces && blade.replaces !== blade.id ? [blade.replaces] : []
        const next = blades.filter((b) => !closed.includes(b.id))
        return { blades: next, gone: remember(s.gone, closed), ...settle(s, next) }
      }

      const closed = new Set<string>()
      if (blade.replaces && blade.replaces !== blade.id) closed.add(blade.replaces)
      if (blade.kind === 'data' || blade.kind === 'sources') {
        for (const b of s.blades) if (b.kind === blade.kind && !b.kept) closed.add(b.id)
      }
      let next = [...s.blades.filter((b) => !closed.has(b.id)), blade]
      // Over the cap: the oldest card the cap may take, until under it or none is left.
      while (next.length > MAX_BLADES) {
        const victim = next.findIndex((b) => b !== blade && !protectedCard(b))
        if (victim < 0) break
        closed.add(next[victim].id)
        next = next.filter((_, i) => i !== victim)
      }
      const left = settle(s, next)
      return { blades: next, gone: remember(s.gone, [...closed]), ...left, focusedBlade: blade.id }
    }),
  closeBlade: (id) =>
    set((s) => {
      const next = s.blades.filter((b) => b.id !== id)
      return { blades: next, gone: remember(s.gone, [id]), ...settle(s, next) }
    }),
  // 'turn' blades go when the user speaks again,
  // 'sticky' ones stay until something replaces them.
  clearBlades: () =>
    set((s) => {
      const next = s.blades.filter((b) => b.hold === 'sticky' || b.kept)
      const cleared = s.blades.filter((b) => !next.includes(b)).map((b) => b.id)
      return { blades: next, gone: remember(s.gone, cleared), ...settle(s, next) }
    }),
  keepBlade: (id, kept) => set((s) => ({ blades: s.blades.map((b) => (b.id === id ? { ...b, kept } : b)) })),
  focusBlade: (focusedBlade) => set({ focusedBlade }),
  expandBlade: (expandedBlade) => set({ expandedBlade }),
  addApproval: (a) =>
    set((s) => (s.approvals.some((x) => x.id === a.id) ? {} : { approvals: [...s.approvals, a] })),
  removeApproval: (id) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })),
  clearApprovals: () => set({ approvals: [] }),
  setPhase: (phase) => set({ phase }),
  setHearing: (hearing) => set({ hearing }),
  setMode: (mode) => set({ mode: parseMode(mode) }),
  setLevel: (level) => set({ level }),
  setCaption: (caption) => set({ caption }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setError: (error) => set({ error }),
  setConnected: (connected) => set({ connected }),
  pushTurn: (turn) => set((s) => ({ turns: [...s.turns.slice(-40), turn] })),
  appendToLastTurn: (text, spoken = true) =>
    set((s) => {
      const turns = [...s.turns]
      const last = turns[turns.length - 1]
      if (!last || last.role !== 'assistant') return {}
      turns[turns.length - 1] = { ...last, text: last.text + text, said: (last.said ?? '') + (spoken ? text : '') }
      return { turns }
    }),
}))

/** Colour identity per phase — shared by the avatar and the HUD. */
/**
 * Gnosis says what state he is in with words and motion, not colour (AYRA had a colour per phase):
 * one amber accent throughout, dimmer only while off or waking.
 */
export const phaseColor: Record<Phase, string> = {
  offline: '#6c7078',
  boot: '#ef9a4c',
  dormant: '#ef9a4c',
  waking: '#ef9a4c',
  listening: '#ef9a4c',
  thinking: '#ef9a4c',
  tooling: '#ef9a4c',
  speaking: '#ef9a4c',
}

/** What colour the interface is right now. */
export function accentFor(phase: Phase): string {
  return phaseColor[phase]
}

// Handy while dressing the scene for camera: in the dev server you can drive
// the visuals from the console without talking, e.g.
//   __ayra.setPhase('tooling'); __ayra.setLevel(0.8)
// `env?.` because the unit tests load this file in Node, where Vite's
// `import.meta.env` does not exist.
if (import.meta.env?.DEV) {
  // Not `useStore.getState()` directly: zustand replaces the state object on
  // every set, so a captured snapshot's *actions* keep working while every
  // data field reads forever as it was at module load. `__ayra.phase` said
  // 'offline' no matter what was on screen.
  ;(window as unknown as Record<string, unknown>).__ayra = new Proxy(
    {} as Record<string, unknown>,
    {
      get: (_t, key) => (useStore.getState() as Record<string | symbol, unknown>)[key],
      has: (_t, key) => key in useStore.getState(),
      ownKeys: () => Reflect.ownKeys(useStore.getState()),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  )
}

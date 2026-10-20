import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, type Phase } from '../store'
import { answerApproval } from '../lib/bridge'
import { Suggestions } from './Suggestions'
import { Blades } from './Blades'
import { IDENTITY } from '../identity'
import { toolPhrase } from '../lib/toolphrase'

export { toolPhrase }

/**
 * Gnosis's interface (gnosis.css).
 *
 * Built on AYRA's, with its behaviour kept and its look replaced: Gnosis stands on the left, the
 * conversation reads as a calm column on the right, the state is a word in a pill rather than a
 * colour change, and what a tool is doing is a line in the conversation rather than a banner.
 * Sentence case throughout; one warm accent.
 */

const statusText: Record<Phase, string> = {
  offline: 'Off',
  boot: 'Waking up',
  dormant: 'Ready',
  waking: 'Here',
  listening: 'Listening',
  thinking: 'Thinking',
  tooling: 'Working on it',
  speaking: 'Speaking',
}

const hintFor: Partial<Record<Phase, string>> = {
  dormant: 'Press Space to talk',
  listening: 'Space to send',
  speaking: 'Esc to stop',
}

/** A control that presses its keyboard key, so the button and the key can never disagree. */
function KeyButton({ k, code, kbd, label, on }: { k: string; code: string; kbd: string; label: string; on?: boolean }) {
  return (
    <button
      type="button"
      className={on ? 'g-key g-key-on' : 'g-key'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true }))}
      title={`${label} (${kbd})`}
    >
      <kbd>{kbd}</kbd> {label}
    </button>
  )
}

/* ------------------------------------------------------------- word reveal */

/**
 * Gnosis's replies arrive a word at a time, fading in as they stream, where AYRA's decoded out of
 * glyph noise. Only the words not yet shown animate: a token landing mid-reply never restarts the
 * ones before it, and the full sentence is always in the DOM for screen readers.
 */
function WordReveal({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const shown = useRef(0)
  const words = text.split(/(\s+)/)
  const before = shown.current
  useEffect(() => {
    shown.current = words.length
  })
  if (reduced) return <>{text}</>
  return (
    <>
      {words.map((w, i) =>
        i < before || /^\s+$/.test(w) ? (
          <span key={i}>{w}</span>
        ) : (
          <span key={i} className="word-in" style={{ animationDelay: `${Math.min(i - before, 12) * 28}ms` }}>
            {w}
          </span>
        ),
      )}
    </>
  )
}

/* ----------------------------------------------------------------- level */

/**
 * Five small bars that follow the microphone and the voice, written straight onto the elements so the
 * interface doesn't re-render on every level change (AYRA's SIGNAL meter did the same, as a rail).
 */
function LevelBars() {
  const bars = useRef<HTMLSpanElement[]>([])
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.level === prev.level) return
        bars.current.forEach((b, i) => {
          const shape = [0.55, 0.85, 1, 0.8, 0.5][i]
          if (b) b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, s.level * 1.6 * shape))})`
        })
      }),
    [],
  )
  return (
    <span className="level" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => { if (el) bars.current[i] = el }} />
      ))}
    </span>
  )
}

/* ----------------------------------------------------------------- approve */

/**
 * The owner's Approve card: what Gnosis wants to do, exactly, and why he asks.
 * Yes / No by click, by the Y and N keys, or by saying it. Only the oldest is
 * shown; the rest wait their turn.
 */
function ApproveCard() {
  const waiting = useStore((s) => s.approvals[0])
  const more = useStore((s) => s.approvals.length - 1)
  const removeApproval = useStore((s) => s.removeApproval)
  if (!waiting) return null
  const pick = (ok: boolean, always = false) => {
    answerApproval(waiting.id, ok, always)
    removeApproval(waiting.id)
  }
  return (
    <div className="approve" role="alertdialog" aria-label="Approve this action">
      <div className="approve-kicker">{IDENTITY.name} wants to do something that {waiting.reason}</div>
      <div className="approve-detail">{waiting.detail || waiting.tool}</div>
      <div className="approve-acts">
        <button className="approve-yes" onClick={() => pick(true)}>
          Allow <kbd>Y</kbd>
        </button>
        <button className="approve-no" onClick={() => pick(false)}>
          Don't <kbd>N</kbd>
        </button>
        {waiting.always && (
          <button className="approve-always" onClick={() => pick(true, true)} title="Yes, and don't ask again here">
            {waiting.always} <kbd>A</kbd>
          </button>
        )}
        {more > 0 && <span className="approve-more">{more} more waiting</span>}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const hearing = useStore((s) => s.hearing)
  const mode = useStore((s) => s.mode)
  const researching = mode === 'research'
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)

  const handsFree = hearing === 'hands-free'
  const status = researching && (phase === 'thinking' || phase === 'tooling') ? 'Researching' : statusText[phase]
  const hint = phase === 'dormant' && handsFree ? `Say "${IDENTITY.name}" or press Space` : hintFor[phase]

  return (
    <div className="hud" data-phase={phase}>
      {/* No tool "sweep" (AYRA's diagonal streaks and the raw tool name): the activity line in the
          conversation says what is happening, in words. */}

      <header className="g-top">
        <div className="g-brand">
          <img className="g-mark" src="/favicon.svg" alt="" />
          <span className="g-name">{IDENTITY.name}</span>
        </div>
        <div className="g-status" role="status">
          <LevelBars />
          <span className="g-status-word">{status}</span>
          {hint && <span className="g-status-hint">{hint}</span>}
        </div>
        <div className="g-modes">
          {handsFree && <span className="g-chip">Hands-free</span>}
          {researching && (
            <span className="g-chip" title="Researcher mode, R to turn it off">
              Researcher
            </span>
          )}
        </div>
      </header>

      {/* The conversation: the last few exchanges, newest at the bottom. */}
      <section className="g-convo" aria-live="polite">
        <AnimatePresence initial={false}>
          {turns.slice(-4).map((t, i, shownTurns) => (
            <motion.div
              key={t.id}
              className={`g-turn g-${t.role}${i < shownTurns.length - 2 ? ' g-older' : ''}`}
              layout="position"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
            >
              <span className="g-who">{t.role === 'user' ? 'You' : IDENTITY.name}</span>
              <p className="g-text">{t.role === 'assistant' ? <WordReveal text={t.text} /> : t.text}</p>
            </motion.div>
          ))}
        </AnimatePresence>

        <AnimatePresence>
          {caption && (
            <motion.p className="g-caption" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {caption}
            </motion.p>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {activeTool && (
            <motion.div
              className="g-activity"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <span className="g-activity-pulse" aria-hidden="true" />
              {toolPhrase(activeTool)}
            </motion.div>
          )}
        </AnimatePresence>

        {!turns.length && !caption && phase === 'dormant' && (
          <p className="g-empty">Ask about anything: the weather, a video to play, a file, a question to research.</p>
        )}

        {error && <p className="g-error">{error}</p>}
      </section>

      {/* The one surface: everything Gnosis shows lands here. */}
      <Blades />

      <ApproveCard />

      <Suggestions />

      {/* Every key has a button too (the owner, 2026-10-20). A button presses its key, so each does
          exactly what the key does; it never takes the focus, so Space can't click it afterwards. */}
      <nav className="g-keys" aria-label="Controls">
        <KeyButton k=" " code="Space" kbd="Space" label="Talk" />
        <KeyButton k="Escape" code="Escape" kbd="Esc" label="Stop" />
        <KeyButton k="w" code="KeyW" kbd="W" label={`Hands-free ${handsFree ? 'on' : 'off'}`} on={handsFree} />
        <KeyButton k="r" code="KeyR" kbd="R" label={`Researcher ${researching ? 'on' : 'off'}`} on={researching} />
        <KeyButton k="s" code="KeyS" kbd="S" label="Settings" />
        <KeyButton k="y" code="KeyY" kbd="Y" label="Your data" />
        <KeyButton k="d" code="KeyD" kbd="D" label="Diagnostics" />
      </nav>
    </div>
  )
}

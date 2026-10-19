import { useEffect, useRef } from 'react'
import { Avatar } from './ui/Avatar'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore, MODE_KEY, modeLine, parseMode, type Hearing, type Mode, type Phase } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, prefetchLines } from './lib/tts'
import * as sfx from './lib/sfx'
import { forTool, attention, COMMON_LINES } from './lib/fillers'
import {
  ask,
  warmBridge,
  warmBrain,
  interrupt,
  watchServers,
  watchBlades,
  watchApprovals,
  answerApproval,
  haltAll,
  watchConnection,
  watchHearing,
  watchTalk,
  watchNotice,
  media,
  reportHearing,
  reportFace,
  bridgeServers,
} from './lib/bridge'
import { inputLevel } from './lib/listen'
import { glance, sameGlance, type Glance } from './lib/glance'
import { probeCapabilities } from './lib/capabilities'
import { BARE_NAME, LEADING_NAME, addressed, afterWake, onlyName } from './lib/wake'
import { withHonorific } from './identity'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/**
 * Push-to-talk (the owner, 2026-10-06): "she keeps listening, which is not
 * necessary… only listen when I press the space bar once and stop when I hit it
 * twice" — and an open microphone heard the videos playing in other tabs and
 * answered them. So: Space once listens, Space again sends, two quick presses
 * stop everything. No wake word, no follow-up window, no voice barge-in.
 */
const DOUBLE_TAP_MS = 400

/** Once the owner is talking, the "nobody spoke" timeout gives way to this ceiling. */
const LONGEST_TURN_MS = 60000

/**
 * A pause sends a turn by itself; a Space pressed this soon after is the owner
 * meaning "send" a moment late — not an interruption of what they just asked.
 */
const SEND_GRACE_MS = 1500

/**
 * Hands-free (the owner, 2026-10-11: "build another feature where she listens
 * and waits for me to command again when I'm actively working… design it so
 * she starts listening if I say AYRA from anywhere"). Space stays as it is; W
 * (or Ctrl+Alt+W / the tray from any app) switches hands-free on: an offline
 * spotter listens for her name (bridge/wake.mjs), she answers, and then keeps
 * listening this long for a follow-up without her name before going back to
 * waiting for it. Short on purpose: a video playing nearby can't hold her.
 */
const FOLLOW_UP_MS = 15000

/** A follow-up that only ends the conversation — no question for the model. */
const DISMISS = /^(that'?s (all|it)|thanks?|thank you|nothing|no thanks|never ?mind|stop|bye|okay,? thanks?)[\s.!]*$/i

/** Push-to-talk or hands-free, remembered per browser. */
const HEARING_KEY = 'ayra.hearing'
const savedHearing = (): Hearing => {
  try {
    return localStorage.getItem(HEARING_KEY) === 'hands-free' ? 'hands-free' : 'push'
  } catch {
    return 'push'
  }
}

/** Normal or researcher mode (R), remembered per browser the same way. */
const savedMode = (): Mode => {
  try {
    return parseMode(localStorage.getItem(MODE_KEY))
  } catch {
    return 'normal'
  }
}

/** How long the boot sequence (Boot.tsx) stays up. It only has to cover the
 *  bridge connecting and the voice probe; the old nine seconds were pure wait. */
const BOOT_MS = 2400
/** The bubble's report: at most this often while words stream (lib/glance.ts). */
const GLANCE_MS = 150

/** A spoken answer to an Approve card. Hindi yes/no too — the owner's own words. */
const SAID_YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|allow( it)?|approve(d)?|confirm(ed)?|haan|ha)\b/i
const SAID_NO = /^(no|nope|nah|don'?t|do not|cancel|stop|deny|decline|nahi|na)\b/i

/** "Still" mode (the L key): no animation, no level pump. Remembered per browser. */
const STILL_KEY = 'ayra.still'
const still = () => document.documentElement.dataset.still === '1'
function setStill(on: boolean) {
  document.documentElement.dataset.still = on ? '1' : '0'
  try {
    localStorage.setItem(STILL_KEY, on ? '1' : '0')
  } catch {
    /* not remembered this time, nothing worse */
  }
}
try {
  setStill(localStorage.getItem(STILL_KEY) === '1')
} catch {
  setStill(false)
}

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

// BARE_NAME and LEADING_NAME come from wake.ts — the same mishearings the voice
// loop wakes on, so a turn that woke on "Aira" never sends that word on to the
// model as a question.

export default function App() {
  const store = useStore
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  /** When Space was last pressed, for the double press that stops everything. */
  const lastSpace = useRef(0)
  /**
   * The phase to go back to after listening, when a turn is still in flight —
   * the owner opened the mic to answer its Approve card. Standby would abandon
   * the answer that is waiting on that card.
   */
  const resumeTo = useRef<Phase | null>(null)
  /** When the last turn was sent (performance.now()), for SEND_GRACE_MS. */
  const sentAt = useRef(0)
  /** Speech has begun in this listening window (the ceiling is set once). */
  const heard = useRef(false)
  /** This listening window was opened by the spotter hearing her name. */
  const wokeByName = useRef(false)
  /** This listening window is the hands-free follow-up after an answer. */
  const followUp = useRef(false)
  /**
   * Music paused for listening (the owner, 2026-10-11: she was answering
   * Spotify's lyrics). Resumed only once she is really back on standby — a
   * follow-up window right after an answer keeps it paused.
   */
  const mediaPaused = useRef(false)
  const mediaTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pauseMedia = () => {
    if (mediaTimer.current) clearTimeout(mediaTimer.current)
    mediaTimer.current = null
    if (mediaPaused.current) return
    mediaPaused.current = true
    media('pause')
  }
  const resumeMediaSoon = () => {
    if (!mediaPaused.current || mediaTimer.current) return
    mediaTimer.current = setTimeout(() => {
      mediaTimer.current = null
      if (store.getState().phase !== 'dormant') return
      mediaPaused.current = false
      media('resume')
    }, 800)
  }
  /** Space — or the tray's talk hotkey from any app — one press. */
  const press = useRef<() => void>(() => {})
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    resumeTo.current = null
    wokeByName.current = false
    followUp.current = false
    voice.current?.close()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    sfx.duck(false)
    s.setPhase('dormant')
    resumeMediaSoon()
  }

  /** Open the mic and wait. `window` is how long before she gives up.
   *  `from: 'name'` — the spotter heard her name: listening starts from just
   *  before it (the microphone is already open), with no cue to wait for. */
  const listen = (window: number, from: 'press' | 'name' = 'press') => {
    clearIdle()
    heard.current = false
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    pauseMedia()
    // Wake a napping brain now, not when speech is first heard: its ~3.7 s
    // start-up then overlaps the whole question (free when it is awake).
    warmBrain()
    if (from === 'name') {
      voice.current?.wake()
    } else {
      // The cue once the microphone is really open: a cold start takes a moment,
      // and words said before the cue would be lost.
      void Promise.resolve(voice.current?.open()).then(() => {
        if (store.getState().phase === 'listening') sfx.play('listen')
      })
    }
    idleTimer.current = setTimeout(stopListening, window)
  }

  /** Listening ends without a new turn: standby — or back to the turn that is
   *  still waiting on an Approve card. */
  const stopListening = () => {
    clearIdle()
    voice.current?.close()
    const back = resumeTo.current
    resumeTo.current = null
    if (!back) return goDormant()
    store.getState().setCaption('')
    store.getState().setPhase(back)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    resumeTo.current = null
    sentAt.current = performance.now()

    clearIdle()
    const s = store.getState()
    // Last turn's blades go now, before the new answer starts putting its own
    // up. Anything the model marked sticky survives.
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)

    const turnId = newId()
    let started = false
    let shown = false
    let filled = false

    try {
      // Researcher mode is read as the question goes out: R pressed mid-answer
      // changes the next question, never the one in flight.
      await ask(said, {
        onText: (delta, quiet) => {
          if (stale()) return
          if (!shown) {
            shown = true
            store.getState().pushTurn({ id: turnId, role: 'assistant', text: '', said: '' })
          }
          // Quiet words (details, a task's answer past its first lines) go in
          // her log only; she speaks the rest (bridge/spoken.mjs).
          if (!quiet && !started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
          }
          store.getState().appendToLastTurn(delta, !quiet)
          if (!quiet) spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the avatar's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, store.getState().mode)

      if (stale()) return

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        store.getState().setActiveTool(null)
        goDormant()
        // Hands-free: she stays for a follow-up without her name, then goes
        // back to waiting for it. Push-to-talk: closed until Space.
        if (store.getState().hearing === 'hands-free') {
          followUp.current = true
          listen(FOLLOW_UP_MS)
        }
      }
    }
  }

  // -- the owner's Approve ---------------------------------------------------

  /** Answer an Approve card; the bridge tells every screen it is settled. */
  const answer = (id: string, ok: boolean, always = false) => {
    // The mic was opened to answer this card: the answer is in, so it closes.
    if (resumeTo.current && store.getState().phase === 'listening') stopListening()
    answerApproval(id, ok, always)
    store.getState().removeApproval(id)
    sfx.play(ok ? 'done' : 'error')
  }

  /** The kill switch: everything waiting declined, everything running stopped. */
  const halt = () => {
    haltAll()
    store.getState().clearApprovals()
    if (store.getState().phase !== 'offline') goDormant()
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    // Waiting on the owner's yes: whatever they say is the answer, never an
    // interruption that would cancel the very action being asked about.
    // Push-to-talk: words count only while Space has her listening — never a
    // wake word, never a video in another tab talking over her answer.
    switch (store.getState().phase) {
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'deaf'
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    // Answering an Approve card is not a barge-in.
    if (store.getState().approvals.length) return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      sfx.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    // One press, one turn: the microphone closes as soon as the words are in.
    voice.current?.close()
    const woke = wokeByName.current
    const following = followUp.current
    wokeByName.current = false
    followUp.current = false

    // Woken by the offline spotter: the words must be spoken TO her — her name
    // as a greeting or followed by a request — the second check, which throws
    // out look-alikes and sentences about someone else ("Ira went to the market").
    if (woke && !addressed(text)) {
      stopListening()
      return
    }

    // A spoken answer to the oldest Approve card. Anything else is ignored
    // while one is waiting — it must be a clear yes or no.
    const waiting = store.getState().approvals[0]
    if (waiting) {
      const said = text.replace(LEADING_NAME, '').trim()
      if (SAID_YES.test(said)) answer(waiting.id, true)
      else if (SAID_NO.test(said)) answer(waiting.id, false)
      stopListening()
      return
    }

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question —
    // said twice too ("AYRA. AYRA.", the owner's hands-free test, 2026-10-11).
    if (BARE_NAME.test(text) || onlyName(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    // Woken mid-sentence ("okay so, AYRA, check the gold price"): the command
    // is what follows her name.
    const said = (woke ? afterWake(text) : text.replace(LEADING_NAME, '')).trim()
    // "That's all" after an answer: she goes back to waiting for her name.
    if (following && DISMISS.test(said)) {
      goDormant()
      return
    }
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  /** Speech has begun: wake a sleeping brain, and don't time out mid-sentence. */
  const onHearing = () => {
    warmBrain()
    if (store.getState().phase !== 'listening' || heard.current) return
    heard.current = true
    clearIdle()
    idleTimer.current = setTimeout(stopListening, LONGEST_TURN_MS)
  }

  /**
   * Hands-free: the offline spotter heard her name — from any app, her window
   * needn't be in front. She listens from just before the name, so "AYRA, open
   * Notepad" in one breath is one turn.
   */
  const onWakeWord = () => {
    const st = store.getState()
    if (st.hearing !== 'hands-free') return
    const phase = st.phase
    // Already listening — or speaking, when it may be her own voice saying her
    // name: then only Space or Esc interrupt her.
    if (phase === 'offline' || phase === 'boot' || phase === 'listening' || phase === 'waking' || phase === 'speaking') return
    st.setError(null)
    const busy = phase === 'thinking' || phase === 'tooling'
    if (busy && st.approvals.length) resumeTo.current = phase
    else if (busy) onSpeechStart()
    wokeByName.current = true
    sfx.play('wake')
    listen(AWAIT_SPEECH_MS, 'name')
  }

  /** Push-to-talk or hands-free (W, the tray, Ctrl+Alt+W). */
  const setHearing = async (want: Hearing, say = true) => {
    const v = voice.current
    if (!v) return
    const ok = await v.handsFree(want === 'hands-free')
    const st = store.getState()
    const mode: Hearing = want === 'hands-free' && ok ? 'hands-free' : 'push'
    if (want === 'hands-free' && !ok) {
      st.setError('Hands-free needs live hearing (an ElevenLabs key); push-to-talk stays on.')
    }
    st.setHearing(mode)
    reportHearing(mode)
    try {
      localStorage.setItem(HEARING_KEY, mode)
    } catch {
      /* not remembered this time */
    }
    if (!say || mode !== want) return
    // Never her name in these lines: the spotter would hear her say it.
    const line = createSpeaker()
    line.say(
      withHonorific(
        mode === 'hands-free'
          ? 'Hands-free. Just say my name when you need me.'
          : 'Push to talk. Press Space when you need me.',
      ),
    )
    void line.end()
  }

  /**
   * Normal or researcher mode (R). Only which agent answers the next question
   * changes — how she listens, the keys and the Approve rules stay as they are.
   */
  const setMode = (want: Mode, say = true) => {
    const st = store.getState()
    st.setMode(want)
    try {
      localStorage.setItem(MODE_KEY, want)
    } catch {
      /* not remembered this time */
    }
    // Before power-on the browser will not play a sound; the HUD shows it anyway.
    if (!say || st.phase === 'offline' || st.phase === 'boot') return
    // modeLine never says her name: the spotter would hear her say it.
    const line = createSpeaker()
    line.say(withHonorific(modeLine(want)))
    void line.end()
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[gnosis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchBlades((blade) => store.getState().pushBlade(blade))

    // Approve cards. Spoken as well as shown: the owner may be across the room.
    watchApprovals((event) => {
      const st = store.getState()
      if (event.type === 'approve') {
        st.addApproval(event.approval)
        const ask = createSpeaker()
        ask.say(withHonorific(`Quick check: this ${event.approval.reason}. Yes or no?`))
        void ask.end()
      } else if (event.type === 'approved') {
        st.removeApproval(event.id)
      } else if (event.type === 'halt') {
        st.clearApprovals()
        silence()
      }
    })

    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      // A restarted bridge has forgotten how she listens; the tray asks it.
      if (state !== 'lost') reportHearing(store.getState().hearing)
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warmBridge().catch((err: Error) => s.setError(err.message))

    // Long enough for the start-up sequence in Boot.tsx to land the wordmark.
    await new Promise((r) => setTimeout(r, BOOT_MS))
    await warming
    store.getState().setConnected(bridgeServers())
    store.getState().setVoice(currentVoiceName())

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()
    // Again, now that the engines are known: set before the probe, the label named
    // the browser's voice while every sentence was spoken by ElevenLabs.
    store.getState().setVoice(currentVoiceName())

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onHearing,
      onPartial,
      onUtterance,
      onError: onVoiceError,
      onWakeWord,
      onHandsFreeError: (message) => {
        store.getState().setError(message)
        void setHearing('push', false)
      },
    })

    store.getState().setPhase('dormant')
    // Her everyday lines ready to play at once — from the browser's cache when
    // an earlier visit kept them (tts.ts), in the background either way.
    void prefetchLines(COMMON_LINES)
    // How she listened last time, without announcing it.
    watchHearing((mode) => void setHearing(mode))
    watchTalk(() => press.current())
    // A reminder or a routine's answer (bridge/schedule.mjs): shown in the conversation, and said
    // aloud unless he is busy with something else, when it is only shown.
    watchNotice((text) => {
      const st = store.getState()
      st.pushTurn({ id: `notice-${Date.now()}`, role: 'assistant', text })
      if (st.phase !== 'dormant') return
      const line = createSpeaker()
      line.say(text)
      void line.end()
    })
    if (savedHearing() === 'hands-free') void setHearing('hands-free', false)
    else reportHearing('push')
  }

  // -- level pump + keys ----------------------------------------------------

  // The bubble on top of every app (AYRA.exe): her phase and one line, sent to
  // the bridge when they change — at most every 150 ms while words stream.
  useEffect(() => {
    let sent: Glance | null = null
    let timer = 0
    const report = () => {
      timer = 0
      const g = glance(store.getState(), wokeByName.current ? 'name' : 'press')
      if (sameGlance(sent, g)) return
      sent = g
      reportFace(g)
    }
    const unsubscribe = store.subscribe(() => {
      if (!timer) timer = window.setTimeout(report, GLANCE_MS)
    })
    // Again on reconnect, so a restarted bridge knows at once.
    const ping = window.setInterval(() => {
      sent = null
      report()
    }, 10_000)
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
      window.clearInterval(ping)
    }
    // `store` is the store's own hook — the same object for the life of the page.
  }, [store])

  useEffect(() => {
    let raf = 0
    // Researcher mode as it was left, without announcing it.
    setMode(savedMode(), false)

    /**
     * The voice level, for her mouth and the SIGNAL meter.
     *
     * Light on purpose (task 5.3): only while she listens or speaks, rounded to
     * steps the eye can tell apart, and written only when it changes — on
     * standby, or with the room quiet, this does no work at all. Animation
     * frames also stop by themselves while her window is hidden or minimised.
     */
    const pump = () => {
      raf = requestAnimationFrame(pump)
      const st = store.getState()
      let lvl = 0
      if (!still()) {
        // While speaking, follow AYRA's own output rather than the mic, so her
        // mouth follows her voice instead of reacting to room noise.
        if (st.phase === 'speaking' && speaker.current) lvl = speaker.current.level()
        else if (st.phase === 'listening' || st.phase === 'waking') lvl = inputLevel()
      }
      lvl = Math.round(lvl * 20) / 20
      if (lvl !== st.level) st.setLevel(lvl)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. ${withHonorific('At your service.')}`)
        void demo.end()
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say(withHonorific('Audio test. If you can hear this, speech output is working.'))
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[gnosis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // W: hands-free on or off — her name from anywhere, or Space each time.
      if (e.key === 'w' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void setHearing(store.getState().hearing === 'hands-free' ? 'push' : 'hands-free')
        return
      }

      // L holds her still: every animation paused, the level pump idle — for
      // when the laptop is busy. Remembered across reloads.
      if (e.key === 'l' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setStill(!still())
        return
      }

      // R: researcher mode on or off — every question then goes to the
      // researcher (sub-agents over Reddit, Quora, GitHub and the rest), or back
      // to her as she always is. Bare R only (Caps Lock or not): Ctrl+R is the
      // browser's reload.
      if (e.key.toLowerCase() === 'r' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        setMode(store.getState().mode === 'research' ? 'normal' : 'research')
        return
      }

      // Y / N answer the oldest Approve card; A is "yes, and always here".
      const waiting = store.getState().approvals[0]
      const key = e.key.toLowerCase()
      const always = key === 'a' && Boolean(waiting?.always)
      if (waiting && (key === 'y' || key === 'n' || always) && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        answer(waiting.id, key !== 'n', always)
        return
      }

      // Escape is the kill switch: it stands her down, declines everything
      // waiting for an Approve and stops every answer in flight.
      if (e.key === 'Escape') {
        e.preventDefault()
        halt()
        return
      }

      // Push-to-talk. Each press acts at once (no waiting to see if a second
      // one follows), and a second press within DOUBLE_TAP_MS stops everything —
      // whatever the first one began included.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      press.current()
    }

    press.current = () => {
      const phase = store.getState().phase
      const now = performance.now()
      const double = now - lastSpace.current < DOUBLE_TAP_MS
      lastSpace.current = double ? 0 : now
      if (double && phase !== 'offline' && phase !== 'boot') {
        halt()
        return
      }

      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (phase === 'listening' || phase === 'waking') {
        // Finished talking: send it now rather than waiting for quiet — which,
        // with a video playing nearby, might never come.
        voice.current?.send()
      } else {
        const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
        // "Send", pressed just after a pause had already sent it.
        if (busy && now - sentAt.current < SEND_GRACE_MS) return
        store.getState().setError(null)
        if (busy && store.getState().approvals.length) {
          // Opening the mic to answer the card: the turn waits on it, so it
          // carries on afterwards rather than being stopped.
          resumeTo.current = phase
        } else if (busy) {
          // Mid-answer: stop whatever she is doing and listen.
          onSpeechStart()
        }
        listen(AWAIT_SPEECH_MS)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      voice.current?.stop()
      speaker.current?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Avatar />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}

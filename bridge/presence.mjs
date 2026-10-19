/**
 * "I'm back" — AYRA tells the owner when she was away (PLAN.md 6.4).
 *
 * The laptop is her home for now (the owner's answer 2a): she is reachable
 * from the phone only while it is on and awake. When it was off, asleep or
 * restarting for a while, messages sent meanwhile are answered late — so once
 * she is back she says so, once, with how long she was gone.
 *
 * A heartbeat in data/state.json (`aliveAt`) marks the last minute she was
 * up. A gap found at start-up means she was off or restarting; a gap between
 * two ticks of a running bridge means the laptop slept.
 */

import { IDENTITY } from './identity.mjs'

/** How long away is worth a word. Shorter gaps — a restart, a quick nap — are not. */
export const AWAY_MS = 15 * 60_000
const TICK_MS = 60_000

/** "1 h 40 min" / "25 min". */
export function howLong(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

const clock = (t) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: IDENTITY.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(t))

/** The line the owner gets. */
export const backText = (since, now, why) =>
  `I'm back — I was ${why} for ${howLong(now - since)}, since ${clock(since)}. ` +
  'Anything you sent meanwhile gets answered now.'

/**
 * @param {{ store: { get: Function, set: Function }, notify: (text: string) => void,
 *           now?: () => number, every?: number, away?: number }} options
 * @returns {{ stop: () => void, tick: () => void }} tick is exposed for tests
 */
export function watchPresence({ store, notify, now = Date.now, every = TICK_MS, away = AWAY_MS }) {
  // The heartbeat must never take the bridge down: a write that fails this
  // minute is simply written next minute.
  const mark = (t) => {
    try {
      store.set('aliveAt', t)
    } catch (err) {
      console.warn(`[gnosis] presence: could not note the time (${err?.message ?? err})`)
    }
  }
  const start = now()
  let before = 0
  try {
    before = Number(store.get('aliveAt')) || 0
  } catch {
    /* unreadable: no note this time */
  }
  if (before && start - before > away) notify(backText(before, start, 'off or restarting'))
  mark(start)
  let last = start

  const tick = () => {
    const t = now()
    // Timers stop while the laptop sleeps: a long gap between ticks is a nap.
    if (t - last > away) notify(backText(last, t, 'asleep'))
    last = t
    mark(t)
  }
  const timer = setInterval(tick, every)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}

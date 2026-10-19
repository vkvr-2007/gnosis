/**
 * The owner's Approve — the one place an "ask" from the gate waits for a yes.
 *
 * AYRA runs everything on the laptop herself except the four things the owner
 * chose to be asked about (gate.mjs ASK). When one of those comes up, the call
 * stops here until the owner answers on whichever screen is nearest — the
 * HUD's card, a spoken "yes", or the Telegram buttons; the first answer wins and
 * the others are told. No answer in two minutes is a no: an action nobody
 * approved never runs. The kill switch (`halt`) says no to everything waiting.
 *
 * "Always allow here" (allowances.mjs): an ask that names its place — a website,
 * an app — and is of the one kind that can be allowed ahead (sending or posting)
 * offers a third answer, `always`, and next time goes ahead without asking.
 *
 * Events to subscribers (HUD sockets, Telegram):
 *   { type: 'approve', id, channel, tool, reason, detail, always, at }  — please answer;
 *        `always` is the third button's words ("Always on linkedin.com") or ''
 *   { type: 'approved', id, ok, by, always }                    — answered (or timed out)
 *   { type: 'halt', by }                                        — the kill switch
 *
 * The audit log gets who answered what and why it was asked, never the detail:
 * a command line can carry anything.
 */

/** How long an action waits for the owner before it is declined. */
export const APPROVAL_TIMEOUT_MS = 120_000

import { randomBytes } from 'node:crypto'
import { placeOf } from './allowances.mjs'

/**
 * @param {{ timeoutMs?: number, audit?: { log: (e: object) => void },
 *           allowances?: ReturnType<import('./allowances.mjs').createAllowances> }} [options]
 */
export function createApprovals({ timeoutMs = APPROVAL_TIMEOUT_MS, audit, allowances } = {}) {
  const waiting = new Map() // id -> { request, resolve, timer }
  const listeners = new Set()
  let seq = 0
  // Ids differ from one run to the next: a Telegram button left from before a
  // restart must find nothing, not answer whatever new request took its number.
  const run = randomBytes(3).toString('hex')

  const tell = (event) => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn(`[gnosis] approvals: a listener failed — ${err?.message ?? err}`)
      }
    }
  }

  const settle = (id, ok, by, always = false) => {
    const entry = waiting.get(id)
    if (!entry) return false
    waiting.delete(id)
    clearTimeout(entry.timer)
    const { request } = entry
    // Only a yes from the owner, and only where the ask offered it.
    const kept = ok && always && Boolean(request.always) && Boolean(allowances?.add(request))
    audit?.log({ type: 'approval', channel: request.channel, tool: request.tool, reason: request.reason, ok, by })
    if (kept) audit?.log({ type: 'allowance', kind: request.scope.kind, where: request.scope.where, by })
    console.log(`[gnosis] approval ${id}: ${ok ? 'yes' : 'no'}${kept ? `, and always ${placeOf(request.scope)}` : ''} (${by}) — ${request.reason}`)
    tell({ type: 'approved', id, ok, by, always: kept })
    entry.resolve(ok)
    return true
  }

  return {
    /**
     * Ask the owner. Resolves true only on an explicit yes — or at once when
     * the owner has already allowed this kind of thing here.
     * @param {{ channel: string, tool: string, reason: string, detail?: string,
     *           scope?: { kind: 'site'|'app', where: string } }} what
     *   scope — where the action happens, for "Always allow here"
     */
    ask({ channel, tool, reason, detail = '', scope = null }) {
      if (allowances?.allows({ reason, scope })) {
        audit?.log({ type: 'approval', channel, tool, reason, ok: true, by: 'allowance' })
        console.log(`[gnosis] allowed ahead ${placeOf(scope)} — ${reason}`)
        return Promise.resolve(true)
      }
      const id = `ap${++seq}-${run}`
      const always = allowances?.allowable({ reason, scope }) ? `Always ${placeOf(scope)}` : ''
      const request = {
        id, channel, tool, reason, detail: String(detail ?? '').slice(0, 400), always, scope, at: Date.now(),
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, false, 'timeout'), timeoutMs)
        timer.unref?.()
        waiting.set(id, { request, resolve, timer })
        tell({ type: 'approve', ...request })
      })
    },

    /**
     * The owner's answer. False if it was already answered or never asked.
     * `always`: the third button — yes, and from now on here.
     */
    answer(id, ok, by = 'owner', always = false) {
      return settle(id, ok === true, by, always === true)
    },

    /**
     * Say no to the asks that `which` picks out — a stopped background job's,
     * so a late Yes cannot make it act. Returns how many.
     */
    cancel(which, by = 'cancelled') {
      const ids = [...waiting.values()].filter((e) => which(e.request)).map((e) => e.request.id)
      for (const id of ids) settle(id, false, by)
      return ids.length
    },

    /** The kill switch: no to everything waiting. Returns how many were waiting. */
    halt(by = 'owner') {
      const ids = [...waiting.keys()]
      for (const id of ids) settle(id, false, `halt:${by}`)
      audit?.log({ type: 'halt', by, declined: ids.length })
      tell({ type: 'halt', by })
      return ids.length
    },

    /** What is waiting right now, oldest first — for a screen that just connected. */
    pending() {
      return [...waiting.values()].map((e) => e.request)
    },

    /** Hear every event; returns the way to stop hearing them. */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

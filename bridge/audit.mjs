/**
 * The audit log — what AYRA was asked, what it tried, what the gate allowed.
 *
 * One JSON object per line in data/logs/YYYY-MM-DD.jsonl (the owner's local
 * date), so a day's activity is one small file that any text editor opens and
 * any script can read. It exists for one question above all: "what did AYRA
 * do, and why was it allowed?" — which matters more every phase, as AYRA gets
 * hands.
 *
 * What is written: questions and answers (cut to a few hundred characters),
 * tool NAMES and the gate's verdicts, errors, session starts and ends. What is
 * never written: tool inputs (they can hold mail bodies or file contents),
 * environment values, tokens or keys. data/ is gitignored and stays here.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { localDate } from './context.mjs'
import { dataDir } from './paths.mjs'

export const LOG_DIR = dataDir('logs')

const MAX_TEXT = 500

/** Long text is cut, so one pasted essay can't swell the log. */
export const clip = (text) => {
  const s = String(text ?? '')
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s
}

/** An append-only log in `dir`. Tests point it at a temporary folder. */
export function createAudit(dir = LOG_DIR) {
  // Appends are chained so lines land in the order they happened, without
  // ever blocking the stream the voice is riding on.
  let chain = Promise.resolve()
  let ready = null

  return {
    log(event) {
      const now = new Date()
      const line = `${JSON.stringify({ ts: now.toISOString(), ...event })}\n`
      const file = join(dir, `${localDate(now)}.jsonl`)
      chain = chain
        .then(() => (ready ??= mkdir(dir, { recursive: true })))
        .then(() => appendFile(file, line))
        .catch((err) => console.warn(`[gnosis] audit log write failed: ${err.message}`))
      return chain
    },
    /** Resolves once every line logged so far is on disk. */
    flush: () => chain,
  }
}

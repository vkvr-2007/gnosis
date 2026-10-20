/**
 * Gnosis's long-term memory, ported from Gnosis v1 (gnosis/memory).
 *
 *   facts    — what the owner told him to remember: { subject, predicate, value, sensitive, pinned }.
 *              One value per subject and predicate: "remember my favourite colour is green" replaces
 *              an older colour. Saved only when asked ("remember…"); v1 also pulled facts out of every
 *              conversation by itself and saved junk (the time, the battery level, lines from attached
 *              files) that answers then repeated, so that stays off.
 *   episodes — the last few hundred exchanges, one line each, so "like last time" can be understood.
 *
 * Before each turn the facts and past exchanges that share words with the question are put in front
 * of the model (recallText). Past exchanges are marked as history and left out for an action request:
 * in v1 a model replayed an old answer ("the owner declined…", "Notepad is closed.") instead of acting.
 *
 * Sensitive facts (health, money, numbers, addresses, IDs) are only ever given to the on-device model;
 * secrets said with "private" live in privacy.mjs's private memory. Everything is in data/memory.json,
 * on the laptop (data/ is never committed).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from './sdk.mjs'
import { dataPath } from './paths.mjs'

export const MEMORY_FILE = dataPath('memory.json')
const MAX_EPISODES = 300

const STOP = new Set(('the a an and or of to in on at for with is are was were be been my me i you your it this that ' +
  'what whats who when where which how do does did can could would should please tell about remember gnosis hey ' +
  'have has had will just like').split(' '))
export const words = (s) => [...new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
  .map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 1 && !STOP.has(w)))]

/** "favourite_colour" / "favourite colour" → "favourite colour". */
const human = (p) => String(p).replace(/[_-]+/g, ' ').trim()

export function factText(f) {
  const who = f.subject === 'owner' ? 'The owner' : f.subject
  return `${who}: ${human(f.predicate)} = ${f.value}`
}

function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export function createMemory(file = MEMORY_FILE) {
  const load = () => {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      return { facts: Array.isArray(d.facts) ? d.facts : [], episodes: Array.isArray(d.episodes) ? d.episodes : [], next: d.next ?? 1 }
    } catch {
      return { facts: [], episodes: [], next: 1 }
    }
  }
  const save = (d) => {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 2))
    renameSync(`${file}.tmp`, file) // never a half-written memory
  }

  const score = (text, asked) => {
    const have = new Set(words(text))
    return asked.filter((w) => have.has(w)).length
  }

  return {
    /** Save a fact (or replace the one with the same subject and predicate). */
    remember({ subject = 'owner', predicate, value, sensitive = false }) {
      const d = load()
      const now = new Date().toISOString()
      const key = (f) => `${f.subject.toLowerCase()}|${human(f.predicate).toLowerCase()}`
      const fact = { subject: String(subject).trim() || 'owner', predicate: human(predicate), value: String(value).trim(),
                     sensitive: Boolean(sensitive) }
      const old = d.facts.find((f) => key(f) === key(fact))
      if (old) Object.assign(old, fact, { sensitive: old.sensitive || fact.sensitive, updated: now })
      else d.facts.push({ id: d.next++, ...fact, pinned: false, created: now, updated: now })
      save(d)
      return old ?? d.facts.at(-1)
    },
    forget(id) {
      const d = load()
      const before = d.facts.length
      d.facts = d.facts.filter((f) => f.id !== Number(id))
      if (d.facts.length === before) return false
      save(d)
      return true
    },
    facts: (includeSensitive = false) => load().facts.filter((f) => includeSensitive || !f.sensitive),
    /** Past exchanges, oldest first (the "Your data" screen). */
    episodes: () => load().episodes,
    /** Forgets one past exchange by when it happened, or all of them. */
    forgetEpisodes(at = null) {
      const d = load()
      const before = d.episodes.length
      d.episodes = at == null ? [] : d.episodes.filter((e) => e.at !== at)
      save(d)
      return before - d.episodes.length
    },
    /** One exchange, as a line of history. */
    addEpisode(request, answer) {
      const d = load()
      d.episodes.push({ request: String(request).slice(0, 300), answer: String(answer).slice(0, 300),
                        at: new Date().toISOString() })
      d.episodes = d.episodes.slice(-MAX_EPISODES)
      save(d)
    },
    /** Facts and past exchanges that share words with `query` (pinned facts always). */
    search(query, { includeSensitive = false, facts: maxFacts = 8, episodes: maxEpisodes = 3 } = {}) {
      const d = load()
      const asked = words(query)
      const facts = d.facts.filter((f) => includeSensitive || !f.sensitive)
        .map((f) => ({ f, s: (f.pinned ? 100 : 0) + score(`${f.subject} ${f.predicate} ${f.value}`, asked) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, maxFacts).map((x) => x.f)
      const episodes = d.episodes.map((e, i) => ({ e, s: score(`${e.request} ${e.answer}`, asked) + i / 1e4 }))
        .filter((x) => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, maxEpisodes).map((x) => x.e)
      return { facts, episodes }
    },
    /**
     * What to put in front of the model for this request, or ''. `actionRequest` leaves past exchanges
     * out (see the top of this file); `includeSensitive` is for the on-device model only.
     */
    recallText(request, { includeSensitive = false, actionRequest = false } = {}) {
      const { facts, episodes } = this.search(request, { includeSensitive })
      const lines = []
      if (facts.length) {
        lines.push('What you remember about the owner (the [#id] is for forget; never say it):')
        lines.push(...facts.map((f) => `- [#${f.id}] ${factText(f)}`))
      }
      if (episodes.length && !actionRequest) {
        lines.push('Related past exchanges, for context only. They are history: never repeat their answers or ' +
          'claim their actions now; use your tools for anything current:')
        lines.push(...episodes.map((e) => `- (${ago(e.at)}) "${e.request}" -> "${e.answer}"`))
      }
      return lines.join('\n').slice(0, 2500)
    },
  }
}

/** The memory tools: remember, search_memory, forget. */
export function memoryServer(memory = createMemory()) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  return createSdkMcpServer({
    name: 'gnosis_memory',
    tools: [
      tool('remember',
        'Save something the owner wants you to remember about them or the people and things in their life, ' +
          'e.g. their favourite food, a friend\'s birthday, the project they work on. Call it when they say ' +
          '"remember…" or ask you to keep something in mind.',
        {
          subject: z.string().describe('"owner" for the owner, otherwise the person or thing, e.g. "Asha"'),
          predicate: z.string().describe('What it is, in a few words, e.g. "favourite food", "birthday"'),
          value: z.string(),
          sensitive: z.boolean().optional().describe('Health, money, phone numbers, addresses, IDs'),
        },
        async (args) => {
          const f = memory.remember(args)
          return text(`Remembered [#${f.id}] ${factText(f)}.`)
        }),
      tool('search_memory',
        'Look up what you remember: facts the owner told you and past conversations. Empty query lists every fact.',
        { query: z.string().optional() },
        async ({ query = '' }) => {
          if (!query.trim()) {
            const all = memory.facts()
            return text(all.length ? all.map((f) => `[#${f.id}] ${factText(f)}`).join('\n') : 'Nothing remembered yet.')
          }
          const { facts, episodes } = memory.search(query)
          const lines = [...facts.map((f) => `[#${f.id}] ${factText(f)}`),
            ...episodes.map((e) => `(${ago(e.at)}) "${e.request}" -> "${e.answer}"`)]
          return text(lines.length ? lines.join('\n') : `Nothing remembered about "${query}".`)
        }),
      tool('forget', 'Forget one remembered fact, by its id from search_memory.',
        { id: z.number().int() },
        async ({ id }) => text(memory.forget(id) ? `Forgot fact #${id}.` : `There is no fact #${id}.`)),
    ],
  })
}

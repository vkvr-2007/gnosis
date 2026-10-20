/**
 * What stays on the laptop — the owner's rules (2026-10-18):
 *
 *   "For PII, sensitive information, contacts, passwords, emails etc use local; rest all use cloud.
 *    And if I have to add something sensitive I'll say a sentence with the keyword 'private' so it
 *    can store locally."
 *
 * Then, the same day, after the on-device model proved unable to do the work (asked to check email it
 * talked instead of opening Gmail, 105 s): option (b) — email and contacts run on the cloud like
 * everything else, and only secrets stay local: passwords, PINs, OTPs, card and bank numbers, IDs,
 * health, and "private" memories.
 *
 * So a turn thinks on the on-device model (sdk.mjs) when:
 *   - the request is about secrets (passwords, PINs, bank and card numbers, IDs, health…) or says
 *     "private" — SENSITIVE_WORDS;
 *   - the request itself carries a secret — a card, Aadhaar or PAN number, "password is …" — findPII;
 *   - a tool that reads the owner's own data (their files, windows, pages) brought one back.
 *
 * And a sentence with "private" in it that tells Gnosis something (not a question) is kept in the
 * private memory here — by code, not by any model, so it never leaves the laptop. Private memories are
 * only ever given to the on-device model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './paths.mjs'

export const SENSITIVE_WORDS = new RegExp(String.raw`\b(?:` + [
  'private(?:ly)?', 'secret', 'confidential', 'pii',
  // "PIN" only with a bank, card or "my": "pin this tab" is not a secret.
  'pass(?:word|words|code|phrase)', '(?:my|bank|atm|upi|card|debit|credit) pin', 'pin (?:code|number)', 'otp', 'cvv',
  'login', 'credentials?',
  // Not email, contacts or phone numbers: the owner chose (b), those run on the cloud.
  'bank (?:account|details|balance)', 'account numbers?', 'ifsc', 'upi(?: id| pin)?',
  'credit cards?', 'debit cards?', 'card numbers?', 'salary', 'income',
  'aadha?ar', 'pan(?: card| number)', 'passport', 'ssn', 'social security', 'driving licen[cs]e', 'voter id',
  'date of birth', 'dob',
  'medical', 'health', 'diagnos\\w*', 'prescriptions?', 'medicines?',
].join('|') + String.raw`)\b`, 'i')

// Secrets only: email addresses and phone numbers go to the cloud under option (b).
const PII = [
  ['a card number', /\b(?:\d{4}[\s-]?){3}\d{1,4}\b/],
  ['an Aadhaar number', /\b\d{4}\s\d{4}\s\d{4}\b/],
  ['a PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/],
  ['an IFSC code', /\b[A-Z]{4}0[A-Z0-9]{6}\b/],
  ['a password', /\bpass(?:word|code)\s*(?:is|:|=)\s*\S+/i],
]

/** The kinds of personal data in a text: [] when there are none. */
export function findPII(text) {
  const s = String(text ?? '')
  return PII.filter(([, re]) => re.test(s)).map(([kind]) => kind)
}

/** Why a request is private, or null. */
export function sensitiveRequest(request) {
  const word = SENSITIVE_WORDS.exec(request)?.[0]
  if (word) return `it mentions "${word}"`
  const pii = findPII(request)
  return pii.length ? `it contains ${pii.join(' and ')}` : null
}

const QUESTION = /^\W*(?:what|what's|whats|when|where|who|whom|whose|which|why|how|is|are|am|was|were|do|does|did|can|could|would|will|should|tell me|show me|give me|read|recall|find|search|look up|list)\b|\?\s*$/i
const PRIVATE_KEYWORD = /\bprivate(?:ly)?\b/i

/**
 * A sentence the owner wants kept privately — "Private: my wifi password is sunflower42", "my bank PIN
 * is 4321, keep it private" — rather than a question about something private. The text kept is the
 * sentence without the bits that only say "keep this private".
 */
export function privateStatement(request) {
  const text = String(request ?? '').trim()
  if (!PRIVATE_KEYWORD.test(text) || QUESTION.test(text)) return null
  const kept = text
    .replace(/^\W*(?:hey\s+)?g?nosis\W+/i, '')
    .replace(/\b(?:please\s+)?(?:remember|note|save|store|keep)\s+(?:this|that|it)?\s*(?:privately|private|in private)\b[:,]?/gi, '')
    .replace(/[,;]?\s*(?:and\s+)?(?:please\s+)?keep\s+(?:it|this|that)\s+private\b/gi, '')
    .replace(/^\W*(?:private(?:ly)?|in private)\s*[:,-]?\s*/i, '')
    .replace(/\s+(?:privately|in private)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
  return kept.length >= 3 ? kept : null
}

const STOP = new Set(['what', 'whats', 'what\'s', 'is', 'are', 'was', 'my', 'the', 'a', 'an', 'of', 'me', 'tell',
  'remind', 'please', 'gnosis', 'hey', 'do', 'you', 'know', 'remember', 'again', 'for', 'to', 'it', 'and', 'can',
  'say', 'give', 'show', 'private', 'privately', 'which', 'who', 'where', 'when', 'how', 'did', 'i', 'that', 'this'])
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).map((w) => w.replace(/'s$/, ''))

/** "my wifi password is x" → "your wifi password is x". */
export const toYou = (s) => String(s)
  .replace(/\bI am\b/g, 'you are').replace(/\bI'm\b/g, "you're").replace(/\bI\b/g, 'you')
  .replace(/\bmy\b/gi, (m) => (m[0] === 'M' ? 'Your' : 'your')).replace(/\bmine\b/gi, 'yours').replace(/\bme\b/gi, 'you')

/**
 * A question answered straight from the private memory, by code. The on-device model can't be trusted
 * with it: asked for a password the owner had saved, it refused and lectured about security after 79 s
 * (2026-10-18). A memory answers only when it holds every telling word of the question.
 */
export function privateAnswer(request, memories) {
  const asked = [...new Set(words(request).filter((w) => !STOP.has(w)))]
  if (!asked.length) return null
  const hits = memories.filter((m) => {
    const have = new Set(words(m.text))
    return asked.every((w) => have.has(w))
  })
  if (!hits.length) return null
  const said = hits.slice(-2).map((m) => toYou(m.text).replace(/[.!]+$/, ''))
  return `You told me privately: ${said.join('; and ')}.`
}

export const MEMORY_FILE = dataPath('private-memory.json')

/** The private memory: what the owner told Gnosis to keep privately. On the laptop only (data/ is never committed). */
export function createPrivateMemory(file = MEMORY_FILE) {
  const load = () => {
    try {
      const items = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }
  return {
    add(text) {
      const items = load()
      const item = { id: (items.at(-1)?.id ?? 0) + 1, text, saved: new Date().toISOString() }
      items.push(item)
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(items, null, 2))
      return item
    },
    all: load,
    /** Deletes one private note (the "Your data" screen). */
    remove(id) {
      const items = load()
      const kept = items.filter((m) => m.id !== id)
      if (kept.length === items.length) return false
      writeFileSync(file, JSON.stringify(kept, null, 2))
      return true
    },
    /** The memories that share words with the request first, then the newest; at most `limit`. */
    relevant(request, limit = 20) {
      const words = new Set(String(request).toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
      const score = (m) => (m.text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => words.has(w)).length
      return load().map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s || b.m.id - a.m.id)
        .slice(0, limit).map(({ m }) => m)
    },
  }
}

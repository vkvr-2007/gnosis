// Unit tests for config/identity.json and what is built from it. `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDENTITY, withHonorific } from '../src/identity.ts'
import { SYSTEM_PROMPT } from '../bridge/persona.mjs'

const raw = JSON.parse(readFileSync(new URL('../config/identity.json', import.meta.url), 'utf8'))

test('identity.json has every field, with sane values', () => {
  for (const key of ['name', 'wordmark', 'tagline', 'language', 'timezone']) {
    assert.equal(typeof raw[key], 'string', key)
    assert.ok(raw[key].trim(), `${key} is empty`)
  }
  assert.equal(typeof raw.honorific, 'string')
  assert.ok(['female', 'male'].includes(raw.voice.gender))
  assert.ok(Array.isArray(raw.voice.prefer))
  assert.match(raw.language, /^[a-z]{2}(-[A-Z]{2})?$/)
  // An unknown time zone throws here, long before it could break a stamp.
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: raw.timezone }))
})

test('wake words are lowercase, unique, and never in both lists', () => {
  const { names, prefixedOnly } = raw.wake
  assert.ok(names.length > 0)
  for (const w of [...names, ...prefixedOnly]) assert.equal(w, w.toLowerCase(), w)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(names.filter((w) => prefixedOnly.includes(w)), [])
})

test('the honorific is attached only when one is configured', () => {
  const saved = IDENTITY.honorific
  try {
    IDENTITY.honorific = ''
    assert.equal(withHonorific('Working on it.'), 'Working on it.')
    IDENTITY.honorific = 'sir'
    assert.equal(withHonorific('Working on it.'), 'Working on it, sir.')
    assert.equal(withHonorific('Yes?'), 'Yes, sir?')
  } finally {
    IDENTITY.honorific = saved
  }
})

test('the persona is built from identity', () => {
  assert.ok(SYSTEM_PROMPT.startsWith(`You are ${raw.name},`))
  assert.ok(SYSTEM_PROMPT.includes(raw.timezone))
  assert.ok(SYSTEM_PROMPT.includes('[Now: …]'))
  assert.ok(!SYSTEM_PROMPT.includes('JARVIS'))
  if (!raw.honorific) assert.ok(!/\bsir\b/i.test(SYSTEM_PROMPT))
})

test("the persona's roasting and banter keep their guardrails, and Gnosis never flirts", () => {
  assert.ok(SYSTEM_PROMPT.includes('ROASTING AND BANTER'))
  assert.ok(SYSTEM_PROMPT.includes('Never flirting'))
  assert.ok(!/Flirt a little/.test(SYSTEM_PROMPT))
  assert.ok(SYSTEM_PROMPT.includes('Always kind and PG'))
  assert.ok(SYSTEM_PROMPT.includes('Never when the moment is serious'))
  assert.ok(SYSTEM_PROMPT.includes('be serious'))
})

test('the voice persona: the ranker decides research, a web answer is said first, its card a <data> tag after', () => {
  // The depth line the brain puts in front of a complex question (triage.mjs depthHint).
  assert.ok(SYSTEM_PROMPT.includes('[Depth'))
  assert.ok(SYSTEM_PROMPT.includes('use the research tool]'))
  assert.ok(SYSTEM_PROMPT.includes('Without that line, never use research'))
  assert.ok(SYSTEM_PROMPT.includes('for clearly complex questions'))
  // Speak first, then the card as a <data> tag at the end (datatag.mjs), only for a
  // figure, name, date, score or yes/no — never the slow show_data turn.
  assert.ok(SYSTEM_PROMPT.includes('SAY the answer first'))
  assert.ok(SYSTEM_PROMPT.includes('end that same message with its data card'))
  assert.ok(SYSTEM_PROMPT.includes('<data>{"title"'))
  assert.ok(SYSTEM_PROMPT.includes('never call\n  `show_data`'))
  assert.ok(SYSTEM_PROMPT.includes('a figure, a name, a date, a score\n  or a yes/no'))
  assert.ok(SYSTEM_PROMPT.includes('Skip it for news, how-to and explanations'))
  assert.ok(SYSTEM_PROMPT.includes('never `display` it as well'))
  // Research's own cards, and none of the old depth settings or the full-screen board.
  assert.ok(SYSTEM_PROMPT.includes('small progress card'))
  assert.ok(!/\bquick \(|\bstandard\b|\bdeep\b|\bboard\b/i.test(SYSTEM_PROMPT))
})

test('the voice persona: a task in a line, a question answered, details in <more> (the owner, 2026-10-13)', () => {
  assert.ok(SYSTEM_PROMPT.includes('only the minimum — status, progress and anything'))
  assert.ok(SYSTEM_PROMPT.includes('A task — open, play, send, write, fix, move, set up, find and do: one short sentence.'))
  assert.ok(SYSTEM_PROMPT.includes('Go into\n  depth only when they ask you to explain'))
  assert.ok(SYSTEM_PROMPT.includes('inside <more>…</more>'))
  assert.ok(!SYSTEM_PROMPT.includes('Length is licensed only when reading out data'))
})

test('the premium voice is the one the owner chose', () => {
  assert.equal(raw.voice.elevenLabsId, 'uPAdReDjrJ1KtAcuguzK') // the owner's pick, 2026-10-19
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REST_ON_SCREEN, createSpokenFilter, isQuestion, unwrapMore } from '../bridge/spoken.mjs'

const run = (deltas, question = false) => {
  const f = createSpokenFilter({ question })
  const parts = [...deltas.flatMap((d) => f.push(d)), ...f.end()]
  return {
    spoken: parts.filter((p) => !p.quiet).map((p) => p.text).join(''),
    shown: parts.map((p) => p.text).join(''),
  }
}

test('a task: two sentences spoken, the rest on screen, said once', () => {
  const r = run(['Done, Notepad is open. ', 'I also tidied your desktop. ', 'Moved 4 files to Documents, ', 'renamed 2, and emptied nothing. Anything else?'])
  assert.equal(r.spoken, `Done, Notepad is open. I also tidied your desktop. ${REST_ON_SCREEN.trim()}`)
  assert.match(r.shown, /Moved 4 files to Documents, renamed 2/)
})

test('a sentence end split across deltas is seen, and not counted twice', () => {
  const r = run(['One.', ' Two.', ' Three. Four.'])
  assert.equal(r.spoken.startsWith('One. Two. '), true)
  assert.ok(!r.spoken.includes('Three'))
})

test('one runaway sentence is cut near TASK_CHARS', () => {
  const long = `${'word '.repeat(120)}end`
  const r = run([long])
  assert.ok(r.spoken.length < 400, String(r.spoken.length))
  assert.ok(r.spoken.endsWith(REST_ON_SCREEN.trim()))
  assert.ok(r.shown.endsWith('end'))
})

test('<more> is shown, never spoken — in any split', () => {
  const full = 'Opened it. <more>Steps: 1. open 2. click 3. done.</more> Want anything else?'
  for (let size = 1; size <= 7; size++) {
    const parts = []
    for (let i = 0; i < full.length; i += size) parts.push(full.slice(i, i + size))
    const r = run(parts, true)
    assert.equal(r.spoken, 'Opened it.  Want anything else?', `size ${size}`)
    assert.ok(r.shown.includes('Steps: 1. open'), `size ${size}`)
    assert.ok(!r.shown.includes('<more>') && !r.shown.includes('</more>'), `size ${size}`)
  }
})

test('a question is answered in full', () => {
  const r = run(['It works like this. First the planner reads it. Then the agents search. Then a reviewer ranks.'], true)
  assert.ok(r.spoken.includes('Then a reviewer ranks.'))
  assert.ok(!r.spoken.includes(REST_ON_SCREEN.trim()))
})

test('a short task answer is untouched', () => {
  assert.equal(run(['Done — Spotify is open.']).spoken, 'Done — Spotify is open.')
})

test('isQuestion: questions and requests to explain; everything else is a task', () => {
  for (const q of ['What is the gold price?', 'Hey Gnosis, why is the sky blue', 'how does researcher mode work', 'explain the bubble', 'Tell me about Node 24', 'can you open notepad?', 'is it raining']) {
    assert.equal(isQuestion(q), true, q)
  }
  for (const t of ['open spotify', 'Hey Gnosis, clean up my downloads folder', 'send the report to my drive', 'play some music', 'research the best laptops']) {
    assert.equal(isQuestion(t), false, t)
  }
})

test('unwrapMore keeps the words, drops the tags', () => {
  assert.equal(unwrapMore('Done. <more>Details.</more>'), 'Done. Details.')
})

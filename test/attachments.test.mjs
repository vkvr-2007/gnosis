/** Files and pictures given to Gnosis (bridge/attachments.mjs). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentNote, attachmentServer, createAttachments, kindOf, TEXT_LIMIT } from '../bridge/attachments.mjs'
import { createGate } from '../bridge/gate.mjs'
import { askFrame } from '../src/store.ts'

const fresh = () => createAttachments(mkdtempSync(join(tmpdir(), 'gnosis-attach-')))

test('kinds: text files, pictures, and everything else', () => {
  assert.equal(kindOf('notes.md'), 'text')
  assert.equal(kindOf('data.CSV'), 'text')
  assert.equal(kindOf('app.tsx'), 'text')
  assert.equal(kindOf('photo.JPG'), 'image')
  assert.equal(kindOf('pasted', 'image/png'), 'image')
  assert.equal(kindOf('report.pdf'), 'other')
  assert.equal(kindOf('letter.docx'), 'other')
})

test('saved with a safe name, found by id, refused when empty or too big; a week old and they go', () => {
  const store = fresh()
  const a = store.save({ name: '../../evil:name?.txt', bytes: Buffer.from('hello') })
  assert.match(a.id, /^[0-9a-f]{12}$/)
  assert.equal(a.kind, 'text')
  assert.ok(!a.name.includes('/') && !a.name.includes(':'))
  assert.equal(store.get(a.id).size, 5)
  assert.equal(store.get('../etc'), null)
  assert.throws(() => store.save({ name: 'x.txt', bytes: Buffer.alloc(0) }), /empty/)
  assert.throws(() => store.save({ name: 'x.bin', bytes: { length: 21 * 1024 * 1024 } }), /over 20 MB/)
  const old = (Date.now() - 8 * 86_400_000) / 1000
  for (const f of readdirSync(store.dir)) utimesSync(join(store.dir, f), old, old)
  assert.equal(store.cleanUp(), 1)
  assert.equal(store.get(a.id), null)
})

test('the note before the question: a text file in full, a picture described with the question, a PDF named honestly', async () => {
  const store = fresh()
  const txt = store.save({ name: 'todo.txt', bytes: Buffer.from('buy milk\ncall Asha') })
  const big = store.save({ name: 'big.log', bytes: Buffer.from('x'.repeat(TEXT_LIMIT + 50)) })
  const img = store.save({ name: 'bill.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
  const pdf = store.save({ name: 'report.pdf', bytes: Buffer.from('%PDF-1.7') })
  const asked = []
  const ask = async ({ images, question }) => (asked.push([images[0].mimeType, question]), 'A phone bill for Rs 499, due 25 October.')
  const note = await attachmentNote([txt.id, big.id, img.id, pdf.id, 'ffffffffffff'], 'when is it due?', { store, ask })
  assert.match(note, /attached the file "todo\.txt":\n<<<\nbuy milk\ncall Asha\n>>>/)
  assert.match(note, /"big\.log" \(only the first 20,000 characters are here\)/)
  assert.match(note, /picture "bill\.png"\. What it shows: A phone bill for Rs 499, due 25 October\. \(For another look, look_at_attachment with id "[0-9a-f]{12}"\.\)/)
  assert.match(note, /"report\.pdf", a kind of file Gnosis can't read yet/)
  assert.deepEqual(asked.map((a) => a[0]), ['image/png'])
  assert.match(asked[0][1], /asks: "when is it due\?"/)
  assert.equal(await attachmentNote([], 'x', { store, ask }), '')
  const down = await attachmentNote([img.id], 'x', { store, ask: async () => { throw new Error('offline') } })
  assert.match(down, /couldn't be reached to look at it/)
})

test('look_at_attachment looks again at a picture; not at text, not at what is gone', async () => {
  const store = fresh()
  const img = store.save({ name: 'cat.jpg', bytes: Buffer.from([1, 2, 3]) })
  const txt = store.save({ name: 'a.txt', bytes: Buffer.from('a') })
  const [t] = attachmentServer({ store, ask: async ({ question }) => `Seen: ${question.slice(0, 20)}` }).tools
  assert.match((await t.handler({ id: img.id, question: 'What colour is it?' })).content[0].text, /^Seen: What colour is it\?/)
  assert.equal((await t.handler({ id: txt.id, question: 'x' })).isError, true)
  assert.match((await t.handler({ id: 'aaaaaaaaaaaa', question: 'x' })).content[0].text, /no longer here/)
  assert.equal(createGate({ allowWrites: false }).decide('mcp__ayra_attachments__look_at_attachment'), true)
})

test('a question carries the attachments waiting for it, and only then', () => {
  assert.deepEqual(askFrame('what is this?', 'q1', 'normal', ['abc']), { type: 'ask', text: 'what is this?', id: 'q1', attachments: ['abc'] })
  assert.deepEqual(askFrame('hi', 'q2'), { type: 'ask', text: 'hi', id: 'q2' })
})

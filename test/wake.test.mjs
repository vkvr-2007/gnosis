// Unit tests for src/lib/wake.ts — the "Hey Gnosis" phrase. `npm test`
// (TypeScript is loaded through tsx; see the test script in package.json.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAKE, BARE_NAME, LEADING_NAME, afterWake } from '../src/lib/wake.ts'

test('the name and its common mishearings wake Gnosis', () => {
  for (const [said, rest] of [
    ['hey gnosis', ''],
    ['Hey, Gnosis.', ''],
    ['Gnosis what is the weather', 'what is the weather'],
    ['hey nosis, open my mail', 'open my mail'],
    ['ok noses set a reminder', 'set a reminder'],
    ['hey noesis play music', 'play music'],
  ]) {
    assert.equal(WAKE.test(said), true, said)
    assert.equal(afterWake(said), rest, said)
  }
})

test('ordinary words only count after a greeting', () => {
  assert.equal(WAKE.test('hey genesis what time is it'), true)
  assert.equal(WAKE.test('hey gnostic'), true)
  for (const said of [
    'the book of genesis is long',
    'Genesis said hello to me',
    'gnostic texts are old',
    'neurosis is common',
  ]) {
    assert.equal(WAKE.test(said), false, said)
  }
})

test("possessives don't wake it", () => {
  assert.equal(WAKE.test("gnosis's settings are fine"), false)
})

test('a bare name is not a question; a leading name is stripped', () => {
  assert.equal(BARE_NAME.test('hey gnosis'), true)
  assert.equal(BARE_NAME.test('Gnosis.'), true)
  assert.equal(BARE_NAME.test('gnosis what time'), false)
  assert.equal('Gnosis, what time is it'.replace(LEADING_NAME, ''), 'what time is it')
})

test('hands-free: spoken TO her counts, a sentence ABOUT someone with her name does not', async () => {
  const { addressed } = await import('../src/lib/wake.ts')
  for (const said of [
    'Gnosis.',
    'Hey Gnosis, what time is it?',
    'Gnosis, open Notepad for me.',
    'Gnosis open notepad',
    'Gnosis what is the weather',
    'Gnosis is it going to rain today',
    'okay so, Gnosis, check the gold price',
    'hey nosis went to the market?',
  ]) {
    assert.equal(addressed(said), true, said)
  }
  for (const said of [
    'Gnosis went to the market yesterday.',
    'Gnosis said he would call back',
    'nosis was at the party',
    'the weather is nice',
  ]) {
    assert.equal(addressed(said), false, said)
  }
})

test('her name alone, however often, is not a question', async () => {
  const { onlyName } = await import('../src/lib/wake.ts')
  for (const said of ['Gnosis. Gnosis.', 'Hey, Nosis. Nosis.', 'gnosis']) assert.equal(onlyName(said), true, said)
  for (const said of ['Gnosis, what time is it', 'hello', '']) assert.equal(onlyName(said), false, said)
})

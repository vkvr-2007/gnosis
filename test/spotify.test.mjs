/** Spotify by name (bridge/spotify.mjs), ported from Gnosis v1, which only opened Spotify's search. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { musicServer, pickResult, wordsOf } from '../bridge/spotify.mjs'
import { createGate } from '../bridge/gate.mjs'

// What Spotify offered for these searches on the owner's laptop, 2026-10-18 (first few, in order).
const BLINDING = ['Blinding Lights', 'Blinding Lights - Live', 'Blinding Lights', 'The Weeknd India Hits - 2026 Tour',
  'Blinding Lights - Instrumental', 'Blinding Lights  The Weeknd', 'Blinding Lights - Major Lazer Remix']
const SHAPE = ['Shape of You - Stormzy Remix', 'Shape of You - Ed Sheeran | analysis', 'Shape of You - Ed Sheeran (Marimba Ringtone)',
  'Sapphire', 'Shape of You', 'Shape of You - Live', 'Shape Of You - Ed Sheeran', 'Shape of You - Acoustic']
const results = (titles) => titles.map((title) => ({ title, index: 0 }))

test('words: lower case, accents gone, filler dropped', () => {
  assert.deepEqual(wordsOf('Play the song Señorita by Shawn Mendes on Spotify'), ['senorita', 'shawn', 'mendes'])
})

test('the plain track wins over live, remix, instrumental, ringtone and analysis versions', () => {
  assert.equal(pickResult(results(BLINDING), 'Blinding Lights The Weeknd').title, 'Blinding Lights')
  assert.equal(pickResult(results(SHAPE), 'Shape of You by Ed Sheeran').title, 'Shape of You')
  assert.equal(pickResult(results(SHAPE), 'shape of you').title, 'Shape of You')
})

test('a version the owner asked for is chosen', () => {
  assert.equal(pickResult(results(BLINDING), 'Blinding Lights live').title, 'Blinding Lights - Live')
  assert.equal(pickResult(results(SHAPE), 'shape of you acoustic').title, 'Shape of You - Acoustic')
})

test('nothing matching is null', () => {
  assert.equal(pickResult(results(['Sapphire', 'Starboy']), 'Blinding Lights'), null)
  assert.equal(pickResult([], 'x'), null)
})

test('spotify_play: search, play the chosen result, and report what the window shows', async () => {
  const calls = []
  const run = async (a) => {
    calls.push(a)
    return a.op === 'search' ? { results: [{ title: 'Blinding Lights - Live', index: 0 }, { title: 'Blinding Lights', index: 0 }] }
      : { title: 'The Weeknd - Blinding Lights' }
  }
  const [t] = musicServer({ log: () => {}, run }).tools
  const r = await t.handler({ query: 'Blinding Lights' })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /^Spotify is playing: The Weeknd - Blinding Lights\./)
  assert.deepEqual(calls[1], { op: 'play', name: 'Blinding Lights', index: 0 })
})

test("spotify_play never claims what Spotify doesn't show", async () => {
  const [idle] = musicServer({ log: () => {}, run: async (a) => (a.op === 'search' ? { results: [{ title: 'Starboy', index: 0 }] } : { title: 'Spotify Free' }) }).tools
  const r = await idle.handler({ query: 'Starboy' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /doesn't show it playing/)
  // The song that was already on, still in the window's title: not this one playing.
  const [stale] = musicServer({ log: () => {}, run: async (a) => (a.op === 'search' ? { results: [{ title: 'Starboy', index: 0 }] }
    : { title: 'Ed Sheeran - Shape of You', before: 'Ed Sheeran - Shape of You' }) }).tools
  assert.equal((await stale.handler({ query: 'Starboy' })).isError, true)
  // Pressing play on the song already playing: still that song, which is right.
  const [same] = musicServer({ log: () => {}, run: async (a) => (a.op === 'search' ? { results: [{ title: 'Shape of You', index: 0 }] }
    : { title: 'Ed Sheeran - Shape of You', before: 'Ed Sheeran - Shape of You' }) }).tools
  assert.equal((await same.handler({ query: 'Shape of You' })).isError, undefined)
  const [none] = musicServer({ log: () => {}, run: async () => ({ results: [] }) }).tools
  assert.match((await none.handler({ query: 'zzz' })).content[0].text, /no results/)
  const [off] = musicServer({ log: () => {}, run: async () => ({ results: [{ title: 'Sapphire', index: 0 }] }) }).tools
  assert.match((await off.handler({ query: 'Blinding Lights' })).content[0].text, /Nothing on Spotify matched.*Sapphire/)
})

test("the gate lets spotify_play run", () => {
  assert.equal(createGate({ allowWrites: false }).decide('mcp__ayra_music__spotify_play'), true)
})

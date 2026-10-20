/** Voice ID (bridge/voiceid.mjs) and the listening relay handing it each segment (bridge/listen.mjs). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceId, GUEST_TOOLS, PASSAGE, toSamples, voiceIdServer } from '../bridge/voiceid.mjs'
import { relayListening } from '../bridge/listen.mjs'
import { createGate } from '../bridge/gate.mjs'

/** Speech from "voice" v (a number), `seconds` long: a steady tone whose level stands for the voice. */
const speech = (v, seconds) => {
  const n = Math.round(seconds * 16000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 7) * 3000 * v), i * 2)
  return b
}
/** A fake model: the voice's level picks the direction of its embedding. */
const embedder = async () => (samples) => {
  const level = Math.max(...samples.slice(0, 200).map(Math.abs))
  return level > 0.15 ? [1, 0.1, 0] : [0.1, 1, 0]
}
const fresh = (clock = { t: 1_000_000 }) => ({
  clock,
  voice: createVoiceId({ file: join(mkdtempSync(join(tmpdir(), 'gnosis-voice-')), 'voiceprint.json'), embedder, now: () => clock.t, log: () => {} }),
})

test('PCM to samples: length, level and seconds', () => {
  const s = toSamples(speech(1, 0.5))
  assert.equal(s.seconds, 0.5)
  assert.ok(s.rms > 0.05)
  assert.equal(toSamples(Buffer.alloc(3200)).rms, 0)
})

test('learning: speech over the next minute and a half becomes the print, once there are 12 seconds of it', async () => {
  const { voice } = fresh()
  assert.equal(voice.enrolled(), false)
  await voice.startEnrolment()
  assert.equal(voice.enrolling(), true)
  assert.deepEqual(await voice.hear(Buffer.alloc(32000)), { enrol: 'skipped' }) // silence
  assert.deepEqual(await voice.hear(speech(2, 5)), { enrol: 'more', seconds: 5 })
  assert.deepEqual(await voice.hear(speech(2, 5)), { enrol: 'more', seconds: 10 })
  assert.deepEqual(await voice.hear(speech(2, 4)), { enrol: 'done', seconds: 14 })
  assert.equal(voice.enrolled(), true)
  assert.equal(voice.enrolling(), false)
  assert.equal(voice.status().seconds, 14)
})

test('judging: the owner passes, another voice does not, a short word is not judged; the verdict is for the same words, briefly', async () => {
  const { voice, clock } = fresh()
  await voice.startEnrolment()
  await voice.hear(speech(2, 13))
  const mine = await voice.hear(speech(2, 2), 'Open YouTube.')
  assert.deepEqual([mine.judged, mine.owner, Math.round(mine.score * 1000) / 1000], [true, true, 1])
  assert.equal(voice.verdictFor('open youtube').owner, true)
  const other = await voice.hear(speech(0.5, 2), 'Send a message to Asha.')
  assert.equal(other.owner, false)
  assert.ok(other.score < 0.45)
  assert.equal(voice.verdictFor('send a message to asha').owner, false)
  assert.equal(voice.verdictFor('something else entirely'), null, 'other words: not this verdict')
  clock.t += 21_000
  assert.equal(voice.verdictFor('send a message to asha'), null, 'too old')
  assert.deepEqual(await voice.hear(speech(0.5, 0.6), 'Stop.'), { judged: false })
})

test('before learning, nobody is judged; forgetting removes the print', async () => {
  const { voice } = fresh()
  assert.deepEqual(await voice.hear(speech(0.5, 2), 'hi'), { judged: false })
  await voice.startEnrolment()
  await voice.hear(speech(2, 13))
  voice.forget()
  assert.equal(voice.enrolled(), false)
})

test('the minute and a half runs out: what was heard is not half a print', async () => {
  const { voice, clock } = fresh()
  await voice.startEnrolment()
  await voice.hear(speech(2, 5))
  clock.t += 91_000
  assert.equal(voice.enrolling(), false)
  assert.deepEqual(await voice.hear(speech(2, 5), 'hello'), { judged: false })
  assert.equal(voice.enrolled(), false)
})

test('the tools: learn shows the passage; status says what is known', async () => {
  const { voice } = fresh()
  const shown = []
  const tools = Object.fromEntries(voiceIdServer(voice, { showText: (t, w) => shown.push([t, w]) }).tools.map((t) => [t.name, t.handler]))
  assert.match((await tools.voice_id_status({})).content[0].text, /don't know the owner's voice yet/)
  assert.match((await tools.learn_my_voice({})).content[0].text, /Listening for the next 90 seconds/)
  assert.deepEqual(shown, [['READ THIS ALOUD', PASSAGE]])
  assert.match((await tools.voice_id_status({})).content[0].text, /Learning the owner's voice right now/)
  const gate = createGate({ allowWrites: false })
  assert.equal(gate.review('mcp__ayra_voice__forget_my_voice', {}).verdict, 'ask')
  assert.equal(gate.review('mcp__ayra_voice__learn_my_voice', {}).verdict, 'allow')
  assert.ok(GUEST_TOOLS.has('WebSearch') && !GUEST_TOOLS.has('PowerShell') && !GUEST_TOOLS.has('mcp__ayra_apps__apps_open'))
})

test('the listening relay hands voice ID each finished segment with its words', async () => {
  const client = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)) } })
  const upstream = Object.assign(new EventEmitter(), { sent: [], send(d) { this.sent.push(d) }, close() {} })
  const segments = []
  relayListening(client, { key: 'k', connect: () => upstream, onSegment: (pcm, text) => segments.push([pcm.length, text]) })
  client.emit('message', Buffer.alloc(3200), true)
  client.emit('message', Buffer.alloc(1600), true)
  upstream.emit('message', JSON.stringify({ message_type: 'session_started' }))
  upstream.emit('message', JSON.stringify({ message_type: 'committed_transcript', text: 'Open YouTube.' }))
  client.emit('message', Buffer.alloc(800), true)
  upstream.emit('message', JSON.stringify({ message_type: 'committed_transcript', text: 'Thanks.' }))
  assert.deepEqual(segments, [[4800, 'Open YouTube.'], [800, 'Thanks.']])
  assert.deepEqual(client.sent.filter((m) => m.type === 'final').map((m) => m.text), ['Open YouTube.', 'Thanks.'])
})

/** Settings and keys (bridge/settings.mjs, bridge/secrets.mjs): never a real key, never the owner's files. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanSettings, readSettings, withSettings, writeSettings } from '../bridge/settings.mjs'
import { keyStatus, loadSecrets, saveSecret, testKey } from '../bridge/secrets.mjs'

test('settings are checked: a name, a voice ID, quiet hours and the briefing time', () => {
  assert.deepEqual(cleanSettings({ honorific: '  Vaarsh  ', voiceId: 'uPAdReDjrJ1KtAcuguzK', quietHours: '22:30-06:00', briefing: '07:45' }),
    { honorific: 'Vaarsh', voiceId: 'uPAdReDjrJ1KtAcuguzK', quietHours: '22:30-06:00', briefing: '07:45' })
  assert.deepEqual(cleanSettings({ quietHours: 'off', briefing: 'off', voiceId: '' }), { quietHours: 'off', briefing: 'off', voiceId: '' })
  assert.throws(() => cleanSettings({ voiceId: 'not a voice!' }), /letters and digits/)
  assert.throws(() => cleanSettings({ quietHours: '11pm-7am' }), /two times/)
  assert.throws(() => cleanSettings({ briefing: '25:00' }), /like 08:00/)
  assert.throws(() => cleanSettings({ honorific: 'x'.repeat(41) }), /at most 40/)
  assert.deepEqual(cleanSettings({ unknown: 1 }), {})
})

test('settings are kept in the data folder and laid over config/identity.json', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gnosis-settings-')), 'settings.json')
  assert.deepEqual(readSettings(file), {})
  writeSettings({ honorific: 'Vaarsh' }, file)
  assert.deepEqual(writeSettings({ voiceId: 'abcdefghij12' }, file), { honorific: 'Vaarsh', voiceId: 'abcdefghij12' })
  const identity = { name: 'Gnosis', honorific: 'boss', voice: { gender: 'male', elevenLabsId: 'old' } }
  assert.deepEqual(withSettings(identity, readSettings(file)),
    { name: 'Gnosis', honorific: 'Vaarsh', voice: { gender: 'male', elevenLabsId: 'abcdefghij12' } })
  assert.equal(identity.honorific, 'boss', 'the defaults are not changed')
})

test('saved keys fill in only what the environment lacks, and the window only learns set or not', () => {
  const before = { ...process.env }
  try {
    process.env.NVIDIA_API_KEY = 'env-key-123456789'
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.TAVILY_API_KEY
    const asked = []
    loadSecrets({ platform: 'win32', run: (args) => (asked.push(args), { NVIDIA_API_KEY: 'saved-nv', ELEVENLABS_API_KEY: 'saved-el-123456' }) })
    assert.deepEqual(asked, [['-Op', 'read', '-Names', 'ELEVENLABS_API_KEY,TAVILY_API_KEY']])
    assert.equal(process.env.NVIDIA_API_KEY, 'env-key-123456789', 'the environment wins')
    assert.equal(process.env.ELEVENLABS_API_KEY, 'saved-el-123456')
    const status = keyStatus()
    assert.deepEqual([status.NVIDIA_API_KEY.set, status.ELEVENLABS_API_KEY.from, status.TAVILY_API_KEY.set], [true, 'saved', false])
    assert.ok(!JSON.stringify(status).includes('saved-el-123456'), 'no key in what the window sees')
  } finally {
    for (const k of ['NVIDIA_API_KEY', 'ELEVENLABS_API_KEY', 'TAVILY_API_KEY']) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
  }
})

test('saving a key passes it on standard input, never on the command line; nonsense is refused', () => {
  const before = process.env.TAVILY_API_KEY
  try {
    delete process.env.TAVILY_API_KEY
    const calls = []
    const run = (args, input) => (calls.push({ args, input }), { ok: true })
    saveSecret('TAVILY_API_KEY', 'tvly-abcdef123456', { run })
    assert.deepEqual(calls[0], { args: ['-Op', 'write', '-Name', 'TAVILY_API_KEY'], input: 'tvly-abcdef123456' })
    assert.ok(!calls[0].args.join(' ').includes('tvly-'))
    assert.equal(process.env.TAVILY_API_KEY, 'tvly-abcdef123456')
    assert.throws(() => saveSecret('TAVILY_API_KEY', 'has spaces in it', { run }), /doesn't look like/)
    assert.throws(() => saveSecret('SOMETHING_ELSE', 'abcdefghijk', { run }), /no key called/)
    saveSecret('TAVILY_API_KEY', '', { run })
    assert.deepEqual(calls.at(-1).args, ['-Op', 'delete', '-Name', 'TAVILY_API_KEY'])
    assert.equal(process.env.TAVILY_API_KEY, undefined)
  } finally {
    if (before === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = before
  }
})

test('testing a key: NVIDIA by its model list; an ElevenLabs key limited in permissions still counts', async () => {
  const reply = (status, body = {}) => async () => ({ ok: status === 200, status, json: async () => body })
  assert.deepEqual(await testKey('NVIDIA_API_KEY', 'k-123456789', { fetchImpl: reply(200) }), { ok: true })
  assert.match((await testKey('NVIDIA_API_KEY', 'k-123456789', { fetchImpl: reply(401) })).why, /didn't accept/)
  assert.deepEqual(await testKey('ELEVENLABS_API_KEY', 'k-123456789',
    { fetchImpl: reply(401, { detail: { status: 'missing_permissions' } }) }), { ok: true })
  assert.match((await testKey('ELEVENLABS_API_KEY', 'k-123456789',
    { fetchImpl: reply(401, { detail: { status: 'invalid_api_key' } }) })).why, /didn't accept/)
  assert.match((await testKey('NVIDIA_API_KEY', 'k-123456789', { fetchImpl: async () => { throw new Error('offline') } })).why, /Couldn't reach/)
})

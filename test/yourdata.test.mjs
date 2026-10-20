/** Your data (bridge/yourdata.mjs): everything Gnosis keeps, to see and clear. Fresh stores only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDataView, sizeOf } from '../bridge/yourdata.mjs'
import { createMemory } from '../bridge/memory.mjs'
import { createPrivateMemory } from '../bridge/privacy.mjs'
import { createJobStore } from '../bridge/schedule.mjs'
import { createSkillStore } from '../bridge/teach.mjs'
import { createAttachments } from '../bridge/attachments.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-yourdata-'))
  const memory = createMemory(join(dir, 'memory.json'))
  const privateMemory = createPrivateMemory(join(dir, 'private-memory.json'))
  const schedule = createJobStore(join(dir, 'schedule.json'))
  const skills = createSkillStore(join(dir, 'skills'))
  const attachments = createAttachments(join(dir, 'attachments'))
  let voiceKnown = true
  const voice = { status: () => (voiceKnown ? { enrolled: true, seconds: 14, at: '2026-10-20T10:00:00Z' } : { enrolled: false }), forget: () => { voiceKnown = false } }
  const opened = []
  const data = createDataView({ memory, privateMemory, schedule, skills, attachments, voice, readSettings: () => ({ quietHours: '23:00-07:00' }),
    dir, openFolder: (p) => opened.push(p) })
  return { dir, memory, privateMemory, schedule, skills, attachments, data, opened }
}

test('the view shows every kind of stored data, private words hidden', () => {
  const s = setup()
  s.memory.remember({ subject: 'owner', predicate: 'favourite food', value: 'biryani' })
  s.memory.addEpisode('what time is it?', 'Ten past three.')
  s.privateMemory.add('My locker code is 4417, private')
  s.schedule.add({ kind: 'reminder', text: 'stretch', next: Date.now() + 60_000 })
  s.skills.save({ name: 'monthly-report', description: 'Make the report', params: ['month'], steps: [{ do: 'type', text: '{month}' }] })
  s.attachments.save({ name: 'list.txt', bytes: Buffer.from('milk') })
  mkdirSync(join(s.dir, 'sessions'))
  writeFileSync(join(s.dir, 'sessions', 'a.json'), '{}')
  const v = s.data.view()
  assert.deepEqual(v.facts.map((f) => f.value), ['biryani'])
  assert.deepEqual(v.history.map((e) => e.request), ['what time is it?'])
  assert.equal(v.privateNotes.length, 1)
  assert.ok(!JSON.stringify(v).includes('4417'), 'private words are not in the view')
  assert.deepEqual(v.reminders.map((r) => r.text), ['stretch'])
  assert.deepEqual(v.skills.map((k) => [k.name, k.steps]), [['monthly-report', 1]])
  assert.deepEqual(v.attachments.map((a) => a.name), ['list.txt'])
  assert.equal(v.voice.enrolled, true)
  assert.equal(v.conversations.files, 1)
  assert.deepEqual(v.settings, { quietHours: '23:00-07:00' })
  assert.ok(v.total.files >= 6)
})

test('every item can be deleted from the screen, and private words show only when asked', () => {
  const s = setup()
  const fact = s.memory.remember({ subject: 'Asha', predicate: 'birthday', value: '3 March' })
  s.memory.remember({ subject: 'owner', predicate: 'city', value: 'Hyderabad' })
  s.memory.addEpisode('a', '1')
  s.memory.addEpisode('b', '2')
  const note = s.privateMemory.add('PIN 1234, private')
  const job = s.schedule.add({ kind: 'reminder', text: 'stretch', next: Date.now() + 60_000 })
  s.skills.save({ name: 'x', description: '', steps: [{ do: 'keys', keys: 'enter' }] })
  const file = s.attachments.save({ name: 'p.png', bytes: Buffer.from([1]) })
  mkdirSync(join(s.dir, 'research'))
  writeFileSync(join(s.dir, 'research', 'r.json'), '{}')

  assert.equal(s.data.act({ what: 'forget_fact', id: fact.id }).ok, true)
  assert.deepEqual(s.data.view().facts.map((f) => f.predicate), ['city'])
  s.data.act({ what: 'forget_all_facts' })
  assert.equal(s.data.view().facts.length, 0)
  const at = s.data.view().history[0].at
  assert.equal(s.data.act({ what: 'forget_exchange', at }).ok, true)
  assert.equal(s.data.view().history.length, 1)
  assert.equal(s.data.act({ what: 'forget_history' }).removed, 1)
  assert.deepEqual(s.data.act({ what: 'show_private' }).notes.map((n) => n.text), ['PIN 1234, private'])
  assert.equal(s.data.act({ what: 'delete_private', id: note.id }).ok, true)
  assert.equal(s.privateMemory.all().length, 0)
  assert.equal(s.data.act({ what: 'cancel_reminder', id: job.id }).ok, true)
  assert.equal(s.data.act({ what: 'delete_skill', name: 'x' }).ok, true)
  assert.equal(s.data.act({ what: 'delete_attachment', id: file.id }).ok, true)
  assert.equal(s.data.act({ what: 'forget_voice' }).ok, true)
  assert.equal(s.data.view().voice.enrolled, false)
  assert.deepEqual(s.data.act({ what: 'clear_research' }), { ok: true, removed: 1 })
  assert.equal(existsSync(join(s.dir, 'research', 'r.json')), false)
  s.data.act({ what: 'open_folder' })
  assert.deepEqual(s.opened, [s.dir])
  assert.throws(() => s.data.act({ what: 'rm_rf' }), /no "rm_rf"/)
  const v = s.data.view()
  assert.deepEqual([v.reminders.length, v.skills.length, v.attachments.length], [0, 0, 0])
})

test('sizes add up across a folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-size-'))
  writeFileSync(join(dir, 'a'), 'abc')
  mkdirSync(join(dir, 'b'))
  writeFileSync(join(dir, 'b', 'c'), 'de')
  assert.deepEqual(sizeOf(dir), { bytes: 5, files: 2 })
  assert.deepEqual(sizeOf(join(dir, 'nope')), { bytes: 0, files: 0 })
})

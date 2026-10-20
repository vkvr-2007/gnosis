/** Teach mode and saved skills (bridge/teach.mjs), ported from Gnosis v1. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillStore, fill, fromMarkdown, stepsFromTrace, stepText, teachServer, toMarkdown, validate } from '../bridge/teach.mjs'
import { createGate } from '../bridge/gate.mjs'

const freshStore = () => createSkillStore(mkdtempSync(join(tmpdir(), 'gnosis-skills-')))

// What teach.ps1 printed for a throwaway test window, 2026-10-19 (plus the owner going back to Gnosis).
const TRACE = [
  { kind: 'click', app: 'EXCEL', window: 'Book1 - Excel', name: 'Name Box', type: 'Edit' },
  { kind: 'text', text: 'M', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'text', text: 'a', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'text', text: 'x', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'key', combo: 'backspace', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'text', text: 'r', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'key', combo: 'enter', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'key', combo: 'ctrl+s', app: 'EXCEL', window: 'Book1 - Excel' },
  { kind: 'skipped', reason: "Typing in a password field wasn't recorded" },
  { kind: 'click', app: 'powershell', window: 'Teach Test', name: 'Greet', type: 'Button' },
  { kind: 'click', app: 'powershell', window: 'Teach Test', name: '', type: 'Pane' },
  { kind: 'click', app: 'chrome', window: 'Gnosis', name: 'Talk', type: 'Button' },
  { kind: 'text', text: 'done', app: 'chrome', window: 'Gnosis' },
]

test('a recording becomes steps: by name, typing joined, typos put right, keys grouped, Gnosis left out', () => {
  const { steps, notes } = stepsFromTrace(TRACE, { own: 'Gnosis' })
  assert.deepEqual(steps, [
    { do: 'focus', app: 'EXCEL', window: 'Book1 - Excel' },
    { do: 'click', name: 'Name Box', type: 'Edit' },
    { do: 'type', text: 'Mar' },
    { do: 'keys', keys: 'enter ctrl+s' },
    { do: 'focus', app: 'powershell', window: 'Teach Test' },
    { do: 'click', name: 'Greet', type: 'Button' },
  ])
  assert.deepEqual(notes, ["Typing in a password field wasn't recorded", 'A click in Teach Test on something without a name was left out'])
})

test('a skill is a readable SKILL.md and reads back the same', () => {
  const skill = { name: 'monthly-report', description: 'Make the monthly report', params: ['month'], source: 'taught',
    created: Date.parse('2026-10-19T12:00:00Z'),
    steps: [{ do: 'focus', app: 'EXCEL', window: '' }, { do: 'type', text: 'Report for {month}' }, { do: 'keys', keys: 'ctrl+s' }] }
  const md = toMarkdown(skill)
  assert.match(md, /^---\nname: monthly-report\n/)
  assert.match(md, /2\. Type "Report for \{month\}"/)
  assert.deepEqual(fromMarkdown(md), skill)
})

test('validation: names, step kinds, and every placeholder has a param', () => {
  const ok = { name: 'x', description: '', params: ['month'], steps: [{ do: 'type', text: '{month}' }] }
  validate(ok)
  assert.throws(() => validate({ ...ok, name: 'Monthly Report' }), /lowercase letters/)
  assert.throws(() => validate({ ...ok, steps: [] }), /at least one step/)
  assert.throws(() => validate({ ...ok, steps: [{ do: 'run_skill' }] }), /isn't a step/)
  assert.throws(() => validate({ ...ok, params: [] }), /without a matching param: month/)
  assert.deepEqual(fill(ok, { month: 'March' }), [{ do: 'type', text: 'March' }])
  assert.throws(() => fill(ok, {}), /needs: month/)
  assert.equal(stepText({ do: 'click', name: 'Save', type: 'Button' }), 'Click "Save" (button)')
})

test('the tools: watch, done, save, list, run (the steps come back to carry out), delete', async () => {
  const store = freshStore()
  const recorder = { ready: Promise.resolve(), stop: async () => TRACE }
  const tools = Object.fromEntries(teachServer({ store, record: () => recorder }).tools.map((t) => [t.name, t]))
  const call = async (name, args = {}) => tools[name].handler(args)
  const said = (r) => r.content[0].text
  assert.match(said(await call('teach_stop')), /wasn't watching/)
  if (process.platform === 'win32') {
    assert.match(said(await call('teach_start')), /^Watching/)
    assert.match(said(await call('teach_start')), /already watching/)
    const stopped = said(await call('teach_stop'))
    assert.match(stopped, /^Recorded 6 steps:\n1\. Go to EXCEL/)
    assert.match(stopped, /Left out: Typing in a password field/)
  }
  const saved = await call('save_skill', { name: 'monthly-report', description: 'Make the monthly report', params: ['month'],
    steps: [{ do: 'focus', app: 'EXCEL' }, { do: 'type', text: 'Report for {month}' }] })
  assert.match(said(saved), /^Saved the skill "monthly-report" \(2 steps\)/)
  assert.match(readFileSync(join(store.root, 'monthly-report', 'SKILL.md'), 'utf8'), /# monthly-report/)
  assert.match(said(await call('list_skills')), /monthly-report: Make the monthly report \(needs: month\)/)
  assert.match(tools.run_skill.description, /Saved skills: monthly-report/)
  const run = said(await call('run_skill', { name: 'monthly-report', params: { month: 'March' } }))
  assert.match(run, /^Do these steps now/)
  assert.match(run, /2\. Type "Report for March"/)
  assert.equal((await call('run_skill', { name: 'monthly-report' })).isError, true)
  assert.equal((await call('save_skill', { name: 'Bad Name', description: '', steps: [{ do: 'type', text: 'x' }] })).isError, true)
  assert.match(said(await call('delete_skill', { name: 'monthly-report' })), /^Deleted/)
  assert.match(said(await call('list_skills')), /No skills saved yet/)
})

test('the gate runs teach mode, and asks before saving or deleting a skill', () => {
  const gate = createGate({ allowWrites: false })
  assert.equal(gate.review('mcp__ayra_teach__teach_start').verdict, 'allow')
  assert.equal(gate.review('mcp__ayra_teach__run_skill', { name: 'x' }).verdict, 'allow')
  const save = gate.review('mcp__ayra_teach__save_skill', { name: 'monthly-report', description: 'Report', steps: [{}, {}] })
  assert.deepEqual([save.verdict, save.detail], ['ask', 'Save the skill "monthly-report": Report (2 steps)'])
  assert.equal(gate.review('mcp__ayra_teach__delete_skill', { name: 'x' }).verdict, 'ask')
})

test('"watch me" needs a tool; "done" does too, but only while watching', async () => {
  const { ACTION_HINTS, ASKS_ACTION } = await import('../bridge/sdk.mjs')
  const { DONE } = await import('../bridge/teach.mjs')
  for (const q of ['watch me', 'learn this', 'let me show you how I do the report']) assert.match(q, ASKS_ACTION, q)
  for (const q of ['done', "ok that's it", 'finished', "I'm done"]) assert.match(q, DONE, q)
  assert.doesNotMatch('what have you done today?', DONE)
  const recorder = { ready: Promise.resolve(), stop: async () => [] }
  const tools = Object.fromEntries(teachServer({ store: freshStore(), record: () => recorder }).tools.map((t) => [t.name, t]))
  const hint = ACTION_HINTS.at(-1)
  assert.equal(hint('done'), false)
  if (process.platform === 'win32') {
    await tools.teach_start.handler({})
    assert.equal(hint('done'), true)
    await tools.teach_stop.handler({})
    assert.equal(hint('done'), false)
  }
})

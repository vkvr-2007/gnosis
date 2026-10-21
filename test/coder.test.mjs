/** The coding agent (bridge/coder.mjs): Claude Code on the owner's plan, with a fake claude. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { absorb, ALLOWED, checkFolder, coderServer, createCoder, OFF_LIMITS, REFUSED, slug } from '../bridge/coder.mjs'

// The temp folder is inside AppData, which the real list refuses: tests use the list without it.
const offLimits = OFF_LIMITS().filter((p) => !/AppData$/i.test(p))
import { createGate } from '../bridge/gate.mjs'

/** A fake `claude -p`: emits the given stream-json lines, then closes. */
function fakeClaude(lines, calls) {
  return (args, cwd) => {
    calls.push({ args, cwd })
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1, kill() {} })
    setTimeout(() => {
      for (const l of lines) proc.stdout.emit('data', `${JSON.stringify(l)}\n`)
      proc.emit('close', 0)
    }, 5)
    return proc
  }
}
const until = (fn) => new Promise((r) => { const t = setInterval(() => fn() && (clearInterval(t), r()), 5) })
const RUN = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Setting up the project.' }, { type: 'tool_use', name: 'Write', input: { file_path: 'C:/p/index.html' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Built a to-do page. Open index.html. Nothing left.', session_id: 'sess-1' },
]

test('folders: new projects in GnosisProjects; an existing folder by name; never Gnosis, Windows or a whole drive', () => {
  const root = mkdtempSync(join(tmpdir(), 'gnosis-projects-'))
  assert.equal(checkFolder(join(root, 'todo'), { root, offLimits }), join(root, 'todo'))
  const existing = mkdtempSync(join(tmpdir(), 'my-app-'))
  assert.equal(checkFolder(existing, { root, offLimits }), existing)
  assert.throws(() => checkFolder(join(tmpdir(), 'does-not-exist-xyz'), { root, offLimits }), /doesn't exist/)
  assert.throws(() => checkFolder('C:\\', { root, offLimits }), /whole drive/)
  assert.throws(() => checkFolder(homedir(), { root, offLimits }), /whole user folder/)
  assert.throws(() => checkFolder(process.env.WINDIR ?? 'C:\\Windows', { root, offLimits }), /Gnosis or Windows/)
  assert.throws(() => checkFolder(join(import.meta.dirname, '..', 'bridge'), { root, offLimits }), /Gnosis or Windows/)
  assert.equal(slug('My Todo App!'), 'my-todo-app')
})

test('a job: Claude Code is run headless in the folder with the brief and the limits, and its progress is followed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gnosis-projects-'))
  const calls = []
  const ended = []
  const coder = createCoder({ file: join(root, 'coding.json'), root, offLimits, run: fakeClaude(RUN, calls), onEnd: (j) => ended.push(j), log: () => {} })
  const job = coder.start({ task: 'Build a to-do web page', name: 'Todo page' })
  assert.equal(job.folder, join(root, 'todo-page'))
  assert.throws(() => coder.start({ task: 'another' }), /still running/)
  await until(() => ended.length)
  const a = calls[0].args
  assert.equal(calls[0].cwd, job.folder)
  assert.deepEqual(a.slice(0, 2), ['-p', 'Build a to-do web page'])
  for (const flag of ['--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--max-turns', '--append-system-prompt']) assert.ok(a.includes(flag), flag)
  assert.equal(a[a.indexOf('--allowedTools') + 1], ALLOWED.join(','))
  assert.equal(a[a.indexOf('--disallowedTools') + 1], REFUSED.join(','))
  assert.ok(REFUSED.includes('Bash(git push:*)') && !ALLOWED.some((t) => /push|deploy|rm:/.test(t)))
  const done = coder.get(job.id)
  assert.deepEqual([done.status, done.session, done.steps, done.files], ['done', 'sess-1', 2, ['index.html']])
  assert.match(done.result, /^Built a to-do page/)
  // A follow-up continues the same Claude Code session in the same folder.
  coder.continue({ instruction: 'Add a dark mode' })
  await until(() => ended.length === 2)
  assert.deepEqual(calls[1].args.slice(-2), ['--resume', 'sess-1'])
  assert.equal(calls[1].cwd, job.folder)
})

test('the stream: a turn limit and a usage limit are said plainly', () => {
  const job = {}
  absorb(job, JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }))
  assert.equal(job.status, 'failed')
  assert.match(job.result, /step limit/)
  const limited = {}
  absorb(limited, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' }))
  assert.equal(limited.status, 'limit')
  assert.match(limited.result, /^Your Claude plan's usage limit was reached\. .*reset at 5pm/)
  assert.equal(absorb({}, 'not json'), null)
})

test('the tools, and the gate asks the owner before Claude Code starts or continues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gnosis-projects-'))
  const coder = createCoder({ file: join(root, 'coding.json'), root, offLimits, run: fakeClaude(RUN, []), log: () => {} })
  const tools = Object.fromEntries(coderServer(coder).tools.map((t) => [t.name, t.handler]))
  assert.match((await tools.code_status({})).content[0].text, /No coding jobs yet/)
  assert.match((await tools.code_start({ task: 'a calculator', folder: 'relative\\path' })).content[0].text, /full path/)
  assert.match((await tools.code_start({ task: 'a calculator', name: 'calc' })).content[0].text, /^Started coding job #1 in .*calc/)
  await until(() => coder.get(1)?.status === 'done')
  assert.match((await tools.code_status({})).content[0].text, /#1 \(done[^)]*\) "a calculator"[\s\S]*Result: Built a to-do page/)
  const gate = createGate({ allowWrites: false })
  const r = gate.review('mcp__ayra_code__code_start', { task: 'a calculator', name: 'calc' })
  assert.deepEqual([r.verdict, r.detail], ['ask', 'Claude Code (new project "calc"): a calculator'])
  assert.equal(gate.review('mcp__ayra_code__code_continue', { instruction: 'x' }).verdict, 'ask')
  assert.equal(gate.review('mcp__ayra_code__code_status', {}).verdict, 'allow')
})

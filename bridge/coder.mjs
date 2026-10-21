/**
 * The coding agent (the owner's list item 6, ported from Gnosis v1's coder): builds and changes code
 * projects by running Claude Code, signed in with the owner's own Claude Pro plan, headless in the
 * project's folder (the owner, 2026-10-21: "make sure the coding agent can utilize my claude pro
 * app/web in an optimised way for a project building or coding").
 *
 * Gnosis (Nemotron) talks; Claude Code codes. A job runs in the background: `claude -p` with the
 * task, streaming JSON back, so progress can be told and the result reported when it's done.
 *
 * Kind to the Pro plan's limits:
 *   - one job at a time;
 *   - the project keeps PLAN.md (a checklist) and CLAUDE.md (notes), and a follow-up continues the
 *     same Claude Code session (--resume), so nothing is explained twice;
 *   - a turn limit per job; a usage limit reached is said plainly, with when it resets if given.
 * And careful with the laptop:
 *   - the owner approves each job first (gate.mjs), seeing the task and the folder;
 *   - only that folder is edited (acceptEdits there); the commands it may run are listed (build, test,
 *     install, run, git without push); pushing, deploying and deleting outside it are refused;
 *   - never in Gnosis's own folders, the Windows folders, or the root of a drive.
 * "Open it in Claude Code" opens a terminal in the project on the same session, for the owner.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DATA_DIR, dataPath } from './paths.mjs'
import { createSdkMcpServer, tool } from './sdk.mjs'

export const JOBS_FILE = dataPath('coding.json')
export const PROJECTS_ROOT = join(homedir(), 'GnosisProjects')
const GNOSIS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MAX_TURNS = 80
const SILENT_MS = 10 * 60_000

/** Ends Claude Code and anything it started (a dev server, a test run). */
function killTree(proc) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    else proc.kill()
  } catch { /* already gone */ }
}

/** What Claude Code may run without asking: building, testing and running a project; git without push. */
export const ALLOWED = [
  'Edit', 'Write', 'Read', 'Glob', 'Grep', 'TodoWrite', 'WebSearch', 'WebFetch',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(bun:*)',
  'Bash(python:*)', 'Bash(python3:*)', 'Bash(py:*)', 'Bash(pip:*)', 'Bash(pytest:*)', 'Bash(uv:*)',
  'Bash(dotnet:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(java:*)', 'Bash(javac:*)', 'Bash(mvn:*)', 'Bash(gradle:*)',
  'Bash(git init:*)', 'Bash(git status:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(git branch:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git restore:*)',
  'Bash(ls:*)', 'Bash(dir:*)', 'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(type:*)', 'Bash(echo:*)', 'Bash(pwd:*)', 'Bash(where:*)', 'Bash(which:*)',
]
/** Never, whatever the task: these leave the folder or can't be taken back. */
export const REFUSED = [
  'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(gh:*)', 'Bash(vercel:*)', 'Bash(netlify:*)', 'Bash(npm publish:*)',
  'Bash(rm:*)', 'Bash(del:*)', 'Bash(rmdir:*)', 'Bash(Remove-Item:*)', 'Bash(format:*)', 'Bash(shutdown:*)',
  'Bash(curl:*)', 'Bash(Invoke-WebRequest:*)', 'Bash(reg:*)', 'Bash(setx:*)',
]

/** The brief Claude Code works to, on top of its own system prompt. */
export const BRIEF = [
  'You are the coding agent of Gnosis, the owner\'s assistant, working in this project folder only.',
  'Work in small, verified steps: build or test after each one. Keep PLAN.md as a short checklist of the job and',
  'tick items off as they are done, and keep CLAUDE.md as brief notes for whoever continues (how to run it,',
  'decisions, what is left), so later sessions start without re-reading everything.',
  'Commit to git locally when a step works. Never push, deploy, publish or delete anything outside this folder.',
  'Prefer simple, standard tools. If something needs the owner (a key, an account, a decision), stop and say so.',
  'End with three short sentences: what was built or changed, how to run it, and what is left.',
].join(' ')

/** Folders the coding agent never works in. */
export const OFF_LIMITS = () => [GNOSIS_ROOT, DATA_DIR, process.env.WINDIR ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', join(homedir(), 'AppData')]

/** A project folder Claude Code may work in: inside GnosisProjects, or an existing folder named by the owner. */
export function checkFolder(folder, { root = PROJECTS_ROOT, exists = existsSync, offLimits = OFF_LIMITS() } = {}) {
  const f = normalize(resolve(folder))
  const lower = f.toLowerCase()
  const forbidden = offLimits.map((p) => normalize(resolve(p)).toLowerCase())
  if (/^[a-z]:\\?$/i.test(f)) throw new Error('Not the whole drive: name a project folder.')
  if (lower === normalize(homedir()).toLowerCase()) throw new Error('Not the whole user folder: name a project folder.')
  for (const p of forbidden) {
    if (lower === p || lower.startsWith(p + sep) || p.startsWith(lower + sep)) throw new Error(`Not ${f}: that holds Gnosis or Windows itself.`)
  }
  const inRoot = lower === normalize(root).toLowerCase() || lower.startsWith(normalize(root).toLowerCase() + sep)
  if (!inRoot && !exists(f)) throw new Error(`${f} doesn't exist. New projects go in ${root}.`)
  return f
}

/** A folder name from a project name: "My Todo App" → "my-todo-app". */
export const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'

/** One line of Claude Code's stream-json, folded into a job's progress. */
export function absorb(job, line) {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return null
  }
  if (m.type === 'system' && m.subtype === 'init') {
    if (m.session_id) job.session = m.session_id
    if (m.model) job.model = m.model
    return 'start'
  }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) job.lastText = b.text.trim().slice(0, 600)
      if (b.type === 'tool_use') {
        job.steps = (job.steps ?? 0) + 1
        const file = b.input?.file_path ?? b.input?.path
        if ((b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit') && file) {
          job.files = [...new Set([...(job.files ?? []), basename(String(file))])].slice(-40)
        }
        if (b.name === 'Bash' && b.input?.command) job.lastCommand = String(b.input.command).slice(0, 160)
      }
    }
    return 'progress'
  }
  if (m.type === 'result') {
    job.result = String(m.result ?? '').trim().slice(0, 2000)
    job.status = m.is_error || m.subtype !== 'success' ? 'failed' : 'done'
    if (m.subtype === 'error_max_turns') job.result = `It reached its ${MAX_TURNS}-step limit before finishing. ${job.result}`.trim()
    if (/usage limit|limit reached|rate limit|resets? (?:at|in)/i.test(job.result)) {
      job.status = 'limit'
      job.result = `Your Claude plan's usage limit was reached. ${job.result}`
    }
    if (m.session_id) job.session = m.session_id
    return 'end'
  }
  return null
}

/**
 * @param {{ file?: string, root?: string, run?: (args: string[], cwd: string) => import('node:child_process').ChildProcess,
 *           onEnd?: (job: object) => void, log?: (s: string) => void, now?: () => number }} deps
 */
export function createCoder({ file = JOBS_FILE, root = PROJECTS_ROOT, run, onEnd = () => {}, log = console.log, now = Date.now, offLimits = OFF_LIMITS() } = {}) {
  run ??= (args, cwd) => {
    const env = { ...process.env }
    delete env.CLAUDECODE // Gnosis is not itself inside Claude Code; never pass the marker on
    delete env.CLAUDE_CODE_ENTRYPOINT
    // Straight to claude.exe, not through a shell, so the task's words reach it exactly as given.
    // No input: with its input open, `claude -p` waits for it to end before starting (seen 2026-10-21).
    return spawn('claude', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  let jobs = []
  try {
    jobs = JSON.parse(readFileSync(file, 'utf8')).jobs ?? []
  } catch {
    jobs = []
  }
  // A job cut off by the last restart is not still running.
  for (const j of jobs) if (j.status === 'running') j.status = 'stopped'
  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ jobs: jobs.slice(-50) }, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  let current = null // { job, proc }

  function launch(job, prompt, resume) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--max-turns', String(MAX_TURNS), '--append-system-prompt', BRIEF,
      '--allowedTools', ALLOWED.join(','), '--disallowedTools', REFUSED.join(','),
      ...(resume ? ['--resume', resume] : [])]
    const proc = run(args, job.folder)
    current = { job, proc }
    job.status = 'running'
    job.started = now()
    save()
    let buf = ''
    // Ten minutes with nothing from it: stopped, and said so, rather than waiting for ever.
    let heard = now()
    const watch = setInterval(() => {
      if (now() - heard < SILENT_MS) return
      job.stalled = true
      job.result = 'Claude Code went quiet for ten minutes, so the job was stopped.'
      killTree(proc)
    }, 30_000)
    watch.unref?.()
    proc.stdout?.on('data', (d) => {
      heard = now()
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line && absorb(job, line) === 'start') save()
      }
    })
    let err = ''
    proc.stderr?.on('data', (d) => (err = (err + d).slice(-800)))
    proc.on('error', (e) => (err = String(e?.message ?? e)))
    proc.on('close', (code) => {
      clearInterval(watch)
      if (buf.trim()) absorb(job, buf.trim())
      if (job.status === 'running') {
        job.status = job.stopped || job.stalled ? 'stopped' : 'failed'
        job.result ||= job.stopped ? 'Stopped on request.' : `Claude Code ended without a result${err ? `: ${err.trim().slice(0, 300)}` : ''} (exit ${code}).`
      }
      job.ended = now()
      if (current?.job === job) current = null
      save()
      log(`[gnosis] coding job #${job.id} ${job.status} (${job.steps ?? 0} steps)`)
      onEnd(job)
    })
  }

  return {
    busy: () => Boolean(current),
    list: () => jobs.slice().reverse(),
    get: (id) => (id == null ? (current?.job ?? jobs.at(-1) ?? null) : jobs.find((j) => j.id === Number(id)) ?? null),
    /** Starts a job; returns it. */
    start({ task, folder = null, name = null }) {
      if (current) throw new Error(`Job #${current.job.id} is still running; one at a time keeps your Claude plan's limits for the work. Wait, or stop it.`)
      const target = checkFolder(folder ?? join(root, slug(name ?? task.split(/\s+/).slice(0, 5).join(' '))), { root, offLimits })
      mkdirSync(target, { recursive: true })
      if (!statSync(target).isDirectory()) throw new Error(`${target} is a file, not a folder.`)
      const job = { id: (jobs.at(-1)?.id ?? 0) + 1, task: String(task).slice(0, 2000), folder: target, status: 'starting', steps: 0, files: [] }
      jobs.push(job)
      launch(job, task, null)
      log(`[gnosis] coding job #${job.id} started in ${target}`)
      return job
    },
    /** A follow-up on the same project and Claude Code session. */
    continue({ id = null, instruction }) {
      if (current) throw new Error(`Job #${current.job.id} is still running. Wait for it, or stop it.`)
      const prev = this.get(id)
      if (!prev?.session) throw new Error("There's no earlier coding job to continue.")
      const job = { id: (jobs.at(-1)?.id ?? 0) + 1, task: String(instruction).slice(0, 2000), folder: prev.folder, follows: prev.id,
        status: 'starting', steps: 0, files: [] }
      jobs.push(job)
      launch(job, instruction, prev.session)
      return job
    },
    stop() {
      if (!current) return false
      current.job.stopped = true
      killTree(current.proc)
      return true
    },
    /** A terminal in the project, on the same Claude Code session, for the owner to carry on. */
    openForOwner(id = null) {
      const job = this.get(id)
      if (!job) throw new Error('There is no coding job yet.')
      const cmd = job.session ? `claude --resume ${job.session}` : 'claude'
      spawn('cmd.exe', ['/c', 'start', '"Gnosis coding"', 'cmd', '/k', `cd /d "${job.folder}" && ${cmd}`],
        { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      return job
    },
  }
}

const describe = (j) => {
  const took = j.ended && j.started ? ` in ${Math.max(1, Math.round((j.ended - j.started) / 60_000))} min` : ''
  return `#${j.id} (${j.status}${took}) "${j.task.slice(0, 120)}" in ${j.folder}` +
    `${j.files?.length ? `; files: ${j.files.slice(-8).join(', ')}` : ''}${j.steps ? `; ${j.steps} steps` : ''}`
}

/** The coding tools (server ayra_code). Starting and continuing a job ask the owner first (gate.mjs). */
export function coderServer(coder) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  const guard = (fn) => async (args) => {
    try {
      return text(await fn(args))
    } catch (err) {
      return fail(err.message)
    }
  }
  return createSdkMcpServer({
    name: 'gnosis_code',
    tools: [
      tool('code_start',
        'Build or change a code project with Claude Code, on the owner\'s Claude Pro plan, in the background: an app, a ' +
          'website, a script, a fix. Give the whole task in the owner\'s words, plus anything they said about it. New ' +
          'projects get a folder in GnosisProjects; give folder only for an existing project they named. The owner ' +
          'approves it first. Say it has started and that you will tell them when it is done.',
        { task: z.string(), name: z.string().optional().describe('A short project name for a new folder'),
          folder: z.string().optional().describe('An existing project folder the owner named') },
        guard(async ({ task, name, folder }) => {
          if (folder && !isAbsolute(folder)) throw new Error('Give the folder as a full path, like C:\\Users\\you\\project.')
          const j = coder.start({ task, name, folder })
          return `Started coding job #${j.id} in ${j.folder}. Claude Code is working on it; I'll say when it's done.`
        })),
      tool('code_status', 'How the coding job is going (the latest, or one by id), or the list of jobs.',
        { id: z.number().int().optional(), all: z.boolean().optional() },
        guard(async ({ id, all }) => {
          if (all) return coder.list().slice(0, 10).map(describe).join('\n') || 'No coding jobs yet.'
          const j = coder.get(id)
          if (!j) return 'No coding jobs yet.'
          return `${describe(j)}${j.lastCommand ? `\nLast command: ${j.lastCommand}` : ''}${j.status === 'running' ? (j.lastText ? `\nLatest: ${j.lastText}` : '') : `\nResult: ${j.result ?? ''}`}`
        })),
      tool('code_continue',
        'A follow-up on a coding project ("now add a dark mode", "fix the error"): continues the same Claude Code session, ' +
          'so it remembers the project. The owner approves it first.',
        { instruction: z.string(), id: z.number().int().optional() },
        guard(async ({ instruction, id }) => {
          const j = coder.continue({ instruction, id })
          return `Continuing in ${j.folder} as job #${j.id}. I'll say when it's done.`
        })),
      tool('code_stop', 'Stop the coding job that is running.', {}, guard(async () => (coder.stop() ? 'Stopping the coding job.' : 'No coding job is running.'))),
      tool('code_open', 'Open the coding project in Claude Code in a terminal, for the owner to carry on there themselves.',
        { id: z.number().int().optional() },
        guard(async ({ id }) => `Opened ${coder.openForOwner(id).folder} in Claude Code.`)),
    ],
  })
}

/**
 * Teach mode and saved skills, ported from Gnosis v1 (gnosis/teach/).
 *
 * "Watch me": teach.ps1 records the owner's clicks (by the control's name, not its position, so a
 * skill survives windows moving) and typing (never in a password field, never while a password
 * manager is in front) until "done". The steps come back to the brain, which shows them, asks what
 * changes each time (a month, a file name) and saves a skill with {placeholders}: data/skills/<name>/
 * SKILL.md, readable and editable.
 *
 * A skill is not code. "Do the monthly report for March" hands its steps, filled in, back to the
 * brain to carry out with its ordinary tools, each call reviewed by the gate as usual, so a skill can
 * never do more than the owner could ask for directly. Saving and deleting one are asked about first
 * (gate.mjs review), and skills can't save, run or delete skills.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { IDENTITY } from './identity.mjs'
import { ACTION_HINTS, createSdkMcpServer, tool } from './sdk.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'teach.ps1')
export const SKILLS_DIR = fileURLToPath(new URL('../data/skills/', import.meta.url))

const NAME = /^[a-z0-9][a-z0-9-]{0,48}$/
const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g
/** Steps a skill is made of. */
export const STEP_KINDS = ['open', 'focus', 'click', 'type', 'keys', 'say']

/**
 * Recorded events → skill steps, and notes about anything left out.
 *   { do: 'focus', app, window } when the owner moves to another app
 *   { do: 'click', name, type }   the control clicked, by name
 *   { do: 'type', text }          consecutive typing joined
 *   { do: 'keys', keys }          Enter, Tab, Ctrl+S…
 * Events in Gnosis's own window (where the owner says "done") are left out.
 */
export function stepsFromTrace(events, { own = IDENTITY.wordmark } = {}) {
  const steps = []
  const notes = []
  let app = null
  const ownWindow = (e) => String(e.window ?? '').trim() === own
  for (const ev of events) {
    const last = steps.at(-1)
    if (ev.kind === 'skipped') {
      notes.push(ev.reason)
      continue
    }
    if (!['click', 'text', 'key'].includes(ev.kind) || ownWindow(ev)) continue
    if (ev.app && ev.app !== app) {
      app = ev.app
      steps.push({ do: 'focus', app: ev.app, window: ev.window ?? '' })
    }
    if (ev.kind === 'click') {
      if (ev.name) steps.push({ do: 'click', name: ev.name, ...(ev.type ? { type: ev.type } : {}) })
      else notes.push(`A click in ${ev.window || ev.app || 'an app'} on something without a name was left out`)
    } else if (ev.kind === 'text') {
      if (last?.do === 'type') last.text += ev.text
      else steps.push({ do: 'type', text: ev.text })
    } else if (ev.combo === 'backspace' && last?.do === 'type' && last.text) {
      // A typo put right as it was typed: keep only what was meant.
      last.text = last.text.slice(0, -1)
      if (!last.text) steps.pop()
    } else if (last?.do === 'keys') {
      last.keys += ` ${ev.combo}`
    } else {
      steps.push({ do: 'keys', keys: ev.combo })
    }
  }
  // A focus with nothing done after it (the owner went back to Gnosis to say "done").
  while (steps.at(-1)?.do === 'focus') steps.pop()
  return { steps, notes }
}

/** A step in plain words, for the owner and for the brain carrying it out. */
export function stepText(s) {
  switch (s.do) {
    case 'open': return `Open ${s.app}`
    case 'focus': return `Go to ${s.app}${s.window ? ` ("${s.window}")` : ''}`
    case 'click': return `Click "${s.name}"${s.type ? ` (${s.type.toLowerCase()})` : ''}`
    case 'type': return `Type "${s.text}"`
    case 'keys': return `Press ${s.keys}`
    case 'say': return `Tell the owner: ${s.text}`
    default: return JSON.stringify(s)
  }
}

export class SkillError extends Error {}

/** Every {placeholder} in a skill's steps. */
const placeholders = (steps) => new Set([...JSON.stringify(steps).matchAll(PLACEHOLDER)].map((m) => m[1]))

export function validate(skill) {
  if (!NAME.test(skill.name ?? '')) throw new SkillError("Skill names use lowercase letters, digits and dashes, e.g. 'monthly-report'")
  if (!Array.isArray(skill.steps) || !skill.steps.length) throw new SkillError('A skill needs at least one step')
  for (const [i, s] of skill.steps.entries()) {
    if (!STEP_KINDS.includes(s?.do)) throw new SkillError(`Step ${i + 1}: "${s?.do}" isn't a step (use ${STEP_KINDS.join(', ')})`)
  }
  const unknown = [...placeholders(skill.steps)].filter((p) => !(skill.params ?? []).includes(p))
  if (unknown.length) throw new SkillError(`Placeholders without a matching param: ${unknown.join(', ')}`)
}

/** The steps with {placeholders} filled from this run's values. */
export function fill(skill, values = {}) {
  const missing = (skill.params ?? []).filter((p) => values[p] == null || values[p] === '')
  if (missing.length) throw new SkillError(`"${skill.name}" needs: ${missing.join(', ')}`)
  const sub = (v) => (typeof v === 'string' ? v.replace(PLACEHOLDER, (m, k) => (values[k] != null ? String(values[k]) : m)) : v)
  return skill.steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, sub(v)])))
}

export function toMarkdown(skill) {
  const front = [
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description ?? '')}`,
    `params: ${JSON.stringify(skill.params ?? [])}`,
    `source: ${skill.source ?? 'task'}`,
    `created: ${new Date(skill.created ?? Date.now()).toISOString()}`,
  ].join('\n')
  const lines = skill.steps.map((s, i) => `${i + 1}. ${stepText(s)}`)
  return `---\n${front}\n---\n# ${skill.name}\n\n${skill.description ?? ''}\n\n## Steps\n\n${lines.join('\n')}\n\n` +
    `\`\`\`json\n${JSON.stringify({ steps: skill.steps }, null, 2)}\n\`\`\`\n`
}

export function fromMarkdown(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) throw new SkillError('No front matter')
  const meta = Object.fromEntries(m[1].split(/\r?\n/).map((l) => {
    const i = l.indexOf(':')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }))
  const parse = (v, d) => {
    try {
      return JSON.parse(v)
    } catch {
      return v ?? d
    }
  }
  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(text)
  return {
    name: meta.name,
    description: parse(meta.description, ''),
    params: parse(meta.params, []),
    source: meta.source ?? 'task',
    created: Date.parse(meta.created) || 0,
    steps: json ? JSON.parse(json[1]).steps : [],
  }
}

export function createSkillStore(root = SKILLS_DIR) {
  const file = (name) => {
    if (!NAME.test(String(name))) throw new SkillError(`No skill called "${name}"`)
    return join(root, name, 'SKILL.md')
  }
  return {
    root,
    save(skill) {
      validate(skill)
      const f = file(skill.name)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, toMarkdown(skill))
      return f
    },
    get(name) {
      const f = file(name)
      return existsSync(f) ? fromMarkdown(readFileSync(f, 'utf8')) : null
    },
    all() {
      if (!existsSync(root)) return []
      return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
        try {
          return [fromMarkdown(readFileSync(join(root, d.name, 'SKILL.md'), 'utf8'))]
        } catch {
          return [] // a hand-edited file that no longer parses is skipped, not fatal
        }
      })
    },
    delete(name) {
      const f = file(name)
      if (!existsSync(f)) return false
      rmSync(dirname(f), { recursive: true, force: true })
      return true
    },
  }
}

/** The owner saying the demonstration is over. */
export const DONE = /^\W*(?:(?:ok(?:ay)?|alright|right)\W+)?(?:done|i'?m done|that'?s it|that'?s all|finished|stop watching|all done)\b/i

const summary = (s) => `${s.name}: ${s.description}${s.params?.length ? ` (needs: ${s.params.join(', ')})` : ''}`

/** Starts teach.ps1; resolves once it is listening. stop() resolves the recorded events. */
export function startRecorder() {
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true })
  const events = []
  let buf = ''
  let ready
  const isReady = new Promise((resolve, reject) => {
    ready = resolve
    ps.on('error', reject)
    ps.on('close', (code) => reject(new Error(`the recorder stopped (exit ${code})`)))
  })
  ps.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev.kind === 'ready') ready()
        else if (ev.kind !== 'end') events.push(ev)
      } catch {
        /* not a line of ours */
      }
    }
  })
  const closed = new Promise((r) => ps.on('close', r))
  return {
    ready: isReady,
    async stop() {
      try {
        ps.stdin.write('stop\n')
      } catch {
        /* already gone */
      }
      const timer = setTimeout(() => ps.kill(), 8000)
      await closed
      clearTimeout(timer)
      return events
    },
  }
}

/**
 * The teach tools (server ayra_teach).
 * @param {{ store?: ReturnType<typeof createSkillStore>, record?: typeof startRecorder }} deps
 */
export function teachServer({ store = createSkillStore(), record = startRecorder } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  let recorder = null
  // While watching, "done" (or "that's it") means teach_stop: held for the tool like any action.
  ACTION_HINTS.push((request) => Boolean(recorder) && DONE.test(request))
  const step = z.object({
    do: z.enum(STEP_KINDS),
    app: z.string().optional(), window: z.string().optional(), name: z.string().optional(),
    type: z.string().optional(), text: z.string().optional(), keys: z.string().optional(),
  })

  const runSkill = tool('run_skill',
    'Run a saved skill the owner taught you, with values for its params. Then carry out the steps it returns.',
    { name: z.string(), params: z.record(z.string(), z.string()).optional().describe('e.g. {"month": "March"}') },
    async ({ name, params = {} }) => {
      const skill = store.get(name)
      if (!skill) return fail(`There's no skill called "${name}". Saved: ${store.all().map((s) => s.name).join(', ') || 'none'}.`)
      try {
        validate(skill) // the file may have been edited by hand
        const steps = fill(skill, params)
        return text(`Do these steps now, in order, with your tools (apps_open, apps_focus, apps_read, then apps_click by the ` +
          `name shown, apps_type, apps_press). Read the window before clicking. If a step can't be done, stop and say ` +
          `which one.\n${steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join('\n')}`)
      } catch (err) {
        return fail(err.message)
      }
    })
  // The saved skills are named in run_skill's own description, read afresh for every conversation.
  Object.defineProperty(runSkill, 'description', {
    get() {
      const all = store.all()
      return 'Run a saved skill the owner taught you, with values for its params, then carry out the steps it returns.' +
        (all.length ? ` Saved skills: ${all.slice(0, 30).map(summary).join('; ')}.` : ' No skills are saved yet.')
    },
  })

  return createSdkMcpServer({
    name: 'gnosis_teach',
    tools: [
      tool('teach_start',
        'Start watching the owner do a task on the laptop ("watch me", "learn this", "let me show you"). Their clicks and ' +
          'typing are recorded until teach_stop; password fields are never recorded.',
        {},
        async () => {
          if (process.platform !== 'win32') return fail('Teach mode records Windows apps, so it only runs on Windows.')
          if (recorder) return text("I'm already watching. Say \"done\" when you've finished.")
          const r = record()
          try {
            await r.ready
          } catch (err) {
            return fail(`The recorder didn't start: ${err?.message ?? err}`)
          }
          recorder = r
          return text("Watching. Do the task once, then say \"done\".")
        }),
      tool('teach_stop',
        'Stop watching ("done", "that\'s it") and get the steps. Then read them to the owner in a sentence or two, ask ' +
          'which values change each time, and save_skill with those as {placeholders} and params.',
        {},
        async () => {
          const r = recorder
          recorder = null
          if (!r) return fail("I wasn't watching. Say \"watch me\" first.")
          const { steps, notes } = stepsFromTrace(await r.stop())
          if (!steps.length) return fail(`I didn't see any steps${notes.length ? ` (${notes.join('; ')})` : ''}.`)
          return text(`Recorded ${steps.length} steps:\n${steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join('\n')}` +
            `${notes.length ? `\nLeft out: ${notes.join('; ')}` : ''}\nAs JSON for save_skill: ${JSON.stringify(steps)}`)
        }),
      tool('save_skill',
        'Save a skill: a lowercase-with-dashes name, what it does, the params, and the steps (from teach_stop, or the ' +
          'steps you just carried out for "save that as a skill") with {param} placeholders where values change, e.g. ' +
          '{"do":"type","text":"Report for {month}"}. The owner approves it first.',
        {
          name: z.string(), description: z.string(), params: z.array(z.string()).optional(),
          steps: z.array(step).min(1), source: z.enum(['taught', 'task']).optional(),
        },
        async ({ name, description, params = [], steps, source = 'task' }) => {
          try {
            const f = store.save({ name, description, params, steps, source, created: Date.now() })
            return text(`Saved the skill "${name}" (${steps.length} steps) in ${f}.`)
          } catch (err) {
            return fail(err.message)
          }
        }),
      runSkill,
      tool('list_skills', 'List the skills the owner has taught you.', {}, async () => {
        const all = store.all()
        return text(all.length ? all.map(summary).join('\n') : 'No skills saved yet.')
      }),
      tool('delete_skill', 'Delete a saved skill. The owner approves it first.', { name: z.string() }, async ({ name }) => {
        try {
          return store.delete(name) ? text(`Deleted the skill "${name}".`) : fail(`There's no skill called "${name}".`)
        } catch (err) {
          return fail(err.message)
        }
      }),
    ],
  })
}

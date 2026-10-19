/**
 * Background jobs — a task done start to finish on its own (PLAN.md 6.2).
 *
 * The owner, 2026-10-05: "if I say go to the x website and do some task and
 * open y website and do some task… it has to just perform it." A job is its own
 * conversation with the brain, so the HUD and Telegram stay free while it
 * works. One at a time.
 *
 * It has a budget — 30 minutes and 60 tool steps — because the owner's Claude
 * Pro limits are shared with their own use (CLAUDE.md, Terms); past it the job
 * is stopped and says how far it got. The owner hears on Telegram when it
 * starts, every few minutes while it runs, and when it ends — with a picture of
 * where it finished when the job took one. The ask-first list applies exactly
 * as everywhere else, and the kill switch stops it.
 *
 * The `ayra_jobs` tool server lets a conversation start one, ask how it is
 * going, and stop it. A job's own conversation is not given it: no jobs
 * inside jobs.
 */

import { createSdkMcpServer, tool } from './sdk.mjs'
import { z } from 'zod'
import { rankQuery } from './triage.mjs'

export const JOB_LIMITS = { minutes: 30, steps: 60 }
const PROGRESS_MS = 3 * 60_000

/** What the job's own conversation is told to do. */
export const jobBrief = (task) =>
  `[Background job — the owner is not watching; report at the end]\n` +
  `Do this from start to finish on your own: ${task}\n\n` +
  'Work through it step by step with your tools. Do not stop to ask the owner questions in words — ' +
  'make sensible choices; the actions that need their yes ask by themselves. If something blocks you ' +
  '(a sign-in you cannot do, a captcha, a no from the owner), stop and say what blocked you. When you ' +
  'are done, if the result is something to see on a website or in an app, take one screenshot of it ' +
  'with toOwner set (browser_screenshot or apps_screenshot), then reply with a short report: what you ' +
  'did, the result, and anything left for the owner.'

const minutesSince = (from, to) => Math.max(1, Math.round((to - from) / 60_000))
/** A task in a heading: the model writes jobs out in full, and a phone screen is small. */
const short = (task, max = 90) => (task.length > max ? `${task.slice(0, max - 1).trimEnd()}…` : task)
const toolName = (name) => String(name ?? '').replace(/^mcp__ayra_\w+?__/, '').replace(/_/g, ' ')

/** The line the owner gets when a job ends. */
export function report(job) {
  const head = {
    done: '✅ Job done',
    budget: '⏹️ Job stopped at its limit',
    stopped: '⏹️ Job stopped',
    error: '⚠️ Job failed',
  }[job.outcome] ?? 'Job ended'
  return `${head}: ${short(job.task)}\n(${job.minutes} min, ${job.steps} steps)\n\n${job.text || '(no report)'}`
}

/**
 * @param {{ open: (handlers: { emit: Function, onEnd: Function }) => { ask: Function, interrupt: Function, close: Function },
 *           tell: (text: string) => void, limits?: { minutes: number, steps: number },
 *           progressMs?: number, now?: () => number, audit?: { log: Function },
 *           store?: { get: Function, set: Function }, onFinish?: (job: object) => void }} options
 *   open     — a fresh conversation for the job (server.mjs: the brain with her hands, no jobs server)
 *   tell     — a note to the owner (Telegram)
 *   store    — remembers the running job across a restart, so one cut off is reported
 *   onFinish — after a job ends (server.mjs: its waiting Approve asks are declined)
 */
export function createJobs({ open, tell, limits = JOB_LIMITS, progressMs = PROGRESS_MS, now = Date.now, audit, store, onFinish }) {
  let current = null
  const finished = []
  let seq = 0

  // A job that was running when the bridge stopped: say so, once.
  const cut = store?.get('job')
  if (cut?.task) {
    tell(`⚠️ A background job was cut off when I restarted: ${short(cut.task)}\n(it had run ${minutesSince(cut.started, now())} min). Ask again if you still want it.`)
    store.set('job', null)
  }

  const finish = (job, outcome, text) => {
    if (current !== job) return
    current = null
    clearTimeout(job.timer)
    clearInterval(job.progress)
    const done = {
      id: job.id,
      task: job.task,
      outcome,
      steps: job.steps,
      minutes: minutesSince(job.started, now()),
      text: String(text ?? '').trim(),
    }
    finished.unshift(done)
    finished.length = Math.min(finished.length, 5)
    store?.set('job', null)
    onFinish?.(done)
    audit?.log({ type: 'job', id: job.id, outcome, steps: job.steps })
    console.log(`[gnosis] job ${job.id} ${outcome} after ${job.steps} steps`)
    tell(report(done))
    // Let the last answer land before the conversation goes.
    setTimeout(() => job.conversation.close(), 1000).unref?.()
  }

  const stop = (by = 'owner') => {
    const job = current
    if (!job) return false
    job.conversation.interrupt()
    finish(job, 'stopped', `Stopped by ${by} after: ${toolName(job.last) || 'nothing yet'}.`)
    return true
  }

  return {
    /** Start a job; refused while another is running. */
    start(task) {
      const what = String(task ?? '').trim()
      if (!what) return { ok: false, reason: 'Say what the job should do.' }
      if (current) return { ok: false, reason: `A job is already running: "${current.task}". One at a time — wait for it, or stop it.` }
      const job = { id: `job${++seq}`, task: what, started: now(), steps: 0, last: '', text: '' }
      job.conversation = open({
        emit: (e) => {
          if (e.ask !== job.id || current !== job) return
          if (e.type === 'tool') {
            job.steps++
            job.last = e.name
            if (job.steps > limits.steps) {
              job.conversation.interrupt()
              finish(job, 'budget', `Stopped after ${limits.steps} steps, the job's limit. Last: ${toolName(job.last)}.${job.text ? `\n\n${job.text}` : ''}`)
            }
          }
          if (e.type === 'text') job.text += e.delta
          if (e.type === 'done') finish(job, 'done', e.text || job.text)
          // Whatever it managed to say still reaches the owner.
          if (e.type === 'error') finish(job, 'error', `${e.message}${job.text ? `\n\nSo far: ${job.text.trim()}` : ''}`)
        },
        onEnd: () => finish(job, 'error', 'The job lost its connection to the brain.'),
      })
      job.timer = setTimeout(() => {
        job.conversation.interrupt()
        finish(job, 'budget', `Stopped after ${limits.minutes} minutes, the job's limit. Last: ${toolName(job.last) || 'nothing'}.`)
      }, limits.minutes * 60_000)
      job.timer.unref?.()
      job.progress = setInterval(() => {
        tell(`⏳ Still on it: ${short(job.task)}\n(${minutesSince(job.started, now())} min, ${job.steps} steps; now: ${toolName(job.last) || 'thinking'})`)
      }, progressMs)
      job.progress.unref?.()
      current = job
      store?.set('job', { task: what, started: job.started })
      audit?.log({ type: 'job', id: job.id, outcome: 'started' })
      tell(`🛠️ Started a background job: ${short(what, 300)}\nI'll report back here — /jobs to check, /stop to stop it.`)
      // Ranked on the task, not the brief: the brief's own long instructions
      // would say nothing about how deep the task itself goes.
      job.conversation.ask(jobBrief(what), job.id, { rank: rankQuery(what), text: what })
      return { ok: true, id: job.id }
    },

    /** How it is going, in a sentence or two. */
    status() {
      if (current) {
        return `Running: "${short(current.task)}" — ${minutesSince(current.started, now())} min, ${current.steps} steps; now: ${toolName(current.last) || 'thinking'}.`
      }
      const last = finished[0]
      return last
        ? `No job running. The last one (${last.outcome}): "${short(last.task)}".${last.text ? `\n\n${last.text}` : ''}`
        : 'No job running, and none yet today.'
    },

    stop,
    /** The kill switch (server.mjs CONVERSATIONS). */
    interrupt: () => stop('the kill switch'),
    running: () => (current ? { id: current.id, task: current.task, steps: current.steps } : null),
  }
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/**
 * The tools, for jobsServer — and for tests.
 * `reportsTo`: where the owner hears how a job went ('Telegram'), or null when
 * nothing can reach them — then the report waits for jobs_status.
 */
export function jobsTools({ jobs, allowWrites, reportsTo = 'Telegram' }) {
  const reading = [
    tool('jobs_status', 'How the background job is going, or how the last one ended.', {}, async () => text(jobs.status())),
    tool('jobs_stop', 'Stop the background job now, when the owner asks.', {}, async () =>
      text(jobs.stop('the owner') ? 'Stopped it.' : 'No job is running.'),
    ),
  ]
  const acting = [
    tool(
      'jobs_start',
      'Run a long task in the background as its own job — several sites or steps, done start to finish while the owner carries on. Use it when they say "in the background", or for anything that will take more than a couple of minutes. One at a time, at most 30 minutes and 60 steps; the owner hears on Telegram when it starts, how it goes and how it ends. Write the task fully: the job does not see this conversation.',
      { task: z.string().describe('The whole task, with every detail the job needs — it starts fresh') },
      async ({ task }) => {
        const r = jobs.start(task)
        if (!r.ok) return text(r.reason)
        return text(
          reportsTo
            ? `Started. The owner will hear on ${reportsTo} how it goes — tell them in one sentence.`
            : 'Started. The report will be here when it ends: tell the owner to ask you how the job went.',
        )
      },
    ),
  ]
  return allowWrites ? [...reading, ...acting] : reading
}

export const jobsServer = (options) =>
  createSdkMcpServer({
    name: 'ayra_jobs',
    version: '1.0.0',
    instructions: 'Background jobs: long tasks done start to finish on their own, one at a time.',
    alwaysLoad: true,
    tools: jobsTools(options),
  })

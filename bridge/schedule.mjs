/**
 * Reminders, routines, the morning briefing, do-not-disturb and the laptop watchers — ported from
 * Gnosis v1 (gnosis/scheduler.py, gnosis/proactive.py, skills/scheduler_tools.py).
 *
 *   jobs      — reminders (a message at a time), routines (a request Gnosis carries out by himself at a
 *               time, the answer sent as a notice) and the daily briefing. Once or repeating: daily,
 *               weekdays, weekly, hourly or every N minutes, at the same time of day. data/schedule.json.
 *   notifier  — how a notice reaches the owner: a Windows notification and/or Gnosis saying it aloud
 *               in his window, or held for the next briefing. Urgent always gets through; otherwise
 *               do-not-disturb, quiet hours (23:00-07:00) and a full-screen app or Focus keep it quiet,
 *               and ordinary notices are capped at four an hour.
 *   watchers  — battery low (20 %, then 10 %) while unplugged, and disk almost full.
 *
 * Times are the laptop's local time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from './sdk.mjs'
import { dataPath } from './paths.mjs'

export const SCHEDULE_FILE = dataPath('schedule.json')
export const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'hourly', 'minutes']

// ---- times ------------------------------------------------------------------------------

/**
 * When a job should run: `inMinutes` from now, or `at` — "HH:MM" (the next time that comes round) or a
 * local date-time like "2026-10-19T09:00".
 */
export function parseWhen(at, inMinutes, now = Date.now()) {
  if (inMinutes != null) {
    const m = Number(inMinutes)
    if (!(m > 0)) throw new Error('in_minutes must be more than 0')
    return now + m * 60_000
  }
  if (!at || !String(at).trim()) throw new Error("Say when: 'at' (e.g. 09:00 or 2026-10-19T09:00) or 'in_minutes'")
  const s = String(at).trim()
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s)
  if (clock) {
    let h = Number(clock[1]) % 24
    if (clock[4]) h = (h % 12) + (clock[4].toLowerCase() === 'pm' ? 12 : 0)
    const t = new Date(now)
    t.setHours(h, Number(clock[2]), Number(clock[3] ?? 0), 0)
    if (t.getTime() <= now) t.setDate(t.getDate() + 1)
    return t.getTime()
  }
  const t = Date.parse(s.replace(' ', 'T'))
  if (Number.isNaN(t)) throw new Error(`I couldn't read the time "${s}"`)
  return t
}

/** The next run of a repeating job after `now`, at the same time of day; null for a one-off. */
export function nextAfter(job, now = Date.now()) {
  if (job.repeat === 'once') return null
  const t = new Date(job.next)
  const step = (d) => {
    if (job.repeat === 'hourly') d.setHours(d.getHours() + 1)
    else if (job.repeat === 'minutes') d.setMinutes(d.getMinutes() + Math.max(1, job.every || 1))
    else if (job.repeat === 'weekly') d.setDate(d.getDate() + 7)
    else d.setDate(d.getDate() + 1)
  }
  do step(t)
  while (t.getTime() <= now || (job.repeat === 'weekdays' && (t.getDay() === 0 || t.getDay() === 6)))
  return t.getTime()
}

export const whenText = (ms) =>
  new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

// ---- the job store ---------------------------------------------------------------------

export function createJobStore(file = SCHEDULE_FILE) {
  const load = () => {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      return { jobs: Array.isArray(d.jobs) ? d.jobs : [], next: d.next ?? 1 }
    } catch {
      return { jobs: [], next: 1 }
    }
  }
  const save = (d) => {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  return {
    add({ kind, text, next, repeat = 'once', every = 0, key = null }) {
      if (!REPEATS.includes(repeat)) throw new Error(`repeat must be one of ${REPEATS.join(', ')}`)
      const d = load()
      if (key) d.jobs = d.jobs.filter((j) => j.key !== key) // one briefing, replaced when its time changes
      const job = { id: d.next++, kind, text: String(text), next, repeat, every: Number(every) || 0, key, created: Date.now() }
      d.jobs.push(job)
      save(d)
      return job
    },
    upcoming: () => load().jobs.sort((a, b) => a.next - b.next),
    due: (now = Date.now()) => load().jobs.filter((j) => j.next <= now),
    /** A job ran: repeating ones move on, one-offs go. */
    fired(id, now = Date.now()) {
      const d = load()
      const job = d.jobs.find((j) => j.id === id)
      if (!job) return
      const next = nextAfter(job, now)
      if (next == null) d.jobs = d.jobs.filter((j) => j.id !== id)
      else job.next = next
      save(d)
    },
    cancel(id) {
      const d = load()
      const before = d.jobs.length
      d.jobs = d.jobs.filter((j) => j.id !== Number(id))
      if (d.jobs.length === before) return false
      save(d)
      return true
    },
    /** A job by id, or by words from it ("the stretch reminder"). */
    find(which) {
      const jobs = load().jobs
      const n = Number(String(which).replace(/^#/, ''))
      if (Number.isInteger(n)) return jobs.find((j) => j.id === n) ?? null
      const w = String(which).toLowerCase().split(/\W+/).filter((x) => x.length > 2 && !['the', 'reminder', 'routine', 'cancel'].includes(x))
      const scored = jobs.map((j) => ({ j, s: w.filter((x) => j.text.toLowerCase().includes(x)).length })).filter((x) => x.s)
      return scored.sort((a, b) => b.s - a.s)[0]?.j ?? null
    },
  }
}

export const jobText = (j) =>
  `#${j.id} ${j.kind}: "${j.text}" — ${whenText(j.next)}${j.repeat === 'once' ? '' : `, ${j.repeat === 'minutes' ? `every ${j.every} min` : j.repeat}`}`

// ---- the notifier ------------------------------------------------------------------------

/** True if `now` is inside "HH:MM-HH:MM" (which may cross midnight). */
export function inWindow(window, now = new Date()) {
  if (!window) return false
  const [a, b] = window.split('-').map((s) => s.trim().split(':').map(Number))
  const t = now.getHours() * 60 + now.getMinutes()
  const start = a[0] * 60 + a[1]
  const end = b[0] * 60 + b[1]
  return start <= end ? t >= start && t < end : t >= start || t < end
}

/** A Windows notification from "Gnosis" (the tray app's id), falling back to PowerShell's own. */
export function windowsToast(title, body) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const script = (appId) =>
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;' +
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);' +
    "$x = $t.GetElementsByTagName('text');" +
    '$x.Item(0).AppendChild($t.CreateTextNode($env:GNOSIS_TOAST_TITLE)) > $null;' +
    '$x.Item(1).AppendChild($t.CreateTextNode($env:GNOSIS_TOAST_BODY)) > $null;' +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`
  const run = (appId) => new Promise((done) => {
    // The text goes in through the environment, so nothing in it can run as a command.
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script(appId)], {
      windowsHide: true, env: { ...process.env, GNOSIS_TOAST_TITLE: String(title).slice(0, 120), GNOSIS_TOAST_BODY: String(body).slice(0, 400) },
    })
    p.on('error', () => done(false))
    p.on('close', (code) => done(code === 0))
  })
  return run('Gnosis.Desk').then((ok) => ok || run('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'))
}

/**
 * @param {{ toast?: (title: string, body: string) => Promise<boolean>, speak?: (text: string) => boolean,
 *           phone?: (text: string) => void, quietHours?: string, maxPerHour?: number, busy?: () => boolean,
 *           now?: () => number, log?: (entry: object) => void }} options
 *   speak — says it in Gnosis's window; false when no window is open
 */
export function createNotifier({ toast = windowsToast, speak = () => false, phone = null, quietHours = '23:00-07:00',
  maxPerHour = 4, busy = () => false, now = Date.now, log = () => {} } = {}) {
  let dndUntil = 0
  let recent = []
  const pending = []
  return {
    get dndUntil() { return dndUntil },
    doNotDisturb(minutes) {
      dndUntil = minutes > 0 ? now() + minutes * 60_000 : 0
      return dndUntil
    },
    /** The channels for a notice: [] means held for the next briefing. */
    decide(urgency) {
      const t = now()
      let quiet = t < dndUntil || inWindow(quietHours, new Date(t))
      try {
        quiet ||= busy()
      } catch { /* can't tell: not busy */ }
      if (urgency === 'urgent') return ['toast', 'speak']
      if (urgency === 'low') return []
      if (urgency === 'high') return quiet ? ['toast'] : ['toast', 'speak']
      recent = recent.filter((r) => t - r < 3_600_000)
      if (quiet || recent.length >= maxPerHour) return []
      return ['toast']
    },
    async notify({ title, body, urgency = 'normal', source = 'gnosis' }) {
      const channels = this.decide(urgency)
      if (!channels.length) pending.push({ title, body, at: now() })
      else if (urgency === 'normal') recent.push(now())
      const spoken = channels.includes('speak') && speak(body)
      if (channels.includes('toast')) await toast(title, body).catch(() => false)
      if (channels.length && phone) phone(`${title}: ${body}`)
      log({ type: 'notice', title, urgency, source, channels: channels.length ? channels : ['held'], spoken })
      return channels
    },
    /** What was held back, for the briefing (taken once). */
    takePending: () => pending.splice(0),
  }
}

// ---- watchers ------------------------------------------------------------------------------

export async function batteryState() {
  if (process.platform !== 'win32') return null
  return new Promise((done) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining) $($b.BatteryStatus)" }'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => done(null))
    p.on('close', () => {
      const [pct, status] = out.trim().split(/\s+/).map(Number)
      // BatteryStatus 2 = on mains (6-9 charging).
      done(Number.isFinite(pct) ? { percent: pct, plugged: [2, 3, 6, 7, 8, 9].includes(status) } : null)
    })
  })
}

export function diskFreePercent(drive = process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/') {
  const s = statfsSync(drive)
  return (s.bavail * 100) / s.blocks
}

export function createWatchers({ notifier, battery = batteryState, disk = diskFreePercent, now = Date.now, memo = null } = {}) {
  let batteryLevel = 0 // 0 fine, 1 warned at 20 %, 2 warned at 10 %
  // Remembered across restarts (memo: data/state.json), so a restart doesn't warn about the disk again.
  let diskWarnedDay = memo?.get('diskWarnedDay') ?? null
  const state = { battery: null, diskFreePercent: null }
  return {
    state,
    async check() {
      const b = await battery()
      if (b) {
        state.battery = b
        if (b.plugged || b.percent > 25) batteryLevel = 0
        else if (b.percent <= 10 && batteryLevel < 2) {
          batteryLevel = 2
          await notifier.notify({ title: 'Battery very low', body: `Battery is at ${b.percent} percent. Plug in now.`, urgency: 'urgent', source: 'battery' })
        } else if (b.percent <= 20 && batteryLevel < 1) {
          batteryLevel = 1
          await notifier.notify({ title: 'Battery low', body: `Battery is at ${b.percent} percent. Plug in soon.`, urgency: 'high', source: 'battery' })
        }
      }
      try {
        const free = disk()
        state.diskFreePercent = Math.round(free * 10) / 10
        const day = new Date(now()).toDateString()
        if (free < 10 && diskWarnedDay !== day) {
          diskWarnedDay = day
          memo?.set('diskWarnedDay', day)
          await notifier.notify({ title: 'Disk almost full', body: `Only ${Math.round(free)} percent of your disk is free. Want me to find big files you could delete?`, source: 'disk' })
        }
      } catch { /* no disk reading */ }
    },
  }
}

// ---- running it ------------------------------------------------------------------------------

/**
 * Runs the jobs and watchers. `runRequest(text)` carries out a routine or the briefing as a request
 * from the owner and resolves with the answer.
 */
export function startSchedule({ store, notifier, watchers, runRequest, every = 15_000, watchEvery = 60_000, now = Date.now }) {
  const fire = async (job) => {
    const late = now() - job.next > 120_000
    store.fired(job.id, now())
    if (job.kind === 'reminder') {
      const body = late ? `${job.text} (This was due at ${whenText(job.next)}, while I wasn't running.)` : job.text
      return notifier.notify({ title: 'Reminder', body, urgency: 'high', source: 'reminder' })
    }
    // In the background: a routine can take minutes, and a reminder due meanwhile mustn't wait for it.
    void (async () => {
      let answer
      try {
        answer = await runRequest(job.text)
      } catch (err) {
        answer = `I couldn't finish "${job.text}": ${err?.message ?? err}`
      }
      await notifier.notify({ title: job.kind === 'briefing' ? 'Your briefing' : 'Routine finished', body: answer, urgency: 'high', source: job.kind })
    })().catch((err) => console.warn(`[gnosis] a ${job.kind} failed: ${err?.message ?? err}`))
  }
  // One check at a time: two overlapping ones (a slow routine still running at the next tick) would
  // both see the same job as due and fire it twice.
  //
  // Cleared in .finally, which runs after the assignment: clearing it inside the async body was too
  // early when nothing was due (the body finished before `ticking` was set, which then stuck for ever
  // and no reminder fired again — found on the laptop, 2026-10-18).
  let ticking = null
  const tick = () => {
    if (ticking) return ticking
    ticking = (async () => {
      for (const job of store.due(now())) {
        try {
          await fire(job)
        } catch (err) {
          console.warn(`[gnosis] a scheduled ${job.kind} failed: ${err?.message ?? err}`)
        }
      }
    })().finally(() => {
      ticking = null
    })
    return ticking
  }
  const timer = setInterval(() => void tick(), every)
  const watch = setInterval(() => void watchers?.check().catch(() => {}), watchEvery)
  timer.unref?.()
  watch.unref?.()
  void tick()
  void watchers?.check().catch(() => {})
  return { tick, stop: () => { clearInterval(timer); clearInterval(watch) } }
}

/** Sets (or removes) the daily briefing at "HH:MM". */
export function setBriefing(store, at) {
  for (const j of store.upcoming()) if (j.key === 'morning-briefing') store.cancel(j.id)
  if (!at) return null
  return store.add({ kind: 'briefing', text: 'Give me my morning briefing.', next: parseWhen(at), repeat: 'daily', key: 'morning-briefing' })
}

// ---- tools ------------------------------------------------------------------------------------

const WHEN = {
  at: z.string().optional().describe('When: "HH:MM" for the next time that comes round, or a local date-time like 2026-10-19T09:00'),
  in_minutes: z.number().optional().describe('Or this many minutes from now'),
  repeat: z.enum(REPEATS).optional().describe('once (default), daily, weekdays, weekly, hourly, or minutes (with every_minutes)'),
  every_minutes: z.number().int().optional(),
}

export function scheduleServer(deps) {
  const { store, setBriefingAt = (at) => setBriefing(store, at) } = deps
  // Read on each call: the bridge creates the notifier and watchers after the brain.
  const live = () => ({ notifier: deps.notifier, watchers: deps.watchers })
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const add = (kind, what, { at, in_minutes, repeat = 'once', every_minutes = 0 }) => {
    try {
      const next = parseWhen(at, in_minutes)
      if (next <= Date.now()) return text('That time has already passed.')
      return text(`Scheduled ${jobText(store.add({ kind, text: what, next, repeat, every: every_minutes }))}.`)
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] }
    }
  }
  return createSdkMcpServer({
    name: 'ayra_schedule',
    tools: [
      tool('set_reminder', 'Remind the owner of something at a time, once or repeating. It pops up as a Windows notification and Gnosis says it.',
        { text: z.string().describe('What to remind them of'), ...WHEN }, async ({ text: what, ...when }) => add('reminder', what, when)),
      tool('schedule_routine',
        'Have Gnosis do a task by himself later or on a schedule, e.g. "every weekday at 9 tell me the weather". ' +
          'The goal runs like a normal request and the answer arrives as a notification.',
        { goal: z.string(), ...WHEN }, async ({ goal, ...when }) => add('routine', goal, when)),
      tool('list_reminders', 'List upcoming reminders, routines and the daily briefing.', {}, async () => {
        const jobs = store.upcoming()
        return text(jobs.length ? jobs.map(jobText).join('\n') : 'Nothing scheduled.')
      }),
      tool('cancel_reminder', 'Cancel a reminder or routine by its id or by words from it.', { which: z.string() }, async ({ which }) => {
        const job = store.find(which)
        if (!job) return { isError: true, content: [{ type: 'text', text: `No reminder matches "${which}".` }] }
        store.cancel(job.id)
        return text(`Cancelled ${jobText(job)}.`)
      }),
      tool('do_not_disturb',
        'Stop Gnosis interrupting for a while: only urgent things get through, the rest waits for the next briefing. minutes = 0 turns it off.',
        { minutes: z.number() }, async ({ minutes }) => {
          const until = live().notifier.doNotDisturb(minutes)
          return text(until ? `Do not disturb until ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : 'Do not disturb is off.')
        }),
      tool('morning_briefing_time', 'Set the time of the daily morning briefing ("HH:MM"), or "off".', { at: z.string() }, async ({ at }) => {
        const job = setBriefingAt(/^off$/i.test(at.trim()) ? null : at)
        return text(job ? `The briefing is now at ${new Date(job.next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} every day.` : 'The daily briefing is off.')
      }),
      tool('briefing',
        'What the owner should know right now: reminders coming up today, notices held back, battery and disk. Use for "good morning", "what did I miss?" or "brief me". Add the weather with a web search if they want it.',
        {}, async () => {
          const end = new Date()
          end.setHours(23, 59, 59, 999)
          const today = store.upcoming().filter((j) => j.next <= end.getTime() && j.kind !== 'briefing')
          const { notifier, watchers } = live()
          const held = notifier.takePending()
          const lines = [`Now: ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
            `Coming up today: ${today.length ? today.map(jobText).join('; ') : 'nothing scheduled'}`,
            `Held back while you were busy: ${held.length ? held.map((n) => `${n.title}: ${n.body}`).join('; ') : 'nothing'}`,
            `Battery: ${watchers?.state.battery ? `${watchers.state.battery.percent} percent${watchers.state.battery.plugged ? ', plugged in' : ''}` : 'unknown'}`,
            `Disk free: ${watchers?.state.diskFreePercent ?? 'unknown'} percent`]
          return text(lines.join('\n'))
        }),
    ],
  })
}

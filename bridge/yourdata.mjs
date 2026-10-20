/**
 * "Your data": everything Gnosis keeps about the owner, in one place they can see and clear (the
 * owner, 2026-10-20: "every data stored by the agent should be visible to the user in the stored
 * data area"). The window's Your data screen (src/ui/YourData.tsx) reads view() and sends act().
 *
 * What is kept, all in his data folder:
 *   facts          memory.json — what he was asked to remember
 *   history        memory.json — past exchanges, recalled when relevant
 *   private notes  private-memory.json — "private" sentences, never sent to the cloud; their words
 *                  are shown only when the owner asks to see them
 *   reminders      schedule.json — reminders, routines and the briefing
 *   skills         skills/ — what teach mode saved
 *   attachments    attachments/ — files and pictures given to him, a week at most
 *   voice print    voiceprint.json — voice ID (numbers, not a recording)
 *   devices        devices.json — paired phones (the key itself is never kept)
 *   settings       settings.json — what the Settings screen changed
 *   conversations  sessions/ — the running conversation, for continuing after a restart
 *   research       research/ — saved research runs
 *   logs           logs/ — what he did, day by day, and the app's console output
 *   app files      models/ (the voice model) and webview2/ (his window's own browser storage) —
 *                  not about the owner, but kept here too, so shown
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.mjs'

/** Total bytes and file count under a folder (or one file). */
export function sizeOf(path) {
  if (!existsSync(path)) return { bytes: 0, files: 0 }
  const st = statSync(path)
  if (!st.isDirectory()) return { bytes: st.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const f of readdirSync(path)) {
    const s = sizeOf(join(path, f))
    bytes += s.bytes
    files += s.files
  }
  return { bytes, files }
}

/**
 * @param {{ memory, privateMemory, schedule, skills, attachments, voice, devices?, readSettings, dir?: string,
 *           openFolder?: (path: string) => void }} deps
 */
export function createDataView({ memory, privateMemory, schedule, skills, attachments, voice, devices = null, readSettings,
  dir = DATA_DIR, openFolder = (p) => spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref() }) {
  const folder = (name) => ({ ...sizeOf(join(dir, name)), path: join(dir, name) })

  function view() {
    const facts = memory.facts(true).map((f) => ({ id: f.id, subject: f.subject, predicate: f.predicate, value: f.value,
      sensitive: Boolean(f.sensitive), at: f.updated ?? f.at ?? null }))
    const history = memory.episodes().slice().reverse().map((e) => ({ at: e.at, request: e.request, answer: e.answer }))
    const privateNotes = privateMemory.all().map((m) => ({ id: m.id, saved: m.saved, length: String(m.text).length }))
    const reminders = schedule.upcoming().map((j) => ({ id: j.id, kind: j.kind, text: j.text, next: j.next, repeat: j.repeat }))
    const skillList = skills.all().map((s) => ({ name: s.name, description: s.description, params: s.params, steps: s.steps.length, source: s.source }))
    const files = attachments.list().map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, at: a.at }))
    return {
      folder: dir,
      facts, history, privateNotes, reminders, skills: skillList, attachments: files,
      voice: voice.status(),
      devices: devices ? devices.list().map((d) => ({ id: d.id, name: d.name, model: d.model, paired: d.paired, online: d.online })) : [],
      settings: readSettings(),
      conversations: folder('sessions'),
      research: folder('research'),
      logs: folder('logs'),
      models: folder('models'),
      window: folder('webview2'),
      total: sizeOf(dir),
    }
  }

  /** One button on the Your data screen. Returns { ok, ... } or throws with a sentence. */
  function act({ what, id = null, at = null, name = null } = {}) {
    switch (what) {
      case 'forget_fact': return { ok: memory.forget(Number(id)) }
      case 'forget_all_facts': {
        for (const f of memory.facts(true)) memory.forget(f.id)
        return { ok: true }
      }
      case 'forget_exchange': return { ok: memory.forgetEpisodes(at) > 0 }
      case 'forget_history': return { ok: true, removed: memory.forgetEpisodes() }
      case 'show_private': return { ok: true, notes: privateMemory.all().map((m) => ({ id: m.id, text: m.text, saved: m.saved })) }
      case 'delete_private': return { ok: privateMemory.remove(Number(id)) }
      case 'cancel_reminder': return { ok: schedule.cancel(Number(id)) }
      case 'delete_skill': return { ok: skills.delete(String(name)) }
      case 'delete_attachment': return { ok: attachments.remove(String(id)) }
      case 'forget_voice': {
        voice.forget()
        return { ok: true }
      }
      case 'forget_device': return { ok: Boolean(devices?.forget(String(id))) }
      case 'clear_conversations': return clearFolder('sessions')
      case 'clear_research': return clearFolder('research')
      case 'open_folder': {
        openFolder(dir)
        return { ok: true }
      }
      default: throw new Error(`There's no "${what}" here.`)
    }
  }

  function clearFolder(name) {
    const p = join(dir, name)
    if (!existsSync(p)) return { ok: true, removed: 0 }
    let removed = 0
    for (const f of readdirSync(p)) {
      rmSync(join(p, f), { recursive: true, force: true })
      removed++
    }
    return { ok: true, removed }
  }

  return { view, act }
}

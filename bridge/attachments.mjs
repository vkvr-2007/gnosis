/**
 * Files and pictures the owner gives Gnosis (ported from Gnosis v1, item 8 of the owner's list):
 * dropped on his window or pasted into it, then asked about by voice.
 *
 * His window sends each one to the bridge (POST /attach), which keeps it in the data folder for a
 * week. The next question carries their ids, and the bridge puts them in front of the brain:
 *   text files  — read in whole (up to 20,000 characters) inside the question
 *   pictures    — described by the vision model with the question in mind, and look_at_attachment
 *                 for another look
 *   anything else (PDF, Word…) — named, with a plain note that he can't read that kind yet
 * Text read this way goes through the same privacy check as anything the owner says (sdk.mjs).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { dataDir } from './paths.mjs'
import { createSdkMcpServer, tool } from './sdk.mjs'
import { askVision } from './vision.mjs'

export const ATTACH_DIR = dataDir('attachments')
export const MAX_BYTES = 20 * 1024 * 1024
export const TEXT_LIMIT = 20_000
const KEEP_DAYS = 7

const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini', '.toml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go',
  '.rs', '.rb', '.php', '.sh', '.ps1', '.bat', '.sql', '.kt', '.swift', '.srt', '.vtt'])
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }

/** What kind of file a name is: 'text', 'image', or 'other'. */
export function kindOf(name, type = '') {
  const ext = extname(String(name)).toLowerCase()
  if (IMAGE[ext] || /^image\//.test(type)) return 'image'
  if (TEXT.has(ext) || /^text\//.test(type) || type === 'application/json') return 'text'
  return 'other'
}

/** A file name that is safe on disk and still recognisable. */
const safe = (name) => String(name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file'

export function createAttachments(dir = ATTACH_DIR) {
  const metaPath = (id) => join(dir, `${id}.json`)
  return {
    dir,
    /** Saves one; returns { id, name, kind, size }. */
    save({ name, type = '', bytes }) {
      if (!bytes?.length) throw new Error('That file is empty.')
      if (bytes.length > MAX_BYTES) throw new Error('That file is over 20 MB, too big to attach.')
      mkdirSync(dir, { recursive: true })
      const id = randomBytes(6).toString('hex')
      const clean = safe(name)
      const meta = { id, name: clean, kind: kindOf(clean, type), type: String(type).slice(0, 80), size: bytes.length, at: Date.now() }
      writeFileSync(join(dir, `${id}-${clean}`), bytes)
      writeFileSync(metaPath(id), JSON.stringify(meta))
      return { id, name: meta.name, kind: meta.kind, size: meta.size }
    },
    /** { ...meta, path } or null. */
    get(id) {
      if (!/^[0-9a-f]{12}$/.test(String(id))) return null
      try {
        const meta = JSON.parse(readFileSync(metaPath(id), 'utf8'))
        return { ...meta, path: join(dir, `${id}-${meta.name}`) }
      } catch {
        return null
      }
    },
    /** Attachments older than a week go. Returns how many. */
    cleanUp(now = Date.now()) {
      if (!existsSync(dir)) return 0
      let n = 0
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try {
          if (now - statSync(p).mtimeMs > KEEP_DAYS * 86_400_000) {
            rmSync(p, { force: true })
            if (f.endsWith('.json')) n++
          }
        } catch { /* already gone */ }
      }
      return n
    },
  }
}

/**
 * What the brain is told about the attachments of one question, put before the question itself.
 * @param {string[]} ids
 */
export async function attachmentNote(ids, question, { store, ask = askVision, signal } = {}) {
  const parts = []
  for (const id of ids.slice(0, 6)) {
    const a = store.get(id)
    if (!a) continue
    if (a.kind === 'text') {
      let body = readFileSync(a.path, 'utf8')
      const cut = body.length > TEXT_LIMIT
      if (cut) body = body.slice(0, TEXT_LIMIT)
      parts.push(`[The owner attached the file "${a.name}"${cut ? ` (only the first ${TEXT_LIMIT.toLocaleString('en')} characters are here)` : ''}:\n<<<\n${body}\n>>>]`)
    } else if (a.kind === 'image') {
      let seen
      try {
        const data = readFileSync(a.path).toString('base64')
        const mimeType = IMAGE[extname(a.name).toLowerCase()] ?? (a.type || 'image/jpeg')
        seen = await ask({ images: [{ data, mimeType }], maxTokens: 400, question:
          `The owner attached this picture and asks: "${question || 'what is this?'}". Describe what matters for that ` +
          'in at most 150 words, giving any words in it exactly.' }, { signal })
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        seen = null
      }
      parts.push(seen
        ? `[The owner attached the picture "${a.name}". What it shows: ${seen} (For another look, look_at_attachment with id "${a.id}".)]`
        : `[The owner attached the picture "${a.name}", but the vision model couldn't be reached to look at it. Say so.]`)
    } else {
      parts.push(`[The owner attached "${a.name}", a kind of file Gnosis can't read yet (only text files and pictures). Say so plainly.]`)
    }
  }
  return parts.length ? `${parts.join('\n')}\n` : ''
}

/** look_at_attachment: another look at an attached picture, for a follow-up question. */
export function attachmentServer({ store, ask = askVision } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  return createSdkMcpServer({
    name: 'gnosis_attachments',
    tools: [
      tool('look_at_attachment', 'Look again at a picture the owner attached, to answer a follow-up question about it.',
        { id: z.string(), question: z.string() },
        async ({ id, question }) => {
          const a = store.get(id)
          if (!a) return fail('That attachment is no longer here (they are kept for a week).')
          if (a.kind !== 'image') return fail('That attachment is not a picture.')
          const data = readFileSync(a.path).toString('base64')
          const mimeType = IMAGE[extname(a.name).toLowerCase()] ?? 'image/jpeg'
          return text(await ask({ images: [{ data, mimeType }], maxTokens: 400,
            question: `${question} Answer in at most 120 words, giving any words in the picture exactly.` }))
        }),
    ],
  })
}

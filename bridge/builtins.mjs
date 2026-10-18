/**
 * The built-in tools Claude Code used to provide, rebuilt for Gnosis's own brain.
 *
 * Same names and the same inputs as Claude Code's, on purpose: gate.mjs reviews
 * every call by these names and fields (a PowerShell `command`, a Write's
 * `file_path`), so the owner's ask-first rules keep working unchanged.
 *
 * Each tool: { description, schema (JSON Schema), run(input, { signal, cwd }) }
 * where run returns { text, isError?, structured? }.
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { webFetch, webSearch } from './web.mjs'

const OUTPUT_MAX = 30_000
const clip = (s, max = OUTPUT_MAX) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s)
const at = (path, cwd) => (isAbsolute(path) ? path : resolve(cwd, path))

function runShell(exe, args, { signal, timeoutMs = 120_000, cwd }) {
  return new Promise((done) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, signal })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ text: `Could not run it: ${err.message}`, isError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = clip(out.trim()) || '(no output)'
      done(code === 0 ? { text } : { text: `Exit code ${code}\n${text}`, isError: true })
    })
  })
}

/** Lines numbered from 1, like Claude Code's Read, so the model can point at them. */
function numbered(text, offset = 1, limit = 2000) {
  const lines = text.split(/\r?\n/)
  return lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join('\n')
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'AppData'])

async function* walk(dir, depth = 0) {
  if (depth > 8) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* walk(p, depth + 1)
    } else yield p
  }
}

export const BUILTINS = {
  PowerShell: {
    description: 'Run a PowerShell command on the laptop (Windows). Use for anything the other tools ' +
      "can't do: system settings, processes, files in bulk, installed apps.",
    schema: { type: 'object', properties: {
      command: { type: 'string' }, description: { type: 'string', description: 'What it does, in a few words' },
      timeout: { type: 'number', description: 'Milliseconds, default 120000' } }, required: ['command'] },
    run: ({ command, timeout }, ctx) =>
      runShell('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { ...ctx, timeoutMs: Math.min(Number(timeout) || 120_000, 600_000) }),
  },
  Bash: {
    description: 'Run a shell command.',
    schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'] },
    run: ({ command }, ctx) => runShell(process.platform === 'win32' ? 'bash.exe' : 'bash', ['-lc', command], ctx),
  },
  Read: {
    description: 'Read a text file on the laptop. Lines come back numbered.',
    schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' },
      limit: { type: 'number' } }, required: ['file_path'] },
    run: async ({ file_path, offset = 1, limit = 2000 }, { cwd }) =>
      ({ text: clip(numbered(await readFile(at(file_path, cwd), 'utf8'), Number(offset) || 1, Number(limit) || 2000)) }),
  },
  Write: {
    description: 'Write a file on the laptop (creates it, or replaces what is there).',
    schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'] },
    run: async ({ file_path, content }, { cwd }) => {
      const p = at(file_path, cwd)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, content, 'utf8')
      return { text: `Wrote ${p}` }
    },
  },
  Edit: {
    description: 'Replace exact text in a file on the laptop.',
    schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' },
      new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['file_path', 'old_string', 'new_string'] },
    run: async ({ file_path, old_string, new_string, replace_all = false }, { cwd }) => {
      const p = at(file_path, cwd)
      const text = await readFile(p, 'utf8')
      const count = text.split(old_string).length - 1
      if (count === 0) return { text: 'That text is not in the file.', isError: true }
      if (count > 1 && !replace_all) return { text: `That text is in the file ${count} times; give more of it.`, isError: true }
      await writeFile(p, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string), 'utf8')
      return { text: `Edited ${p}` }
    },
  },
  Glob: {
    description: "Find files by name pattern, e.g. '**/*.pdf'.",
    schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'] },
    run: async ({ pattern, path }, { cwd }) => {
      const found = []
      for await (const f of glob(pattern, { cwd: at(path ?? '.', cwd) })) {
        found.push(f)
        if (found.length >= 200) break
      }
      return { text: found.length ? found.join('\n') : 'No files found.' }
    },
  },
  Grep: {
    description: 'Search inside files for text (a regular expression).',
    schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' },
      glob: { type: 'string', description: "Only files whose name matches, e.g. '*.txt'" } }, required: ['pattern'] },
    run: async ({ pattern, path, glob: only }, { cwd, signal }) => {
      const re = new RegExp(pattern, 'i')
      const nameRe = only ? new RegExp(`^${only.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null
      const root = at(path ?? '.', cwd)
      const hits = []
      const files = (await stat(root)).isFile() ? [root] : walk(root)
      for await (const f of files) {
        if (signal?.aborted || hits.length >= 100) break
        if (nameRe && !nameRe.test(f.split(/[\\/]/).pop())) continue
        let text
        try {
          if ((await stat(f)).size > 2_000_000) continue
          text = await readFile(f, 'utf8')
        } catch {
          continue
        }
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 100 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
      return { text: hits.length ? hits.join('\n') : 'No matches.' }
    },
  },
  WebSearch: {
    description: 'Search the web. Returns titles, links and snippets.',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }, { signal }) => {
      const { text, structured } = await webSearch(query, { signal })
      return { text, structured }
    },
  },
  WebFetch: {
    description: 'Read a web page (its text).',
    schema: { type: 'object', properties: { url: { type: 'string' },
      prompt: { type: 'string', description: 'What to look for on the page' } }, required: ['url'] },
    run: async ({ url }, { signal }) => {
      const page = await webFetch(url, { signal })
      return { text: page.text, isError: page.code >= 400,
               structured: { code: page.code, url: page.url, result: page.text } }
    },
  },
  TodoWrite: {
    description: 'Keep a short to-do list for a long task.',
    schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } }, required: ['todos'] },
    run: async ({ todos }) => ({ text: `Noted ${Array.isArray(todos) ? todos.length : 0} items.` }),
  },
}

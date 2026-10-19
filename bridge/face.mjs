/**
 * The face, served by the bridge itself.
 *
 * In daily use there is no dev server: `npm start` builds the face once (when
 * the source has changed) and the bridge hands out the files. That is one Node
 * process instead of three, without Vite's file watchers or the 1.2 GB spike it
 * took re-optimising after a port change (PROGRESS.md, 2026-10-04). `npm run
 * dev` still runs Vite for working on the face.
 *
 * Loopback only, GET and HEAD only, and never a file outside `dir`.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** The file a request asks for, or null if it would leave `root`. */
export function facePath(root, url) {
  let path
  try {
    path = decodeURIComponent(new URL(url, 'http://x').pathname)
  } catch {
    return null
  }
  if (path === '/' || path === '') path = '/index.html'
  const file = resolve(root, `.${path}`)
  return file.startsWith(root + sep) ? file : null
}

/**
 * @param {{ dir: string, port: number, host?: string, log?: (msg: string) => void }} options
 */
export function serveFace({ dir, port, host = '127.0.0.1', log = console.log }) {
  const root = resolve(dir)
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      return res.end()
    }
    const file = facePath(root, req.url ?? '/')
    if (!file) {
      res.writeHead(403)
      return res.end()
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        // Built assets carry a content hash in their name; everything else
        // (index.html, the worklet) must be re-read after a rebuild.
        'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  server.on('error', (err) => log(`[gnosis] face: could not serve on ${host}:${port} — ${err.message}`))
  server.listen(port, host, () => log(`[gnosis] face on http://localhost:${port}`))
  return server
}

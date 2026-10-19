/**
 * One command to run AYRA.
 *
 *   npm start            daily use, light: the face is built once (only when its
 *                        source has changed) and the bridge serves it — one
 *                        process, no dev server, no file watchers
 *   npm run start:dev    working on the face: the bridge plus the Vite dev
 *                        server, with hot reload
 *
 * The children's output is tagged so the interleaved logs stay readable, and
 * Ctrl-C stops everything together.
 */

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const IDENTITY = JSON.parse(readFileSync('config/identity.json', 'utf8'))
const dev = process.argv.includes('--dev')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// Run by AYRA.exe (desktop/ayra.cs): it stops her by closing this process's
// input, and if the tray itself dies the input closes too. Either way only the
// direct children stop — never a Chrome window she opened, which a whole-tree
// kill would take down with every tab in it.
if (process.argv.includes('--supervised')) {
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('error', () => shutdown(0))
  process.stdin.resume()
}

/** The newest modification time under a file or folder. */
function newest(path) {
  if (!existsSync(path)) return 0
  const info = statSync(path)
  if (!info.isDirectory()) return info.mtimeMs
  let latest = 0
  for (const name of readdirSync(path)) latest = Math.max(latest, newest(join(path, name)))
  return latest
}

/** Build the face if anything it is made from changed since the last build. */
function buildFaceIfStale() {
  const built = newest('dist/index.html')
  const source = Math.max(
    ...['src', 'public', 'index.html', 'config/identity.json', 'vite.config.ts', 'package-lock.json'].map(newest),
  )
  if (built && built >= source) return
  console.log('  building the face (it changed since the last build)…')
  // vite build alone: the type check is `npm run build`'s job, not start-up's.
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('  the face did not build — see the errors above.')
    process.exit(1)
  }
}

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives AYRA's brain. A port outside that range produces the
 * most confusing failure this project has: the interface loads, the avatar
 * moves, the microphone hears you, and the brain answers nothing, because the
 * handshake is refused somewhere neither half reports. Passing the port through
 * closes that gap without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = {}
if (port) {
  bridgeEnv.AYRA_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  bridgeEnv.AYRA_FACE_PORT = port
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

if (dev) {
  console.log(`\n${IDENTITY.wordmark} starting for development — the brain and the Vite dev server.\n`)
  run('bridge', process.execPath, ['bridge/server.mjs'], '36', bridgeEnv)
  // npm is a shell script on most systems; call the vite binary directly so we
  // do not need shell:true (which would break the argument handling above).
  run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})
  console.log(
    '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
      `click INITIALISE, and say "Hey ${IDENTITY.name}". Ctrl-C stops everything.\n`,
  )
} else {
  buildFaceIfStale()
  console.log(`\n${IDENTITY.wordmark} starting.\n`)
  run('gnosis', process.execPath, ['bridge/server.mjs', '--face'], '36', bridgeEnv)
  console.log(
    `\nOpen http://localhost:${port || 5173} in Chrome, click INITIALISE and say ` +
      `"Hey ${IDENTITY.name}". Ctrl-C stops everything.\n`,
  )
}

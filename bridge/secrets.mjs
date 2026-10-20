/**
 * Gnosis's API keys, from the environment or Windows Credential Manager (secrets.ps1).
 *
 * A key already in the environment (the owner's user variables, or .env.local) wins. Otherwise the
 * one saved through the Settings screen is read from Credential Manager at start-up and put in this
 * process's environment, so everything that reads process.env.<KEY> works unchanged. Keys never
 * leave the bridge: the window is told only whether each one is set and where it came from.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'secrets.ps1')

/** The keys Gnosis knows, for the Settings screen. */
export const KEYS = [
  { name: 'NVIDIA_API_KEY', label: 'NVIDIA', about: 'His brain (Nemotron). Needed.', needed: true, url: 'https://build.nvidia.com' },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', about: 'His voice and his hearing.', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { name: 'TAVILY_API_KEY', label: 'Tavily', about: 'Better web search. Optional.', url: 'https://app.tavily.com' },
]
const NAMES = KEYS.map((k) => k.name)

/** Where each key came from: 'environment', 'saved' (Credential Manager) or null. */
const source = Object.fromEntries(NAMES.map((n) => [n, process.env[n] ? 'environment' : null]))

function ps(args, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    input, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  })
  try {
    const out = JSON.parse(String(r.stdout ?? '').trim() || '{}')
    if (out.error) throw new Error(out.error)
    return out
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('Credential Manager gave no answer')
    throw err
  }
}

/** At start-up: the saved keys that the environment doesn't already have. Never throws. */
export function loadSecrets({ run = ps, platform = process.platform } = {}) {
  const missing = NAMES.filter((n) => !process.env[n])
  if (platform !== 'win32' || !missing.length) return
  try {
    const saved = run(['-Op', 'read', '-Names', missing.join(',')])
    for (const n of missing) {
      if (typeof saved[n] === 'string' && saved[n]) {
        process.env[n] = saved[n]
        source[n] = 'saved'
      }
    }
  } catch (err) {
    console.warn(`[gnosis] couldn't read the saved keys: ${err.message}`)
  }
}

/** Saves a key in Credential Manager (or removes it, given ''), and uses it from now on. */
export function saveSecret(name, value, { run = ps } = {}) {
  if (!NAMES.includes(name)) throw new Error(`There's no key called ${name}`)
  const v = String(value ?? '').trim()
  if (!v) {
    run(['-Op', 'delete', '-Name', name])
    if (source[name] === 'saved') {
      delete process.env[name]
      source[name] = null
    }
    return
  }
  if (!/^[\x21-\x7e]{8,300}$/.test(v)) throw new Error(`That doesn't look like a ${name} key`)
  run(['-Op', 'write', '-Name', name], v)
  // The environment still wins at the next start, so say where the key in use comes from.
  if (source[name] !== 'environment') {
    process.env[name] = v
    source[name] = 'saved'
  }
}

/** For the Settings screen: set or not, and from where. Never the key. */
export function keyStatus() {
  return Object.fromEntries(KEYS.map((k) => [k.name, { label: k.label, about: k.about, url: k.url, needed: Boolean(k.needed),
    set: Boolean(process.env[k.name]), from: process.env[k.name] ? source[k.name] ?? 'environment' : null }]))
}

/**
 * Does this key work? One small request to its service. ElevenLabs keys can be limited to some
 * permissions: "missing_permissions" still means the key itself is real.
 * @returns {Promise<{ ok: boolean, why?: string }>}
 */
export async function testKey(name, value, { fetchImpl = fetch } = {}) {
  const v = String(value ?? process.env[name] ?? '').trim()
  if (!v) return { ok: false, why: 'No key to test.' }
  const t = AbortSignal.timeout(15_000)
  try {
    if (name === 'NVIDIA_API_KEY') {
      const r = await fetchImpl('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: `Bearer ${v}` }, signal: t })
      return r.ok ? { ok: true } : { ok: false, why: r.status === 401 || r.status === 403 ? 'NVIDIA didn\'t accept that key.' : `NVIDIA answered ${r.status}.` }
    }
    if (name === 'ELEVENLABS_API_KEY') {
      const r = await fetchImpl('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': v }, signal: t })
      if (r.ok) return { ok: true }
      const body = await r.json().catch(() => ({}))
      if (body?.detail?.status === 'missing_permissions') return { ok: true }
      return { ok: false, why: 'ElevenLabs didn\'t accept that key.' }
    }
    if (name === 'TAVILY_API_KEY') {
      const r = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${v}` },
        body: JSON.stringify({ query: 'test', max_results: 1 }), signal: t,
      })
      return r.ok ? { ok: true } : { ok: false, why: 'Tavily didn\'t accept that key.' }
    }
    return { ok: false, why: `There's no key called ${name}.` }
  } catch (err) {
    return { ok: false, why: `Couldn't reach the service to check (${err?.name === 'TimeoutError' ? 'it took too long' : err?.message ?? err}).` }
  }
}

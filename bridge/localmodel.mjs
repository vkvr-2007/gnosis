/**
 * The on-laptop model for private requests (config/models.json "local"): Nemotron Nano 4B through
 * llama.cpp's llama-server, started when a private request (or private mode) first needs it and
 * stopped after 15 idle minutes, so its memory (several GB) is only taken while it's in use.
 *
 * Where it lives is config/models.json "local.server": the llama-server program, the model file and
 * its chat template (they are large, so they stay where they are; by default Gnosis v1's
 * local-models folder). Not set, or the files missing: private requests are refused with that said
 * plainly, never sent to the cloud instead.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadModels, modelFor } from './models.mjs'

const IDLE_MS = 15 * 60_000

/** The command line for llama-server, or null with the reason. */
export function serverCommand(cfg = loadModels()) {
  const s = cfg.roles?.local?.server
  if (!s?.exe || !s?.model) return { error: 'the private model is not set up (config/models.json local.server)' }
  const missing = [s.exe, s.model, s.template].filter((f) => f && !existsSync(f))
  if (missing.length) return { error: `the private model's files are missing: ${missing.join(', ')}` }
  const port = new URL(cfg.providers.local.baseUrl).port || '8081'
  const args = ['-m', s.model, '--port', port, '--host', '127.0.0.1', '--jinja', '-c', String(s.context ?? 4096), '-np', '1',
    '--alias', cfg.roles.local.model, ...(s.template ? ['--chat-template-file', s.template] : []),
    ...(s.gpuLayers != null ? ['-ngl', String(s.gpuLayers)] : [])]
  return { exe: s.exe, args }
}

/**
 * @param {{ health?: () => Promise<boolean>, start?: (cmd) => { kill: () => void, on: Function }, now?: () => number,
 *           log?: (s: string) => void, readyTimeoutMs?: number }} deps
 */
export function createLocalModel({
  health = async () => {
    try {
      const base = modelFor('local').baseUrl.replace(/\/v1\/?$/, '')
      return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {
      return false
    }
  },
  start = (cmd) => spawn(cmd.exe, cmd.args, { windowsHide: true, stdio: 'ignore' }),
  command = serverCommand,
  log = (s) => console.log(s),
  readyTimeoutMs = 120_000,
  now = Date.now,
} = {}) {
  let proc = null
  let starting = null
  let lastUse = 0
  let timer = null

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
    if (proc) {
      try {
        proc.kill()
      } catch { /* already gone */ }
      log('[gnosis] private model: stopped (idle)')
    }
    proc = null
  }

  /** Ready to answer, starting it if needed; throws with a plain reason. */
  async function ensure() {
    lastUse = now()
    if (await health()) return true
    if (starting) return starting
    starting = (async () => {
      const cmd = command()
      if (cmd.error) throw new Error(cmd.error)
      log('[gnosis] private model: starting on the laptop')
      proc = start(cmd)
      proc.on?.('exit', () => {
        proc = null
      })
      const until = now() + readyTimeoutMs
      while (now() < until) {
        if (await health()) {
          log('[gnosis] private model: ready')
          if (!timer) {
            timer = setInterval(() => now() - lastUse > IDLE_MS && stop(), 60_000)
            timer.unref?.()
          }
          return true
        }
        if (!proc) throw new Error('the private model stopped while starting')
        await new Promise((r) => setTimeout(r, 1000))
      }
      stop()
      throw new Error('the private model took too long to start')
    })().finally(() => {
      starting = null
    })
    return starting
  }

  return {
    ensure,
    stop,
    /** 'running', 'starting' or 'off', for Settings. */
    async state() {
      if (starting) return 'starting'
      return (await health()) ? 'running' : 'off'
    },
    available: () => !command().error,
  }
}

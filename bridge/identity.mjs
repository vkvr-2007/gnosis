/**
 * AYRA's identity and the bridge's environment, loaded once at startup.
 *
 * Identity lives in config/identity.json so the bridge and the face can never
 * disagree about the name, the honorific or the language. This module is the
 * bridge's only door to it.
 *
 * It also loads `.env.local` from the repo root. On Windows, setting variables
 * for a single command is awkward (`VAR=1 node …` is POSIX syntax that
 * PowerShell and cmd reject), so the file is the comfortable place for AYRA_*
 * settings and secrets. Variables already set in the shell win over the file,
 * and Vite only ever exposes VITE_* values to the browser, so bridge secrets in
 * the same file never reach the page.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))

const envFile = root('.env.local')
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile)
  } catch (err) {
    console.warn(`[gnosis] could not read .env.local: ${err.message}`)
  }
}

/** @type {{ name: string, wordmark: string, tagline: string, honorific: string, language: string,
 *           timezone: string, voice: { gender: 'female' | 'male', prefer: string[], elevenLabsId?: string },
 *           wake: { names: string[], prefixedOnly: string[] } }} */
export const IDENTITY = JSON.parse(readFileSync(root('config/identity.json'), 'utf8'))

/**
 * The bridge's settings, read as AYRA_<name>. One helper so every variable is
 * spelled the same way and a blank value means "use the default", which is
 * what an empty line in .env.local looks like.
 */
export function env(name, fallback) {
  const value = process.env[`AYRA_${name}`]
  return value === undefined || value.trim() === '' ? fallback : value.trim()
}

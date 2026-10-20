/**
 * "Start Gnosis when I sign in", for the Settings screen: the Gnosis shortcut in the owner's Startup
 * folder. Gnosis.exe makes and removes it itself (--install, --install --no-startup), so this only
 * finds the exe and asks it.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STARTUP_LINK = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Gnosis.lnk')

/** Gnosis.exe: beside his own Node when installed, desktop\bin in a code checkout. */
export function gnosisExe({ execPath = process.execPath, exists = existsSync } = {}) {
  const installed = join(dirname(dirname(execPath)), 'Gnosis.exe')
  if (/[\\/]runtime[\\/]node\.exe$/i.test(execPath) && exists(installed)) return installed
  const checkout = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'bin', 'Gnosis.exe')
  return exists(checkout) ? checkout : null
}

export const startWithWindows = () => existsSync(STARTUP_LINK)

/** Turns starting at sign-in on or off. */
export function setStartWithWindows(on) {
  const exe = gnosisExe()
  if (!exe) return Promise.reject(new Error("Gnosis.exe wasn't found, so starting with Windows can't be changed here."))
  return new Promise((resolve, reject) => {
    const p = spawn(exe, on ? ['--install'] : ['--install', '--no-startup'], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(startWithWindows()) : reject(new Error(`Gnosis.exe answered ${code}`))))
  })
}

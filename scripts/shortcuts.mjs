/**
 * AYRA on the Windows desktop — `npm run shortcuts`.
 *
 * Builds AYRA.exe from desktop/ayra.cs with the C# compiler that ships with
 * Windows (nothing to install) into desktop/bin, beside its icon and settings
 * (ayra.ini), and has it make the shortcuts:
 *
 *   AYRA            Desktop + Start menu: opens her window (starting her if needed)
 *   Chrome (AYRA)   Desktop + Start menu: the owner's Chrome, the one she drives
 *   AYRA            Startup folder: she is running from sign-in, in the tray
 *                   (the owner's choice, 2026-10-05) — `--no-startup` removes it
 *
 * Then AYRA.exe starts in the tray. Run it again after changing AYRA_HOTKEY,
 * the ports or desktop/ayra.cs. Windows does not let a program pin itself to
 * the taskbar: the owner right-clicks "AYRA" once → Pin to taskbar.
 *
 * Why desktop/bin and not %LOCALAPPDATA%: a program run from inside a packaged
 * app (the Claude desktop app, for one) has its AppData writes quietly moved
 * into that app's private folder, where Windows itself never finds them. The
 * AYRA folder is an ordinary folder for everyone.
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromeArgs, chromePath } from '../bridge/browser.mjs'
import { env } from '../bridge/identity.mjs'

if (process.platform !== 'win32') {
  console.log('The desktop app is for Windows; on this system run `npm start` and open http://localhost:5173.')
  process.exit(0)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, 'desktop', 'bin')
const EXE = join(HOME, 'Gnosis.exe')
const identity = JSON.parse(readFileSync(join(ROOT, 'config', 'identity.json'), 'utf8'))

const windir = process.env.WINDIR ?? 'C:\\Windows'
const csc = ['Framework64', 'Framework']
  .map((f) => join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
  .find(existsSync)
if (!csc) {
  console.error('The C# compiler that comes with Windows (.NET Framework 4) was not found.')
  process.exit(1)
}

/** True while AYRA.exe is running (it locks its own file). */
const trayRunning = () =>
  /Gnosis\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq Gnosis.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '')

// Built beside the old exe first: if the build fails, the AYRA that is running
// is left exactly as it was.
mkdirSync(HOME, { recursive: true })
const NEXT = join(HOME, 'Gnosis.next.exe')
const build = spawnSync(
  csc,
  [
    '/nologo', '/target:winexe', '/optimize+', `/out:${NEXT}`,
    `/win32icon:${join(ROOT, 'desktop', 'ayra.ico')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    join(ROOT, 'desktop', 'ayra.cs'),
  ],
  { encoding: 'utf8' },
)
if (build.status !== 0) {
  console.error(`Gnosis.exe did not build, so nothing was changed:\n${build.stdout}${build.stderr}`)
  process.exit(1)
}

// A running tray is asked to stop AYRA and close, so its exe can be replaced.
// The new build sends the request: the old exe may live somewhere else.
const wasRunning = trayRunning()
if (wasRunning) {
  spawnSync(NEXT, ['--quit'])
  for (let i = 0; i < 60 && trayRunning(); i++) await new Promise((r) => setTimeout(r, 250))
  if (trayRunning()) {
    console.error('Gnosis.exe is still running — choose Quit Gnosis in its tray menu, then run this again.')
    process.exit(1)
  }
}

renameSync(NEXT, EXE)
copyFileSync(join(ROOT, 'desktop', 'ayra.ico'), join(HOME, 'ayra.ico'))
console.log(`built ${EXE}`)

const chrome = chromePath()
const ini = [
  '# Written by `npm run shortcuts` — run it again rather than editing this.',
  `root=${ROOT}`,
  `node=${process.execPath}`,
  ...(chrome ? [`chrome=${chrome}`, ...chromeArgs().map((a) => `chromeArg=${a}`)] : []),
  `face=http://localhost:${env('FACE_PORT', '5173')}`,
  `health=http://127.0.0.1:${env('BRIDGE_PORT', '8787')}/health`,
  `title=${identity.wordmark}`,
  `hotkey=${env('HOTKEY', 'ctrl+alt+a')}`,
  `handsfree=${env('HANDSFREE_HOTKEY', 'ctrl+alt+w')}`,
  `talk=${env('TALK_HOTKEY', 'alt+space')}`,
  `bubble=${env('BUBBLE', 'on')}`,
]
writeFileSync(join(HOME, 'gnosis.ini'), `${ini.join('\r\n')}\r\n`)

const startup = !process.argv.includes('--no-startup')
const install = spawnSync(EXE, ['--install', ...(startup ? [] : ['--no-startup'])], { encoding: 'utf8' })
process.stdout.write(install.stdout ?? '')
if (install.status !== 0) console.error(`The shortcuts were not made (exit ${install.status}).`)

// Started the way sign-in starts it — through Explorer, from the Startup
// shortcut — so the tray and every bridge it runs get the owner's own clean
// environment, not this shell's (which holds .env.local, loaded above, and
// whatever the terminal set). Without the Startup shortcut it opens her window.
const loginLink = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Gnosis.lnk')
spawn('explorer.exe', [startup && existsSync(loginLink) ? loginLink : EXE], { detached: true, stdio: 'ignore' }).unref()
console.log(
  `\nGnosis is in the tray, by the clock: click her icon to open her window, or press ${env('HOTKEY', 'ctrl+alt+a')} to talk.` +
    '\nTo pin her: right-click "Gnosis" on the Desktop → Show more options → Pin to taskbar.',
)
if (install.status !== 0) process.exit(1)

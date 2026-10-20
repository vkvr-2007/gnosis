/**
 * Gnosis as an installable Windows app — `npm run package`.
 *
 * Builds release/Gnosis Setup.exe: one file that installs Gnosis for the owner (no admin rights) in
 * %LOCALAPPDATA%\Programs\Gnosis, with his own copy of Node, and keeps his data in
 * %LOCALAPPDATA%\Gnosis\data (bridge/paths.mjs). The installer itself is desktop/setup.cs, built
 * with the C# compiler that comes with Windows, with the app folder inside it as a zip.
 *
 * The app folder:
 *   Gnosis.exe, the WebView2 DLLs, the icon      the app (desktop/ayra.cs)
 *   runtime\node.exe                             his own Node: nothing to install
 *   app\                                         the bridge, the built window, config, the mascot,
 *                                                and only the packages the bridge imports at run time
 *   gnosis.ini.template                          finished by the installer with the real paths
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromeArgs } from '../bridge/browser.mjs'
import { env } from '../bridge/identity.mjs'
import { FILES as WEBVIEW2_FILES, ensureWebView2 } from './webview2.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release')
const STAGE = join(OUT, 'stage', 'Gnosis')
const APP = join(STAGE, 'app')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const identity = JSON.parse(readFileSync(join(ROOT, 'config', 'identity.json'), 'utf8'))
/** What the bridge imports at run time; everything else is built into the window or only for development. */
const RUNTIME_PACKAGES = ['zod', 'ws', 'qrcode', 'puppeteer-core', 'sherpa-onnx-node']

const step = (what) => console.log(`- ${what}`)
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`)
}
const csc = ['Framework64', 'Framework']
  .map((f) => join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
  .find(existsSync)
if (!csc) throw new Error('The C# compiler that comes with Windows (.NET Framework 4) was not found.')

rmSync(join(OUT, 'stage'), { recursive: true, force: true })
mkdirSync(APP, { recursive: true })

step('building the window')
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], { cwd: ROOT })

step('copying the app')
for (const dir of ['bridge', 'config', 'dist']) cpSync(join(ROOT, dir), join(APP, dir), { recursive: true })
mkdirSync(join(APP, 'scripts'), { recursive: true })
copyFileSync(join(ROOT, 'scripts', 'start.mjs'), join(APP, 'scripts', 'start.mjs'))
cpSync(join(ROOT, 'desktop', 'mascot'), join(APP, 'desktop', 'mascot'), { recursive: true })

step(`installing the packages the bridge runs on (${RUNTIME_PACKAGES.join(', ')})`)
const versions = Object.fromEntries(RUNTIME_PACKAGES.map((n) => [n, JSON.parse(readFileSync(join(ROOT, 'node_modules', n, 'package.json'), 'utf8')).version]))
writeFileSync(join(APP, 'package.json'), JSON.stringify({ name: 'gnosis', version: pkg.version ?? '1.0.0', private: true, type: 'module', dependencies: versions }, null, 2))
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
run(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: APP })

step('his own Node')
mkdirSync(join(STAGE, 'runtime'), { recursive: true })
copyFileSync(process.execPath, join(STAGE, 'runtime', 'node.exe'))

step('building Gnosis.exe')
const WEBVIEW2 = await ensureWebView2()
run(csc, ['/nologo', '/target:winexe', '/optimize+', '/platform:x64', `/out:${join(STAGE, 'Gnosis.exe')}`,
  `/win32icon:${join(ROOT, 'desktop', 'ayra.ico')}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  `/r:${join(WEBVIEW2, 'Microsoft.Web.WebView2.Core.dll')}`, `/r:${join(WEBVIEW2, 'Microsoft.Web.WebView2.WinForms.dll')}`,
  join(ROOT, 'desktop', 'ayra.cs')])
for (const f of Object.keys(WEBVIEW2_FILES)) copyFileSync(join(WEBVIEW2, f), join(STAGE, f))
copyFileSync(join(ROOT, 'desktop', 'ayra.ico'), join(STAGE, 'ayra.ico'))

// The settings Gnosis.exe reads; {INSTALL} and {DATA} are filled in by the installer. His Chrome
// (for the browser tools) is found on the owner's laptop by the installer too.
const local = process.env.LOCALAPPDATA ?? ''
const ini = [
  '# Written by the Gnosis installer.',
  'root={INSTALL}\\app',
  'node={INSTALL}\\runtime\\node.exe',
  'data={DATA}',
  'chrome={CHROME}',
  ...chromeArgs().map((a) => `chromeArg=${local ? a.split(local).join('{LOCALAPPDATA}') : a}`),
  `face=http://localhost:${env('FACE_PORT', '5173')}`,
  `health=http://127.0.0.1:${env('BRIDGE_PORT', '8787')}/health`,
  `title=${identity.wordmark}`,
  'hotkey=ctrl+alt+a',
  'handsfree=ctrl+alt+w',
  'talk=alt+space',
  'bubble=on',
]
writeFileSync(join(STAGE, 'gnosis.ini.template'), `${ini.join('\r\n')}\r\n`)

const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size)
const appBytes = size(STAGE)
step(`zipping the app (${Math.round(appBytes / 1048576)} MB)`)
const zip = join(OUT, 'payload.zip')
rmSync(zip, { force: true })
run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`])

step('building Gnosis Setup.exe')
const setup = join(OUT, 'Gnosis Setup.exe')
writeFileSync(join(OUT, 'stage', 'version.txt'), `${pkg.version ?? '1.0.0'}\n${Math.round(appBytes / 1024)}\n`)
run(csc, ['/nologo', '/target:winexe', '/optimize+', '/platform:x64', `/out:${setup}`,
  `/win32icon:${join(ROOT, 'desktop', 'ayra.ico')}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  `/resource:${zip},payload.zip`, `/resource:${join(OUT, 'stage', 'version.txt')},version.txt`,
  join(ROOT, 'desktop', 'setup.cs')])
rmSync(zip, { force: true })
rmSync(join(OUT, 'stage'), { recursive: true, force: true })
console.log(`\n${setup} (${Math.round(statSync(setup).size / 1048576)} MB)`)

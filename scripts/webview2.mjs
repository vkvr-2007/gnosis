// Gets Microsoft's WebView2 SDK for Gnosis.exe (desktop/ayra.cs): Gnosis's window is an Edge WebView2
// inside the app itself, not a Chrome window. Downloads the pinned NuGet package once from nuget.org
// and keeps the three files the app needs in desktop/webview2/. The WebView2 runtime itself comes
// with Windows 11.
//   node scripts/webview2.mjs
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const VERSION = '1.0.4191.47'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DIR = join(ROOT, 'desktop', 'webview2')
export const FILES = {
  'Microsoft.Web.WebView2.Core.dll': 'lib/net462/Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll': 'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll': 'runtimes/win-x64/native/WebView2Loader.dll',
}

export async function ensureWebView2({ log = console.log } = {}) {
  if (Object.keys(FILES).every((f) => existsSync(join(DIR, f)))) return DIR
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/microsoft.web.webview2.${VERSION}.nupkg`
  log(`getting the WebView2 SDK ${VERSION} from nuget.org`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`nuget.org answered ${res.status} for the WebView2 SDK`)
  const work = join(tmpdir(), `gnosis-webview2-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const zip = join(work, 'webview2.zip')
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  const out = join(work, 'x')
  const unzip = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { encoding: 'utf8' })
  if (unzip.status !== 0) throw new Error(`couldn't unpack the WebView2 SDK: ${unzip.stderr}`)
  mkdirSync(DIR, { recursive: true })
  for (const [name, inside] of Object.entries(FILES)) copyFileSync(join(out, ...inside.split('/')), join(DIR, name))
  rmSync(work, { recursive: true, force: true })
  return DIR
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureWebView2().then((d) => console.log(`WebView2 SDK in ${d}`), (e) => {
    console.error(e.message)
    process.exit(1)
  })
}

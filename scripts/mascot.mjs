/**
 * Gnosis for the desktop bubble — `npm run mascot`.
 *
 * The bubble (desktop/ayra.cs) shows Gnosis himself rather than an icon (the owner, 2026-10-18), so
 * this draws him in each state the bubble shows, as transparent PNGs in desktop/mascot/. They come
 * from the face's own avatar (avatar.html?capture=1, the same SVG and poses), so the two always
 * match. Run it again after changing the avatar; the PNGs are kept in git so the desktop app needs
 * no browser to build.
 */

import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'
import { chromePath } from '../bridge/browser.mjs'

/** Picture name → avatar pose (and how open the mouth is). */
export const FRAMES = {
  sleep: { pose: 'sleep' },
  idle: { pose: 'idle' },
  wave: { pose: 'wave' },
  listen: { pose: 'listen' },
  think: { pose: 'think' },
  work: { pose: 'magic' },
  talk: { pose: 'talk', mouth: 0.85 },
  talk2: { pose: 'talk', mouth: 0.15 },
  oops: { pose: 'oops' },
}

/** The part of the 400 × 440 drawing the bubble shows: his head, shoulders and the laptop. */
const CLIP = { x: 40, y: 20, width: 320, height: 420 }
const SCALE = 0.6 // 192 × 252 px: sharp in a bubble about 100 px wide, at up to 200 % display scaling

const executablePath = chromePath()
if (!executablePath) {
  console.error('Chrome is needed to draw the mascot, and it was not found.')
  process.exit(1)
}
const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' })
await server.listen()
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 400, height: 440, deviceScaleFactor: SCALE })
  mkdirSync('desktop/mascot', { recursive: true })
  for (const [name, { pose, mouth }] of Object.entries(FRAMES)) {
    await page.goto(`${base}/avatar.html?capture=1&pose=${pose}${mouth != null ? `&mouth=${mouth}` : ''}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.avatar-svg')
    await new Promise((r) => setTimeout(r, 400)) // the pose's own fade-ins
    await page.screenshot({ path: `desktop/mascot/${name}.png`, omitBackground: true, clip: CLIP })
    console.log(`made desktop/mascot/${name}.png`)
  }
} finally {
  await browser.close()
  await server.close()
}

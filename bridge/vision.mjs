/**
 * Gnosis's eyes, ported from Gnosis v1: the screen, the webcam, and pictures other tools bring back.
 *
 * The brain (Nemotron Super) reads text only, so a picture goes to NVIDIA's vision model (the
 * "vision" role in config/models.json) with the question it should answer, and its answer comes
 * back as words. Three tools (server ayra_vision, allowed by the gate):
 *   look_at_screen       — the whole screen, or a question about it
 *   look_through_camera  — one frame from the webcam, taken by the face (its window asks the browser)
 *   vision_click         — click something by sight, for what the apps and browser tools can't reach:
 *                          the model points at it on the whole screen, then again on a close-up of
 *                          that spot, and the click lands where it points the second time.
 *                          Sending, paying, deleting and the like are refused.
 * And describeImages(): a screenshot from apps_screenshot or browser_screenshot is described to the
 * brain instead of "[an image]" (sdk.mjs), unless the turn is private.
 */

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { modelFor } from './models.mjs'
import { createSdkMcpServer, tool } from './sdk.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'vision.ps1')

/** The close-up around the first point, in screen pixels: small enough for a taskbar icon to be big. */
export const CLOSE_UP = { width: 480, height: 270 }

/** What a click by sight never does: the owner does these, or the apps tools ask first. */
export const RISKY = /\b(?:send|pay|payment|purchase|buy|checkout|order|delete|remove|erase|format|uninstall|transfer|confirm|submit|publish|post|sign ?out|log ?out|reset|wipe|empty (?:the )?(?:recycle bin|trash)|allow|grant|accept)\b/i

/**
 * Ask the vision model about pictures.
 * @param {{ images: { data: string, mimeType?: string }[], question: string, maxTokens?: number }} ask
 */
export async function askVision({ images, question, maxTokens = 400 }, { fetchImpl = fetch, route = modelFor('vision'), signal } = {}) {
  if (!route.apiKey && !route.onDevice) throw new Error('No key for the vision model')
  // NVIDIA's endpoint now and then answers 500 to a request that works a moment later: two more tries.
  for (let attempt = 1; ; attempt++) {
    try {
      return await askOnce()
    } catch (err) {
      if (attempt >= 3 || !err?.retry || signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  async function askOnce() {
    const res = await fetchImpl(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}) },
      body: JSON.stringify({
        model: route.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: question },
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType ?? 'image/jpeg'};base64,${i.data}` } })),
        ] }],
        max_tokens: maxTokens,
        temperature: 0.2,
        // Without this it spends the whole budget thinking and says nothing (seen 2026-10-18).
        ...(route.extraBody ?? { chat_template_kwargs: { enable_thinking: false } }),
      }),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      throw Object.assign(new Error(`The vision model answered ${res.status}: ${(await res.text()).slice(0, 200)}`),
        { retry: res.status >= 500 || res.status === 429 })
    }
    const msg = (await res.json()).choices?.[0]?.message ?? {}
    const answer = String(msg.content ?? msg.reasoning_content ?? '').trim()
    if (!answer) throw new Error('The vision model said nothing')
    return answer
  }
}

/**
 * A point the vision model gave, {"x":…,"y":…} in thousandths of the picture's width and height
 * (how Nemotron VL answers: asked for pixels it still gave thousandths, 2026-10-18), on a part of
 * the screen → screen pixels, or null.
 */
export function pointOn(answer, area) {
  const x = Number(answer?.x)
  const y = Number(answer?.y)
  if (answer?.x == null || answer?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1000 || y < 0 || y > 1000) return null
  return { x: area.left + (area.width * x) / 1000, y: area.top + (area.height * y) / 1000 }
}

/** The first JSON object in a model's answer, or null. */
export function jsonIn(text) {
  const m = /\{[\s\S]*?\}/.exec(String(text ?? ''))
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

/** The close-up around a point, kept inside the screen. */
export function closeUpAround(point, screen, size = CLOSE_UP) {
  const width = Math.min(size.width, screen.width)
  const height = Math.min(size.height, screen.height)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  return {
    left: Math.round(clamp(point.x - width / 2, screen.left, screen.left + screen.width - width)),
    top: Math.round(clamp(point.y - height / 2, screen.top, screen.top + screen.height - height)),
    width,
    height,
  }
}

/** Runs vision.ps1 once: { op:'screen', region? } → { jpeg, width, height, left, top }; { op:'click', x, y, button }. */
export function runScreen({ op, region, x = 0, y = 0, button = 'left' }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Op', op]
  if (op === 'screen') {
    if (region) args.push('-Region', [region.left, region.top, region.width, region.height].map(Math.round).join(','))
  } else {
    args.push('-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-Button', button)
  }
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const out = JSON.parse(stdout.trim())
        if (out.error) reject(new Error(out.error))
        else resolve(out)
      } catch {
        reject(new Error('The screen helper gave no answer'))
      }
    })
  })
}

const DESCRIBE = (request) =>
  'Describe this picture for someone who cannot see it, in at most 120 words. Give the words that matter ' +
  `exactly as written. What they want to know: ${request || 'what is shown'}`

/**
 * A tool result with pictures in it, with each picture put into words for a text-only model.
 * Leaves the result alone when there is nothing to describe or the vision model can't be reached.
 */
export async function describeImages(result, request, { ask = askVision, signal } = {}) {
  const blocks = Array.isArray(result?.raw?.content) ? result.raw.content : []
  const images = blocks.filter((b) => b?.type === 'image' && b.data)
  if (!images.length) return result
  const said = []
  for (const img of images) {
    try {
      said.push(await ask({ images: [{ data: img.data, mimeType: img.mimeType }], question: DESCRIBE(request) }, { signal }))
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      said.push(null)
    }
  }
  let i = 0
  const text = blocks.map((b) => {
    if (b?.type === 'text') return b.text
    if (b?.type !== 'image') return ''
    const d = said[i++]
    return d ? `[the picture shows: ${d}]` : '[an image, shown on screen]'
  }).filter(Boolean).join('\n')
  return { ...result, text }
}

/**
 * The vision tools.
 * @param {{ ask?: typeof askVision, screen?: typeof runScreen, camera?: () => Promise<string>,
 *           emitBlade?: (blade: object) => void }} deps
 */
export function visionServer({ ask = askVision, screen = runScreen, camera, emitBlade } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  const show = (title, jpeg) => emitBlade?.({
    id: `see-${Date.now().toString(36)}`, title, kind: 'image', url: `data:image/jpeg;base64,${jpeg}`, size: 'wide', hold: 'turn',
  })

  /** Where the vision model points at the target on a picture of `area`, and the words on it. */
  async function point(jpeg, area, target) {
    const said = await ask({ images: [{ data: jpeg }], maxTokens: 120, question:
      `Find: ${target}. Answer only JSON {"x":<0-1000>,"y":<0-1000>,"label":"<its visible words, if any>"} ` +
      "for its middle, as thousandths of the picture's width and height from the top-left, or " +
      '{"x":null} if it is not there.' })
    const j = jsonIn(said)
    return { at: pointOn(j, area), label: String(j?.label ?? '') }
  }

  return createSdkMcpServer({
    name: 'gnosis_vision',
    tools: [
      tool('look_at_screen',
        "See the whole screen as it is now and answer a question about it (what's open, what an error says, " +
          'what something looks like). For one app window or web page, apps_read or browser_read is faster.',
        { question: z.string().optional().describe('What to look for; empty describes the screen') },
        async ({ question = '' }) => {
          const shot = await screen({ op: 'screen' })
          show('SCREEN', shot.jpeg)
          return text(await ask({ images: [{ data: shot.jpeg }], question: question
            ? `This is the owner's laptop screen. ${question} Answer in at most 80 words, quoting words exactly.`
            : "This is the owner's laptop screen. Say in at most 80 words what is open and what it shows." }))
        }),
      tool('look_through_camera',
        "Take one picture with the laptop's webcam and answer a question about it (what the owner is holding, " +
          'how they look, what is in the room). Only when the owner asks you to look at them or something they show.',
        { question: z.string().optional() },
        async ({ question = '' }) => {
          if (!camera) return fail("The camera isn't reachable: my window has to be open to use it.")
          let jpeg
          try {
            jpeg = await camera()
          } catch (err) {
            return fail(`The camera didn't give a picture: ${err?.message ?? err}`)
          }
          show('CAMERA', jpeg)
          return text(await ask({ images: [{ data: jpeg }], question: question
            ? `This is a webcam picture of the owner or what they are showing. ${question} Answer in at most 60 words.`
            : 'This is a webcam picture of the owner. Say in at most 60 words what you see.' }))
        }),
      tool('vision_click',
        'Click something on the screen by how it looks, when apps_click or browser_click cannot reach it ' +
          '(a game, a picture, a canvas, an app with no controls to read). Say what to click as you would to a person.',
        {
          target: z.string().describe('What to click, e.g. "the play button under the video", "the red X of the popup"'),
          button: z.enum(['left', 'double', 'right']).optional(),
        },
        async ({ target, button = 'left' }) => {
          if (RISKY.test(target)) {
            return fail(`Clicking "${target}" by sight isn't allowed: it sends, pays, deletes or confirms something. ` +
              'Use the apps or browser tools, which ask the owner first, or ask the owner to click it.')
          }
          const full = await screen({ op: 'screen' })
          const first = await point(full.jpeg, full, target)
          if (!first.at) return fail(`I couldn't see ${target} on the screen.`)
          if (RISKY.test(first.label)) {
            return fail(`That is labelled "${first.label}", which sends, pays, deletes or confirms something: not clicked by sight.`)
          }
          // On the whole screen the point can be an icon or two off; on the close-up it is spot on
          // (taskbar icons, 2026-10-18).
          const region = closeUpAround(first.at, full)
          const near = await screen({ op: 'screen', region })
          const second = await point(near.jpeg, region, target)
          // Not in the close-up: the first look was wrong, and a guess is never clicked.
          if (!second.at) return fail(`I couldn't pin down ${target} on the screen, so I didn't click.`)
          if (RISKY.test(second.label)) {
            return fail(`That is labelled "${second.label}", which sends, pays, deletes or confirms something: not clicked by sight.`)
          }
          const { x, y } = second.at
          await screen({ op: 'click', x, y, button })
          const label = second.label || first.label
          return text(`Clicked ${label ? `"${label}"` : target} at (${Math.round(x)}, ${Math.round(y)}). ` +
            'Look at the screen again if you need to check it worked.')
        }),
    ],
  })
}

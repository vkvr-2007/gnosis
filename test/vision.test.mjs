/** Gnosis's eyes (bridge/vision.mjs), ported from Gnosis v1: the screen, the webcam, click by sight. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { askVision, closeUpAround, describeImages, jsonIn, pointOn, RISKY, visionServer } from '../bridge/vision.mjs'
import { createGate } from '../bridge/gate.mjs'
import { modelFor } from '../bridge/models.mjs'

const tools = (deps) => Object.fromEntries(visionServer(deps).tools.map((t) => [t.name, t.handler]))
const said = (r) => r.content[0].text

test('the vision role is NVIDIA\'s Nemotron VL, with thinking off', () => {
  const r = modelFor('vision')
  assert.equal(r.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b')
  assert.equal(r.extraBody.chat_template_kwargs.enable_thinking, false)
})

test('askVision sends the question and the picture, and reads the answer (or the reasoning when content is empty)', async () => {
  let sent
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) }
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, reasoning_content: 'A cat.' } }] }) }
  }
  const route = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'vl', extraBody: { chat_template_kwargs: { enable_thinking: false } } }
  assert.equal(await askVision({ images: [{ data: 'AAA' }], question: 'What?' }, { fetchImpl, route }), 'A cat.')
  assert.equal(sent.url, 'https://x/v1/chat/completions')
  assert.equal(sent.body.chat_template_kwargs.enable_thinking, false)
  assert.equal(sent.body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAA')
})

test("points: the model's thousandths on a part of the screen become screen pixels; nonsense is null", () => {
  const area = { left: 1000, top: 800, width: 480, height: 270 }
  assert.deepEqual(pointOn({ x: 500, y: 500 }, area), { x: 1240, y: 935 })
  assert.deepEqual(pointOn({ x: 0, y: 1000 }, area), { x: 1000, y: 1070 })
  assert.equal(pointOn({ x: null }, area), null)
  assert.equal(pointOn({ x: 1200, y: 5 }, area), null)
  assert.equal(pointOn(null, area), null)
  assert.deepEqual(jsonIn('Sure: {"x":251,"y":895,"label":"Play"} ok'), { x: 251, y: 895, label: 'Play' })
  assert.equal(jsonIn('no json'), null)
})

test('the close-up is centred on the point and kept inside the screen', () => {
  const screen = { width: 1920, height: 1080, left: 0, top: 0 }
  assert.deepEqual(closeUpAround({ x: 960, y: 540 }, screen), { left: 720, top: 405, width: 480, height: 270 })
  assert.deepEqual(closeUpAround({ x: 1900, y: 1070 }, screen), { left: 1440, top: 810, width: 480, height: 270 })
  assert.deepEqual(closeUpAround({ x: 5, y: 5 }, screen), { left: 0, top: 0, width: 480, height: 270 })
})

test('risky targets: sending, paying, deleting and confirming are never clicked by sight', () => {
  for (const t of ['the Send button', 'Pay now', 'delete this file', 'Confirm', 'Buy']) assert.match(t, RISKY, t)
  for (const t of ['the play button', 'the red X of the popup', 'the search box']) assert.doesNotMatch(t, RISKY, t)
})

test('vision_click: a point on the screen, then on the close-up, and the click lands on the second', async () => {
  const shots = []
  const clicks = []
  const screen = async (a) => {
    if (a.op === 'click') return clicks.push(a), a
    shots.push(a)
    return { jpeg: 'J', width: 1920, height: 1080, left: 0, top: 0 }
  }
  const answers = ['{"x":650,"y":975,"label":"Chrome"}', '{"x":500,"y":800,"label":"Chrome"}']
  const t = tools({ ask: async () => answers.shift(), screen })
  const r = await t.vision_click({ target: 'the Chrome icon' })
  assert.match(said(r), /^Clicked "Chrome" at \(1248, 1026\)/)
  assert.deepEqual(shots.map((s) => s.region ?? null), [null, { left: 1008, top: 810, width: 480, height: 270 }])
  assert.deepEqual(clicks[0], { op: 'click', x: 1248, y: 1026, button: 'left' })
})

test('vision_click refuses a risky target before looking, and a risky label after', async () => {
  let looked = 0
  const screen = async (a) => (a.op === 'click' ? assert.fail('clicked') : (looked++, { jpeg: 'J', width: 1000, height: 700, left: 0, top: 0 }))
  const t = tools({ ask: async () => '{"x":300,"y":300,"label":"Send"}', screen })
  assert.equal((await t.vision_click({ target: 'the send button' })).isError, true)
  assert.equal(looked, 0)
  const r = await t.vision_click({ target: 'the blue button' })
  assert.equal(r.isError, true)
  assert.match(said(r), /labelled "Send"/)
})

test('vision_click never clicks a guess: the closer look must find it too', async () => {
  const answers = ['{"x":650,"y":975}', '{"x":null}']
  const screen = async (a) => (a.op === 'click' ? assert.fail('clicked') : { jpeg: 'J', width: 1000, height: 700, left: 0, top: 0 })
  const r = await tools({ ask: async () => answers.shift(), screen }).vision_click({ target: 'the Chrome icon' })
  assert.equal(r.isError, true)
  assert.match(said(r), /couldn't pin down the Chrome icon/)
})

test('a 500 from the vision model is tried once more; a 400 is not', async () => {
  const route = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'vl' }
  const replies = [500, 200]
  let calls = 0
  const fetchImpl = async () => {
    calls++
    const status = replies.shift()
    return { ok: status === 200, status, text: async () => 'oops', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  assert.equal(await askVision({ images: [], question: 'q' }, { fetchImpl, route }), 'ok')
  assert.equal(calls, 2)
  replies.push(400, 200)
  await assert.rejects(askVision({ images: [], question: 'q' }, { fetchImpl, route }), /answered 400/)
  assert.equal(calls, 3)
})

test('vision_click says so when the thing is not on screen', async () => {
  const t = tools({ ask: async () => '{"x":null}', screen: async () => ({ jpeg: 'J', width: 10, height: 10, left: 0, top: 0 }) })
  assert.match(said(await t.vision_click({ target: 'a unicorn' })), /couldn't see a unicorn/)
})

test('look_at_screen and look_through_camera answer from the picture; no window, no camera', async () => {
  const asked = []
  const ask = async ({ images, question }) => (asked.push([images[0].data, question]), 'Notepad is open.')
  const t = tools({ ask, screen: async () => ({ jpeg: 'SCREEN' }), camera: async () => 'CAM' })
  assert.equal(said(await t.look_at_screen({ question: 'What app is open?' })), 'Notepad is open.')
  assert.equal(said(await t.look_through_camera({})), 'Notepad is open.')
  assert.deepEqual(asked.map((a) => a[0]), ['SCREEN', 'CAM'])
  assert.match(asked[0][1], /What app is open\?/)
  const blind = tools({ ask, screen: async () => ({}) })
  assert.equal((await blind.look_through_camera({})).isError, true)
  const broken = tools({ ask, camera: async () => { throw new Error('denied') } })
  assert.match(said(await broken.look_through_camera({})), /didn't give a picture: denied/)
})

test('a screenshot from another tool is described in words; a failed description leaves the note', async () => {
  const raw = { content: [{ type: 'image', data: 'X', mimeType: 'image/jpeg' }, { type: 'text', text: 'Sent to your phone.' }] }
  const result = { text: '[an image, shown on screen]\nSent to your phone.', isError: false, raw }
  const out = await describeImages(result, 'what does the error say?', { ask: async ({ question }) => {
    assert.match(question, /what does the error say\?/)
    return 'A dialog: "File not found".'
  } })
  assert.equal(out.text, '[the picture shows: A dialog: "File not found".]\nSent to your phone.')
  const kept = await describeImages(result, 'x', { ask: async () => { throw new Error('down') } })
  assert.equal(kept.text, '[an image, shown on screen]\nSent to your phone.')
  const plain = { text: 'hi', raw: { content: [{ type: 'text', text: 'hi' }] } }
  assert.equal(await describeImages(plain, 'x', { ask: async () => assert.fail('asked') }), plain)
})

test("the gate lets Gnosis's eyes run", () => {
  const gate = createGate({ allowWrites: false })
  for (const t of ['look_at_screen', 'look_through_camera', 'vision_click']) {
    assert.equal(gate.decide(`mcp__ayra_vision__${t}`), true, t)
  }
})

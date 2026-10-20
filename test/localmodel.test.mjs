/** The on-laptop model for private requests (bridge/localmodel.mjs), with a fake llama-server. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { serverCommand, createLocalModel } from '../bridge/localmodel.mjs'

const cfg = (server) => ({
  providers: { local: { baseUrl: 'http://127.0.0.1:8081/v1' } },
  roles: { local: { model: 'nemotron-nano-local', server } },
})

test('the command line: model, port, template, context and GPU layers; missing files are said plainly', () => {
  assert.match(serverCommand(cfg(null)).error, /not set up/)
  assert.match(serverCommand(cfg({ exe: 'C:/nope/llama-server.exe', model: 'C:/nope/m.gguf' })).error, /files are missing: C:\/nope\/llama-server\.exe, C:\/nope\/m\.gguf/)
  const here = process.execPath // a file that exists, standing in for the real ones
  const c = serverCommand(cfg({ exe: here, model: here, template: here, context: 4096, gpuLayers: 99 }))
  assert.equal(c.exe, here)
  assert.deepEqual(c.args, ['-m', here, '--port', '8081', '--host', '127.0.0.1', '--jinja', '-c', '4096', '-np', '1',
    '--alias', 'nemotron-nano-local', '--chat-template-file', here, '-ngl', '99'])
})

test('started once when first needed, ready when it answers its health check; already running, left alone', async () => {
  let up = false
  let starts = 0
  const proc = Object.assign(new EventEmitter(), { kill() {} })
  const local = createLocalModel({
    health: async () => up,
    start: () => {
      starts++
      setTimeout(() => { up = true }, 30)
      return proc
    },
    command: () => ({ exe: 'llama-server', args: [] }),
    log: () => {},
  })
  assert.equal(await local.state(), 'off')
  const [a, b] = await Promise.all([local.ensure(), local.ensure()])
  assert.deepEqual([a, b, starts], [true, true, 1], 'two requests at once start it once')
  assert.equal(await local.state(), 'running')
  await local.ensure()
  assert.equal(starts, 1)
  local.stop()
})

test('not set up, or stopping while starting, or too slow: a plain error, never the cloud', async () => {
  const missing = createLocalModel({ health: async () => false, command: () => ({ error: 'the private model is not set up' }), log: () => {} })
  assert.equal(missing.available(), false)
  await assert.rejects(missing.ensure(), /not set up/)
  const proc = Object.assign(new EventEmitter(), { kill() {} })
  const dies = createLocalModel({ health: async () => false, command: () => ({ exe: 'x', args: [] }), log: () => {},
    start: () => (setTimeout(() => proc.emit('exit', 1), 10), proc) })
  await assert.rejects(dies.ensure(), /stopped while starting/)
  const slow = createLocalModel({ health: async () => false, command: () => ({ exe: 'x', args: [] }), log: () => {},
    start: () => Object.assign(new EventEmitter(), { kill() {} }), readyTimeoutMs: 50 })
  await assert.rejects(slow.ensure(), /took too long/)
})

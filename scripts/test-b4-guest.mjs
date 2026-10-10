#!/usr/bin/env node
/** Guest cancellation and stale callback probes using actual kernel modules and controlled async transport. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { webcrypto } from 'node:crypto'

import {fixture, drain} from './fixtures/guest-lifecycle.mjs'
const source = name => readFileSync(new URL('../online-kernel/src/' + name + '.js', import.meta.url), 'utf8')
let passed = 0, failed = 0
async function test(label, fn) { try { await fn(); passed++; console.log('  ✓ ' + label) } catch (e) { failed++; console.error('  ✗ ' + label + ': ' + e.message) } }
await test('old offer rejection cannot reset the next session', async () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); const old = k.pcs[0]
  api.cancelJoin(); api.joinByRoomCode('BCD234'); const current = k.nnk.state.guest.session
  old.offer.reject(new Error('late reject')); await drain()
  assert.equal(k.nnk.state.guest.session, current); assert.equal(current.pc.closed, 0)
})
await test('old successful offer cannot create local description or MQTT after cancellation', async () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); const old = k.pcs[0]; api.cancelJoin()
  old.offer.resolve({ type: 'offer', sdp: 'old' }); await drain()
  assert.equal(old.locals, 0); assert.equal(k.signals.length, 0)
})
await test('cached old ICE callback cannot close or report failure for the next session', () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); const pc = k.pcs[0], callback = pc.onconnectionstatechange
  api.cancelJoin(); api.joinByRoomCode('BCD234'); const current = k.nnk.state.guest.session, count = k.events.length
  pc.connectionState = 'failed'; callback()
  assert.equal(k.nnk.state.guest.session, current); assert.equal(current.pc.closed, 0); assert.equal(k.events.length, count)
})
await test('late MQTT session is ended and cannot publish or change the next session', async () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); k.pcs[0].offer.resolve({}); await drain()
  const old = k.signals[0]; assert.ok(old)
  api.cancelJoin(); api.joinByRoomCode('BCD234'); const current = k.nnk.state.guest.session
  old.cb('ABC234/host', { ts: 1 }); old.resolve(old.session); await drain()
  assert.equal(old.ended, 1); assert.equal(old.publishes, 0); assert.equal(k.nnk.state.guest.session, current)
})
await test('synchronous PC close invalidates ownership before down hooks can start rejoin', async () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); const pc = k.pcs[0], channel = pc.channels[0]
  channel.readyState = 'open'; channel.onopen(); channel.onmessage({ data: JSON.stringify({ nnk_stage: 'lobby' }) })
  api.cancelJoin(); await drain()
  assert.equal(k.nnk.state.guest.session, null); assert.equal(k.nnk.state.guest.rejoinCode, null)
  assert.equal(k.timers.size, 0); assert.equal(k.pcs.length, 1)
})
await test('invitation cancellation removes timers and stale datachannel cannot revive resources', async () => {
  const k = fixture(), api = k.nnk.modules.guest
  const code = k.nnk.modules.rtc.encodeCode('offer', { type: 'offer', sdp: 'fixture' })
  api.joinByInvite(code); const pc = k.pcs[0], callback = pc.ondatachannel
  api.cancelJoin(); const channel = pc.createDataChannel('nnk-ping'); callback({ channel }); channel.onopen?.()
  pc.remote.resolve(); await drain()
  assert.equal(channel.readyState, 'closed'); assert.equal(k.timers.size, 0)
  assert.ok(!k.events.some(e => e.type === 'answer_ready'))
})
await test('blocked new join does not tear down an existing engine connection', () => {
  const k = fixture(), api = k.nnk.modules.guest
  api.joinByRoomCode('ABC234'); const current = k.nnk.state.guest.session
  k.nnk.env.game.online = true; api.joinByInvite('bad')
  assert.equal(k.nnk.state.guest.session, current); assert.equal(current.pc.closed, 0)
})
await test('native exit still runs and clears rejoin ownership', () => {
  const k = fixture(); k.nnk.modules.guest.joinByRoomCode('ABC234'); k.nnk.env.ui.click.exit()
  assert.equal(k.stats().exits, 1); assert.equal(k.nnk.state.guest.session, null)
})
await test('late saveConfig callback cannot reload after cancel during connect boot', () => {
  const k = fixture(); let saved
  k.nnk.env._status.connectMode = false
  k.nnk.env.game.saveConfig = (a, b, c, cb) => { saved = cb }
  k.nnk.modules.guest.joinByRoomCode('ABC234'); k.nnk.modules.guest.cancelJoin(); saved()
  assert.equal(k.stats().reloads, 0); assert.equal(k.timers.size, 0)
})
await test('normal engine close still delivers its callback once despite owner cleanup', () => {
  const k = fixture(), api = k.nnk.modules.guest
  k.nnk.env.lib.element.ws.onopen = function() { k.nnk.env._status.connectCallback(true) }
  api.joinByRoomCode('ABC234'); const pc = k.pcs[0], channel = pc.channels[0]
  channel.readyState = 'open'; channel.onopen(); channel.onmessage({ data: JSON.stringify({ nnk_stage: 'loaded' }) })
  const oldFake = k.nnk.env.game.ws
  oldFake.close(); assert.equal(k.stats().nativeCloses, 1); assert.equal(pc.closed, 1)
  assert.equal(oldFake._disposed, true); api.cancelJoin(); assert.equal(k.timers.size, 0)
})
await test('ICE gathering cancellation removes the listener and timer', async () => {
  const k = fixture(); runInNewContext(source('rtc'), k.context)
  const listeners = new Set(), controller = new AbortController()
  const pc = { iceGatheringState: 'gathering', addEventListener: (event, fn) => listeners.add(fn), removeEventListener: (event, fn) => listeners.delete(fn) }
  const promise = k.nnk.modules.rtc.waitGather(pc, controller.signal)
  controller.abort(); await assert.rejects(promise, e => e.name === 'AbortError')
  assert.equal(listeners.size, 0); assert.equal(k.timers.size, 0)
})
function signalFixture() {
  const timers = new Map(); let id = 0, client
  const nnk = { modules: { config: { get: () => '' } } }
  const context = { window: { __nnk__: nnk, mqtt: { connect: () => {
    client = new EventEmitter(); client.ends = 0; client.sends = 0
    client.subscribe = () => {}; client.publish = () => client.sends++; client.end = () => client.ends++
    return client
  } } }, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    setTimeout: fn => { timers.set(++id, fn); return id }, clearTimeout: id => timers.delete(id), console,
  }
  runInNewContext(source('signaling'), context)
  return { nnk, timers, client: () => client }
}
await test('MQTT cancellation before crypto completion creates no client', async () => {
  const k = signalFixture(), controller = new AbortController()
  const promise = k.nnk.modules.signaling.openRoomSession('ABC234', 'guest', [], () => {}, controller.signal)
  controller.abort(); await assert.rejects(promise, e => e.name === 'AbortError')
  assert.equal(k.client(), undefined); assert.equal(k.timers.size, 0)
})
await test('MQTT pending cancellation ends transport and removes timers/listeners', async () => {
  const k = signalFixture(), controller = new AbortController()
  const promise = k.nnk.modules.signaling.openRoomSession('ABC234', 'guest', [], () => {}, controller.signal)
  for (let i = 0; i < 200 && !k.client(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(k.client()); controller.abort(); await assert.rejects(promise, e => e.name === 'AbortError')
  assert.equal(k.client().ends, 1); assert.equal(k.client().eventNames().length, 0); assert.equal(k.timers.size, 0)
})
await test('MQTT abort during encryption prevents sending and ends only once', async () => {
  const k = signalFixture(), controller = new AbortController()
  const promise = k.nnk.modules.signaling.openRoomSession('ABC234', 'guest', [], () => {}, controller.signal)
  for (let i = 0; i < 200 && !k.client(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(k.client()); k.client().emit('connect'); const session = await promise
  const publishing = session.publish('topic', { value: 'fixture' }); controller.abort()
  await assert.rejects(publishing, e => e.name === 'AbortError'); session.end()
  assert.equal(k.client().sends, 0); assert.equal(k.client().ends, 1); assert.equal(k.timers.size, 0)
})
console.log(`全部通过:${passed} 项; 失败:${failed}`)
if (failed) process.exitCode = 1

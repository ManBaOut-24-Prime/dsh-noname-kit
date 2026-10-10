#!/usr/bin/env node
import assert from 'node:assert/strict'
import { fixture, drain } from './fixtures/guest-lifecycle.mjs'

let passed = 0, failed = 0
async function test(label, fn) { try { await fn(); passed++; console.log('  ✓ ' + label) } catch (error) { failed++; console.error('  ✗ ' + label + ': ' + error.message) } }
function enter(k, stage = 'lobby', kind = 'room') {
  k.nnk.env.lib.element.ws.onopen = function() { k.nnk.env._status.connectCallback(true) }
  if (kind === 'invite') k.nnk.modules.guest.joinByInvite(k.nnk.modules.rtc.encodeCode('offer', {type:'offer',sdp:'fixture'}))
  else k.nnk.modules.guest.joinByRoomCode('ABC234')
  const session = k.nnk.state.guest.session
  if (kind === 'invite') for (const label of ['nnk-link','nnk-ping']) { const channel = session.pc.createDataChannel(label); session.pc.ondatachannel({channel}) }
  const [main, ping] = session.pc.channels
  main.readyState = ping.readyState = 'open'; main.onopen(); ping.onopen()
  main.onmessage({ data: JSON.stringify({ nnk_stage: stage, code:'ABC234' }) })
  return session
}
function fire(k, ms) { for (const [id, timer] of [...k.timers]) if (timer.ms === ms) { k.timers.delete(id); timer.fn() } }
async function waiting(k) {
  k.nnk.modules.guest.joinByRoomCode('ABC234'); const session = k.nnk.state.guest.session
  session.pc.offer.resolve({}); await drain(); const signal = k.signals[0]
  signal.cb('ABC234/host', { ts: 1 }); signal.resolve(signal.session); await drain()
  session.pc.remoteCalls = 0
  session.pc.setRemoteDescription = () => { session.pc.remoteCalls++; return session.pc.remote.promise }
  return { session, signal, answer: () => signal.cb('ABC234/answer/g', { sdp: { type: 'answer', sdp: 'fixture' } }) }
}
await test('explicit exit saves configuration before the only reload', () => {
  const saved = []
  const k = fixture({ prepare(nnk) {
    nnk.env.game.reload = () => { nnk.env._status.reloading = true }
    nnk.env.game.saveConfig = key => { if (!nnk.env._status.reloading) saved.push(key) }
    nnk.env.lib.element.ws.onclose = function() { if (nnk.env.game.online && !this._nocallback) nnk.env.game.reload() }
    nnk.env.ui.click.exit = () => { nnk.env.game.saveConfig('reconnect_info'); nnk.env.game.saveConfig('tmp_user_roomId'); nnk.env.game.reload() }
  } })
  const session = enter(k, 'loaded'); k.nnk.env.game.online = true; k.nnk.env.ui.click.exit()
  assert.deepEqual(saved, ['reconnect_info', 'tmp_user_roomId'])
  assert.equal(session.disposed, true); assert.equal(session.pc.closed, 1); assert.equal(k.timers.size, 0)
  assert.equal(k.nnk.state.guest.rejoinCode, null)
})
const orders = [['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']]
for (const stage of ['lobby', 'loaded']) for (const order of orders) await test(stage + ' disconnect order ' + order.join('/'), () => {
  const k = fixture(), session = enter(k, stage), [main, ping] = session.pc.channels
  const ice = session.pc.onconnectionstatechange
  for (const event of order) { if (event === 'ice') { session.pc.connectionState = 'failed'; ice() } else (event === 'main' ? main : ping).close() }
  assert.equal(session.disposed, true); assert.equal(session.pc.closed, 1)
  assert.equal(k.pcs.length, 2, 'exactly one recovery attempt')
  assert.equal(k.nnk.state.guest.rejoinCode, 'ABC234')
  assert.equal(k.stats().nativeCloses, stage === 'loaded' ? 1 : 0)
  k.nnk.modules.guest.cancelJoin(); assert.equal(k.timers.size, 0)
})
for (const stage of ['lobby','loaded']) for (const order of orders) await test('invite ' + stage + ' disconnect order ' + order.join('/'), () => {
  const k=fixture(),session=enter(k,stage,'invite'),[main,ping]=session.pc.channels,ice=session.pc.onconnectionstatechange
  for(const event of order) { if(event==='ice'){session.pc.connectionState='failed';ice()}else(event==='main'?main:ping).close() }
  assert.equal(session.disposed,true);assert.equal(session.pc.closed,1);assert.equal(k.pcs.length,2)
  assert.equal(k.stats().nativeCloses,stage==='loaded'?1:0);k.nnk.modules.guest.cancelJoin();assert.equal(k.timers.size,0)
})
for (const ending of ['cancel', 'closed']) for (const order of orders) await test(ending + ' prevents recovery before ' + order.join('/'), () => {
  const k = fixture(), session = enter(k), [main,ping] = session.pc.channels, ice = session.pc.onconnectionstatechange
  if (ending === 'cancel') k.nnk.modules.guest.cancelJoin()
  else main.onmessage({ data: JSON.stringify({ nnk_stage: 'closed' }) })
  for (const event of order) { if (event === 'ice') { session.pc.connectionState='failed'; ice() } else (event === 'main' ? main : ping).close() }
  assert.equal(k.pcs.length, 1); assert.equal(k.nnk.state.guest.rejoinCode, null); assert.equal(k.timers.size, 0)
})
await test('recovery exhaustion stops after eight attempts and clears resources', async () => {
  const k = fixture(), session = enter(k)
  session.pc.connectionState = 'failed'; session.pc.onconnectionstatechange()
  for (let i = 0; i < 8; i++) { k.nnk.state.guest.session.pc.offer.reject(new Error('fixture failure')); await drain(); fire(k,4000) }
  assert.equal(k.pcs.length,9); assert.equal(k.nnk.state.guest.session,null); assert.equal(k.nnk.state.guest.rejoinCode,null); assert.equal(k.timers.size,0)
})
await test('SDP failure ends PC and MQTT and rejects repeated or late answers', async () => {
  const k = fixture(), {session,signal,answer} = await waiting(k)
  answer(); answer(); await drain(); assert.equal(session.pc.remoteCalls,1)
  session.pc.remote.reject(new Error('invalid SDP')); await drain()
  assert.equal(session.disposed,true); assert.equal(session.pc.closed,1); assert.equal(signal.ended,1); assert.equal(k.timers.size,0)
  answer(); assert.equal(session.pc.remoteCalls,1)
})
await test('successful SDP application ignores duplicates and answer timeout', async () => {
  const k = fixture(), {session,answer} = await waiting(k)
  answer(); answer(); session.pc.remote.resolve(); await drain(); answer(); fire(k,30000)
  assert.equal(session.pc.remoteCalls,1); assert.equal(session.pc.closed,0); assert.equal(k.nnk.state.guest.session,session)
  k.nnk.modules.guest.cancelJoin(); assert.equal(k.timers.size,0)
})
await test('pending SDP is bounded by timeout and late completion cannot revive it', async () => {
  const k = fixture(), {session,signal,answer} = await waiting(k)
  answer(); fire(k,30000); assert.equal(session.disposed,true); assert.equal(session.pc.closed,1); assert.equal(signal.ended,1)
  session.pc.remote.resolve(); await drain(); answer(); assert.equal(k.nnk.state.guest.session,null); assert.equal(k.timers.size,0)
})
for (const outcome of ['resolve','reject']) await test('cancel/new join isolates old SDP ' + outcome, async () => {
  const k = fixture(), {session,signal,answer} = await waiting(k); answer(); await drain()
  k.nnk.modules.guest.cancelJoin(); k.nnk.modules.guest.joinByRoomCode('BCD234'); const current = k.nnk.state.guest.session
  session.pc.remote[outcome](new Error('late')); await drain(); answer(); fire(k,30000)
  assert.equal(k.nnk.state.guest.session,current); assert.equal(current.pc.closed,0); assert.equal(signal.ended,1)
  k.nnk.modules.guest.cancelJoin(); assert.equal(k.timers.size,0)
})
await test('no SDP answer times out and closes all attempt resources', async () => {
  const k = fixture(), {session,signal} = await waiting(k); fire(k,30000)
  assert.equal(session.disposed,true); assert.equal(signal.ended,1); assert.equal(k.timers.size,0)
})
await test('synchronous SDP application throw is contained and ends the attempt', async () => {
  const k = fixture(), {session,signal,answer} = await waiting(k)
  session.pc.setRemoteDescription = () => { throw new Error('synchronous SDP failure') }; answer(); await drain()
  assert.equal(session.disposed,true); assert.equal(signal.ended,1); assert.equal(k.timers.size,0)
})
await test('cancel before scheduled SDP application prevents the operation', async () => {
  const k = fixture(), {session,signal,answer} = await waiting(k)
  answer(); k.nnk.modules.guest.cancelJoin(); await drain()
  assert.equal(session.pc.remoteCalls,0); assert.equal(signal.ended,1); assert.equal(k.timers.size,0)
})
console.log(`全部通过:${passed} 项; 失败:${failed}`)
if (failed) process.exitCode = 1

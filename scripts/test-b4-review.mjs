#!/usr/bin/env node
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {fixture,deferred,drain,until,runCases,source,enter} from './fixtures/keepalive-lifecycle.mjs';
const cases=[],test=(name,fn)=>cases.push([name,fn]),orders=[['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']];
test('native exit remains existing behavior and saves before its existing reload',()=>{
 const saved=[],nnk={modules:{},env:{ui:{click:{}},game:{reload(){this.reloading=true;},saveConfig(key){assert.equal(this.reloading,undefined);saved.push(key);}}}};
 const exit=()=>{nnk.env.game.saveConfig('reconnect_info');nnk.env.game.saveConfig('tmp_user_roomId');nnk.env.game.reload();};nnk.env.ui.click.exit=exit;runInNewContext(source('guest'),{window:{__nnk__:nnk}});assert.equal(nnk.env.ui.click.exit,exit);exit();assert.deepEqual(saved,['reconnect_info','tmp_user_roomId']);
});
for(const method of ['invite','room'])for(const stage of ['queued','entered'])for(const order of orders)test(method+' '+stage+' native-fixture terminal order '+order.join('/'),async()=>{
 const f=fixture();try{const p=await f.pair({method});if(stage==='entered')enter(p.gs,p.guestRecord,p.guest);const cached=p.guest.pc.onconnectionstatechange;
  for(const event of order){if(event==='ice'){p.guest.pc.connectionState='failed';cached();}else(event==='main'?p.guest.link:p.guest.ping).close();}await drain();
  assert.equal(p.guest.stopped,true);assert.equal(p.guest.pc.closed,1);assert.equal(p.guest.snapshot().stopEvents,1);assert.equal(p.guest.snapshot().negotiations,1);assert.equal(p.guest.snapshot().reconnectAttempts,0);assert.equal(f.pcs.length,2);assert.equal(p.gs.list().length,0);assert.equal(p.g.resourceSnapshot().pendingInitialOperations,0);
 }finally{await f.close();}
});
for(const ending of ['guest-cancel','public-lobby-close'])for(const order of orders)test(ending+' before terminal callbacks '+order.join('/')+' cannot rejoin',async()=>{
 const f=fixture();try{const p=await f.pair(),cached=p.guest.pc.onconnectionstatechange;if(ending==='guest-cancel')f.lobby({connector:p.g,sessions:p.gs}).cancelJoin();else p.gs.closeOnlyNeverEntered('public lobby closed');
  for(const event of order){if(event==='ice'){p.guest.pc.connectionState='failed';cached();}else(event==='main'?p.guest.link:p.guest.ping).close();}await drain();assert.equal(p.guest.pc.closed,1);assert.equal(p.guest.snapshot().stopEvents,1);assert.equal(p.guest.snapshot().reconnectAttempts,0);assert.equal(f.pcs.length,2);
 }finally{await f.close();}
});
test('former eight-retry recovery is replaced by one actual failed terminal with zero reconnect',async()=>{
 const f=fixture();try{const p=await f.pair();p.guest.pc.fail();for(let i=0;i<8;i++)f.timers.fire(4000);await drain();assert.equal(f.pcs.length,2);assert.equal(p.guest.snapshot().stopEvents,1);assert.equal(p.guest.snapshot().negotiations,1);assert.equal(p.guest.snapshot().reconnectAttempts,0);await assert.rejects(p.guest.createOffer(),/stopped/);}finally{await f.close();}
});
async function waiting(f,{remoteGate,remoteThrow}={}){
 const presence=await f.signaling.openRoomSession('ABC234','presence',[],()=>{});await presence.publish('ABC234/host',{ts:Date.now()},true);f.plans.push({remoteGate,remoteThrow});const controller=new AbortController(),g=f.connector({limits:{roomReadyMs:90}}),pending=g.joinRoom({code:'ABC234',signal:controller.signal});
 await until(()=>[...f.timers.timers.values()].some(t=>t.ms===40));f.timers.fire(40);const attempt=await pending,session=[...f.brokerSessions].find(s=>s.role.startsWith('guest-'));const answer=()=>session.callback('ABC234/answer/000001',{sdp:{type:'answer',sdp:'fixture:999'},hosts:[]});return {g,attempt,session,answer,controller,pc:f.pcs[0],presence};
}
test('SDP rejection ends actual PC/MQTT and rejects duplicates/late answers',async()=>{
 const f=fixture(),d=deferred();try{const k=await waiting(f,{remoteGate:d});k.answer();k.answer();await until(()=>k.pc.remotes===1);d.reject(Error('invalid SDP'));await assert.rejects(k.attempt.readyPromise);await drain();assert.equal(k.pc.closed,1);assert.equal(k.session.ended,1);k.answer();await drain();assert.equal(k.pc.remotes,1);assert.equal(k.g.resourceSnapshot().pendingInitialOperations,0);}finally{d.resolve();await f.close();}
});
test('actual capability-ready adoption clears old answer timeout and duplicate answer cannot reapply',async()=>{
 const f=fixture();try{const p=await f.pair();await assert.rejects(p.invitation.acceptAnswer(p.join.answerText),/selected/);const identity=p.host.actualIdentity();f.timers.fire(45000);f.timers.fire(180000);await drain();assert.equal(p.host.stopped,false);assert.deepEqual(p.host.actualIdentity(),identity);assert.equal(p.host.pc.remotes,1);assert.equal(p.h.resourceSnapshot().attemptTimers,0);}finally{await f.close();}
});
test('pending room SDP expires while native promise stays honestly retired until completion',async()=>{
 const f=fixture(),d=deferred();try{const k=await waiting(f,{remoteGate:d});k.answer();await until(()=>k.pc.remotes===1);f.timers.fire(90);await assert.rejects(k.attempt.readyPromise,/deadline/);assert.equal(k.pc.closed,1);assert.equal(k.session.ended,1);assert.equal(k.g.resourceSnapshot().retiredPending,1);d.resolve();await drain();k.answer();await drain();assert.equal(k.pc.remotes,1);assert.equal(k.g.resourceSnapshot().retiredPending,0);}finally{d.resolve();await f.close();}
});
for(const outcome of ['resolve','reject'])test('cancel/new user join isolates old SDP '+outcome,async()=>{
 const f=fixture(),d=deferred();let next;try{const k=await waiting(f,{remoteGate:d});k.answer();await until(()=>k.pc.remotes===1);k.controller.abort();const controller=new AbortController();next=k.g.joinRoom({code:'BCD234',signal:controller.signal}).catch(e=>e);await until(()=>f.pcs.length===2);
  outcome==='resolve'?d.resolve():d.reject(Error('late rejected SDP'));await drain();assert.equal(f.pcs[1].closed,0);assert.equal(k.session.ended,1);assert.equal(f.owners[1].stopped,false);controller.abort();await next;
 }finally{d.resolve();await f.close();await next;}
});
test('no answer expires initial room resources without inventing another PC',async()=>{
 const f=fixture();try{const k=await waiting(f);f.timers.fire(90);await assert.rejects(k.attempt.readyPromise,/deadline/);assert.equal(k.pc.closed,1);assert.equal(k.session.ended,1);assert.equal(k.g.resourceSnapshot().activeAttempts,0);assert.equal(f.pcs.length,1);}finally{await f.close();}
});
test('synchronous native SDP throw is contained by current connector',async()=>{
 const f=fixture();try{const k=await waiting(f);k.pc.setRemoteDescription=()=>{throw Error('synchronous SDP failure');};k.answer();await assert.rejects(k.attempt.readyPromise);await drain();assert.equal(k.pc.closed,1);assert.equal(k.session.ended,1);assert.equal(k.g.resourceSnapshot().pendingInitialOperations,0);}finally{await f.close();}
});
test('cancel before scheduled answer application prevents native SDP call',async()=>{
 const f=fixture();try{const k=await waiting(f);k.answer();k.controller.abort();await drain();assert.equal(k.pc.remotes,0);assert.equal(k.session.ended,1);assert.equal(k.pc.closed,1);}finally{await f.close();}
});
await runCases(cases);

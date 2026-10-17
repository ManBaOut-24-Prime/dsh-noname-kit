#!/usr/bin/env node
// Current keepalive modules; controlled asynchronous transport, not native ICE.
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {webcrypto} from 'node:crypto';
import {fixture,deferred,drain,until,runCases,source,enter,createEngineOperationPort} from './fixtures/keepalive-lifecycle.mjs';
const cases=[];const test=(name,fn)=>cases.push([name,fn]);
for(const outcome of ['resolve','reject'])test('old cancelled offer '+outcome+' cannot affect a new user initial attempt',async()=>{
 const f=fixture(),old=deferred(),a=new AbortController(),b=new AbortController();let first,next;
 try{f.plans.push({offerGate:old});const g=f.connector();first=g.joinRoom({code:'ABC234',signal:a.signal}).catch(e=>e);await until(()=>f.pcs[0]?.offers===1);a.abort();next=g.joinRoom({code:'BCD234',signal:b.signal}).catch(e=>e);await until(()=>f.pcs.length===2);
  const current=f.owners[1];outcome==='resolve'?old.resolve({type:'offer',sdp:'fixture:1'}):old.reject(Error('late old offer'));await first;await drain();assert.equal(f.pcs[0].locals,0);assert.equal(current.stopped,false);assert.equal(current.actualIdentity().pc,f.pcs[1]);
 }finally{a.abort();b.abort();old.resolve({type:'offer',sdp:'fixture:1'});await f.close();await first;await next;}
});
test('cached old failed callback cannot close a new initial Owner',async()=>{
 const f=fixture(),old=deferred(),a=new AbortController(),b=new AbortController();let first,next;
 try{f.plans.push({offerGate:old});const g=f.connector();first=g.joinRoom({code:'ABC234',signal:a.signal}).catch(e=>e);await until(()=>f.pcs[0]);const callback=f.pcs[0].onconnectionstatechange;a.abort();next=g.joinRoom({code:'BCD234',signal:b.signal}).catch(e=>e);await until(()=>f.pcs.length===2);
  f.pcs[0].connectionState='failed';callback();assert.equal(f.pcs[1].closed,0);assert.equal(f.owners[1].stopped,false);assert.equal(f.owners[0].snapshot().reconnectAttempts,0);
 }finally{a.abort();b.abort();old.resolve({type:'offer',sdp:'fixture:1'});await f.close();await first;await next;}
});
test('late old MQTT client closes without publishing into a new attempt',async()=>{
 const f=fixture(),opening=deferred(),a=new AbortController(),b=new AbortController();let first,next,started=0,ended=0,published=0;
 try{const g=f.connector({signaling:{...f.signaling,openRoomSession(){started++;return started===1?opening.promise:Promise.reject(Error('new fixture terminal'));}}});first=g.joinRoom({code:'ABC234',signal:a.signal}).catch(e=>e);await until(()=>started===1);a.abort();next=g.joinRoom({code:'BCD234',signal:b.signal}).catch(e=>e);await until(()=>f.pcs.length===2);
  opening.resolve({end(){ended++;},async publish(){published++;}});await first;await next;await drain();assert.equal(ended,1);assert.equal(published,0);assert.equal(g.resourceSnapshot().retiredPending,0);assert.equal(f.pcs.length,2);
 }finally{a.abort();b.abort();opening.resolve({end(){ended++;}});await f.close();await first;await next;}
});
test('native fixture failed stops once and never schedules rejoin',async()=>{
 const f=fixture();try{const p=await f.pair();p.guest.pc.fail();await drain();assert.equal(p.guest.stopped,true);assert.equal(p.guest.pc.closed,1);assert.equal(f.pcs.length,2);assert.equal(p.guest.snapshot().reconnectAttempts,0);assert.equal(p.g.resourceSnapshot().activeAttempts,0);assert.equal(p.gs.list().length,0);}finally{await f.close();}
});
test('cancelled invitation refuses cached late datachannel and answer publication',async()=>{
 const f=fixture(),pending=deferred(),controller=new AbortController();let joined;
 try{const h=f.connector(),invite=await h.makeInvite();f.plans.push({remoteGate:pending});const g=f.connector();let answer=0;joined=g.joinInvite({code:invite.offerText,signal:controller.signal,onAnswerCode:()=>answer++}).catch(e=>e);await until(()=>f.pcs[1]?.remotes===1);
  const cached=f.pcs[1].ondatachannel;controller.abort();const late=new f.Channel('nnk-ping');cached({channel:late});pending.resolve();await joined;await drain();assert.equal(late.readyState,'closed');assert.equal(answer,0);assert.equal(g.resourceSnapshot().retiredPending,0);
 }finally{controller.abort();pending.resolve();await f.close();await joined;}
});
test('new join is refused before tearing down an entered actual Owner',async()=>{
 const f=fixture();try{const p=await f.pair();enter(p.gs,p.guestRecord,p.guest);const identity=p.guest.actualIdentity(),lobby=f.lobby({connector:p.g,sessions:p.gs});await assert.rejects(lobby.joinByInvite('bad'),/原连接/);assert.deepEqual(p.guest.actualIdentity(),identity);assert.equal(p.guest.stopped,false);assert.equal(f.pcs.length,2);}finally{await f.close();}
});
test('existing native exit function is not wrapped by current Guest delegate module',()=>{let exits=0;const exit=()=>exits++,nnk={modules:{},env:{ui:{click:{exit}}}};runInNewContext(source('guest'),{window:{__nnk__:nnk}});assert.equal(nnk.env.ui.click.exit,exit);exit();assert.equal(exits,1);});
test('retired current operation rejects pending save callback and cannot reload a later document',async()=>{
 const f=fixture();let saved,reloads=0;const env={lib:{config:{},db:{}},game:{saveConfig(_k,_v,_l,cb){saved=cb;},getDB(){throw Error('old callback may not read next document');},reload(){reloads++;}},get:{connectNickname:()=>''}},nnk={env,modules:{config:{defaults:{},get:()=>''}}};let current=true;
 const operations=createEngineOperationPort(nnk,{isCurrent:()=>current});try{const pending=operations.execute('set_config',{key:'mqttUrl',value:'wss://fixture.test'});await until(()=>saved);current=false;operations.dispose();await assert.rejects(pending,/Retired/);assert.equal(operations.pendingSnapshot().retiredNativePending,1);saved();await drain();assert.equal(operations.pendingSnapshot().pendingNative,0);assert.equal(reloads,0);}finally{operations.dispose();await f.close();}
});
test('local facade close delivers native callback once while persistent actual PC remains',async()=>{
 const f=fixture();try{const p=await f.pair(),shim=new f.Channel('local-shim'),fake=new f.rtc.FakeWebSocket(shim);let native=0;fake.onclose=()=>native++;shim.open();fake.close();fake.close();assert.equal(native,1);fake.dispose();assert.equal(p.guest.stopped,false);assert.equal(p.guest.pc.closed,0);assert.equal(fake.onmessage,null);}finally{await f.close();}
});
test('actual RTC gather abort removes its own listener and timer',async()=>{
 const f=fixture();try{const listeners=new Set(),controller=new AbortController(),pc={iceGatheringState:'gathering',addEventListener:(_n,fn)=>listeners.add(fn),removeEventListener:(_n,fn)=>listeners.delete(fn)},pending=f.rtc.waitGather(pc,controller.signal);controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(listeners.size,0);assert.equal(f.timers.timers.size,0);}finally{await f.close();}
});
function signalFixture(){const timers=new Map();let id=0,client;const nnk={modules:{config:{get:()=>''}}},context={window:{__nnk__:nnk,mqtt:{connect(){client=new EventEmitter();client.ends=0;client.sends=0;client.subscribe=()=>{};client.publish=()=>client.sends++;client.end=()=>client.ends++;return client;}}},crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa,setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id),console};runInNewContext(source('signaling'),context);return {nnk,timers,client:()=>client};}
test('actual MQTT cancellation before crypto completion creates no client',async()=>{const k=signalFixture(),c=new AbortController(),p=k.nnk.modules.signaling.openRoomSession('ABC234','guest',[],()=>{},c.signal);c.abort();await assert.rejects(p,e=>e.name==='AbortError');assert.equal(k.client(),undefined);assert.equal(k.timers.size,0);});
test('actual pending MQTT cancellation removes owned listeners and timer',async()=>{const k=signalFixture(),c=new AbortController(),p=k.nnk.modules.signaling.openRoomSession('ABC234','guest',[],()=>{},c.signal);await until(()=>k.client());c.abort();await assert.rejects(p,e=>e.name==='AbortError');assert.equal(k.client().ends,1);assert.equal(k.client().eventNames().length,0);assert.equal(k.timers.size,0);});
test('actual MQTT abort during AES encryption suppresses publish and ends only once',async()=>{const k=signalFixture(),c=new AbortController(),p=k.nnk.modules.signaling.openRoomSession('ABC234','guest',[],()=>{},c.signal);await until(()=>k.client());k.client().emit('connect');const session=await p,publishing=session.publish('topic',{value:'fixture'});c.abort();await assert.rejects(publishing,e=>e.name==='AbortError');session.end();assert.equal(k.client().sends,0);assert.equal(k.client().ends,1);assert.equal(k.timers.size,0);});
await runCases(cases);

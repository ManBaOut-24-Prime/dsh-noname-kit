#!/usr/bin/env node
// Deterministic unit fixture only: actual InitialConnector/TransportOwner with
// in-memory MQTT/PC/DC and virtual time. No real WebRTC, game, network or physical two-machine coverage.
// Resolve the adjacent lifecycle fixture, or locate it through NNK_SOURCE_ROOT
// when this test runs outside the source tree.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const adjacent=new URL('./fixtures/keepalive-lifecycle.mjs',import.meta.url);
assert.ok(existsSync(adjacent)||process.env.NNK_SOURCE_ROOT,'Missing adjacent fixture; set NNK_SOURCE_ROOT to locate the test source');
const fixtureURL=existsSync(adjacent)?adjacent:pathToFileURL(path.resolve(process.env.NNK_SOURCE_ROOT,'scripts/fixtures/keepalive-lifecycle.mjs'));
const connectorURL=new URL('../../online-kernel/keepalive/initial-connector.js',fixtureURL);
const hashSource=()=>createHash('sha256').update(readFileSync(connectorURL)).digest('hex');
const sourceSHA256=hashSource();
const {fixture,deferred,drain,until,runCases}=await import(fixtureURL.href);
const EPOCH=1700000000000,CODE='ABC234',cases=[],observations=[];
const test=(name,fn)=>cases.push([name,fn]);

// This clock advances Date.now and runs due timers in chronological /
// registration order, including the 40ms poll.
function virtualClock(){
  const saved={setTimeout,clearTimeout,setInterval,clearInterval,now:Date.now};
  let now=EPOCH,nextId=0;
  const timers=new Map();
  function schedule(fn,ms,repeat,args){
    const delay=Math.max(0,Number(ms)||0),id=++nextId;
    timers.set(id,{id,fn:()=>fn(...args),ms:delay,at:now+delay,repeat});return id;
  }
  globalThis.setTimeout=(fn,ms,...args)=>schedule(fn,ms,false,args);
  globalThis.setInterval=(fn,ms,...args)=>{assert.ok(Number(ms)>0);return schedule(fn,ms,true,args);};
  globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
  Date.now=()=>now;
  return {timers,get now(){return now;},
    async to(target){
      assert.ok(Number.isFinite(target)&&target>=now,'Virtual time cannot reverse');
      let calls=0;
      while(true){
        const next=[...timers.values()].filter(t=>t.at<=target).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
        if(!next)break;
        assert.ok(++calls<100000,'Virtual timer bound exceeded');
        now=next.at;
        if(next.repeat)next.at+=next.ms;else timers.delete(next.id);
        next.fn();await drain(1);
      }
      now=target;await drain(4);
    },
    restore(){globalThis.setTimeout=saved.setTimeout;globalThis.clearTimeout=saved.clearTimeout;globalThis.setInterval=saved.setInterval;globalThis.clearInterval=saved.clearInterval;Date.now=saved.now;}
  };
}
async function isolated(fn){
  const clock=virtualClock();let f;
  try{f=fixture({realTimers:true});return await fn(f,clock);}
  finally{try{if(f)await f.close();assert.equal(clock.timers.size,0,'Actual connector cleanup must remove its virtual timers');}finally{clock.restore();}}
}
const roomOffers=f=>f.messages.filter(m=>m.topic===CODE+'/offer');
const hostPresence=f=>f.messages.filter(m=>m.topic===CODE+'/host'&&m.message&&Number.isFinite(m.message.ts));
function track(promise){const value={state:'pending'};promise.then(result=>Object.assign(value,{state:'resolved',result}),error=>Object.assign(value,{state:'rejected',error}));return value;}
async function publication(f,signal){
  const host=f.connector();
  const pub=await host.listenRoom({code:CODE,signal,onOffer(){}});f.publications.push(pub);
  return {host,pub};
}
async function beginGuest(f,clock,{offerMs=0,signal}={}){
  const gate=offerMs?deferred():null;
  if(gate)f.plans.push({offerGate:gate});
  const guest=f.connector(),started=clock.now,outcome=track(guest.joinRoom({code:CODE,signal}));
  assert.equal(guest.limits.roomReadyMs,90000,'Do not change the existing overall handshake deadline');
  await until(()=>f.pcs.length===1&&f.pcs[0].offers===1,'actual room offer started');
  if(gate){
    setTimeout(()=>gate.resolve({type:'offer',sdp:'fixture:'+f.pcs[0].id}),offerMs);
    await clock.to(started+offerMs);
  }
  await until(()=>outcome.state!=='pending'||[...clock.timers.values()].some(t=>t.repeat&&t.ms===40),'actual discovery poll registered');
  assert.equal(outcome.state,'pending');
  assert.ok([...clock.timers.values()].some(t=>!t.repeat&&t.ms===8000),'Discovery must retain its 8000ms timeout');
  const session=[...f.brokerSessions].find(s=>s.role.startsWith('guest-'));
  assert.ok(session,'Actual fixture discovery session required');
  return {guest,started,discoveryStarted:clock.now,outcome,session};
}
function assertRetired(f,guest,session){
  const r=guest.resourceSnapshot();
  assert.equal(r.activeAttempts,0);assert.equal(r.ownOwnerReferences,0);assert.equal(r.attemptTimers,0);assert.equal(r.attemptSessions,0);assert.equal(r.pendingInitialOperations,0);
  assert.equal(session.ended,1);assert.equal(f.pcs.length,1);assert.equal(f.pcs[0].closed,1);
}

// Cover the entire original [0,10000) heartbeat phase at the actual poll's
// 40ms resolution, plus 1ms sides of retained freshness / timeout-poll boundaries.
const phases=[...new Set([...Array.from({length:250},(_,i)=>i*40),999,1000,1001,1999,2000,2001,2039,2040,2041,4999,5000,5001,9999])].sort((a,b)=>a-b);
for(const offerMs of [0,2000])test('full original 10s phase sweep; actual offer latency '+offerMs+'ms',async()=>{
  const failed=[],periods=new Set();
  for(const phase of phases){
    const result=await isolated(async(f,clock)=>{
      await publication(f);
      const heartbeat=[...clock.timers.values()].find(t=>t.repeat);assert.ok(heartbeat);periods.add(heartbeat.ms);
      await clock.to(EPOCH+phase);
      const k=await beginGuest(f,clock,{offerMs});
      await clock.to(k.discoveryStarted+8000);
      assert.equal(f.pcs.length,1,'Discovery must not construct a retry PC');
      const offers=roomOffers(f);
      if(k.outcome.state==='rejected')return {phase,offerMs,error:k.outcome.error.message,offers:offers.length};
      assert.equal(k.outcome.state,'resolved','Join must finish presence discovery inside its unchanged window');
      assert.equal(offers.length,1,'Publish exactly one real fixture room offer');
      assert.equal(k.outcome.result.snapshot().role,'guest');
      return null;
    });
    if(result)failed.push(result);
  }
  const result={kind:'deterministic-phase-sweep',offerMs,phaseRangeMs:[0,10000],phaseEndExclusive:true,stepMs:40,extraExactEdges:true,phaseCases:phases.length,observedHeartbeatIntervalsMs:[...periods],failed};
  observations.push(result);console.log(JSON.stringify(result));
  assert.equal(failed.length,0,'Live Host must be discoverable at every sampled phase; failures: '+JSON.stringify(failed));
});

for(const age of [1000,1001])test('retained timestamp freshness lower boundary: '+age+'ms before join',async()=>isolated(async(f,clock)=>{
  const sender=await f.signaling.openRoomSession(CODE,'fixture-retained-publisher',[],()=>{});
  await sender.publish(CODE+'/host',{ts:clock.now-age},true);
  const k=await beginGuest(f,clock);
  await clock.to(k.discoveryStarted+7999);
  if(age===1000){assert.equal(k.outcome.state,'resolved');assert.equal(roomOffers(f).length,1);}
  else{
    assert.equal(k.outcome.state,'pending');assert.equal(roomOffers(f).length,0);
    await clock.to(k.discoveryStarted+8000);
    assert.equal(k.outcome.state,'rejected');assert.match(k.outcome.error.message,/presence.*8 seconds/);
    assertRetired(f,k.guest,k.session);
  }
}));

test('slow offer cannot reuse retained presence older than the unchanged 30s age bound',async()=>isolated(async(f,clock)=>{
  const sender=await f.signaling.openRoomSession(CODE,'fixture-retained-publisher',[],()=>{});
  await sender.publish(CODE+'/host',{ts:clock.now},true);
  const k=await beginGuest(f,clock,{offerMs:30001});
  await clock.to(k.discoveryStarted+8000);
  assert.equal(k.outcome.state,'rejected');assert.equal(roomOffers(f).length,0);assertRetired(f,k.guest,k.session);
}));

test('guest cancel before a fresh heartbeat retires the owner; late heartbeat cannot publish an offer',async()=>isolated(async(f,clock)=>{
  await publication(f);await clock.to(EPOCH+3000);
  const controller=new AbortController(),k=await beginGuest(f,clock,{signal:controller.signal}),lateCallback=k.session.callback;
  assert.equal(roomOffers(f).length,0);
  controller.abort();await drain();
  assert.equal(k.outcome.state,'rejected');assertRetired(f,k.guest,k.session);
  lateCallback(CODE+'/host',{ts:clock.now});
  await clock.to(EPOCH+14000);
  assert.ok(hostPresence(f).length>1,'Real Host fixture continues publishing');
  assert.equal(roomOffers(f).length,0);assertRetired(f,k.guest,k.session);
}));

test('8000ms discovery timeout remains final even if a captured heartbeat arrives later',async()=>isolated(async(f,clock)=>{
  const k=await beginGuest(f,clock),lateCallback=k.session.callback;
  await clock.to(k.discoveryStarted+7999);assert.equal(k.outcome.state,'pending');assert.equal(roomOffers(f).length,0);
  await clock.to(k.discoveryStarted+8000);assert.equal(k.outcome.state,'rejected');assert.match(k.outcome.error.message,/presence.*8 seconds/);assertRetired(f,k.guest,k.session);
  await clock.to(k.discoveryStarted+8001);lateCallback(CODE+'/host',{ts:clock.now});await drain();
  assert.equal(roomOffers(f).length,0);assertRetired(f,k.guest,k.session);
}));

test('Host publication cancellation clears retained presence; captured interval cannot republish',async()=>isolated(async(f,clock)=>{
  const controller=new AbortController(),{host,pub}=await publication(f,controller.signal);
  const interval=[...clock.timers.values()].find(t=>t.repeat);assert.ok(interval);
  const before=hostPresence(f).length;controller.abort();
  await interval.fn();await drain();
  await clock.to(EPOCH+20000);
  assert.equal(hostPresence(f).length,before);assert.equal(pub.snapshot().closed,true);
  const resources=host.resourceSnapshot();assert.equal(resources.activePublications,0);assert.equal(resources.publicationTimers,0);assert.equal(resources.publicationSessions,0);
  assert.equal(f.messages.filter(m=>m.topic===CODE+'/host'&&m.raw&&m.message==='').length,1,'Submit exactly one actual fixture retained clear');
  const k=await beginGuest(f,clock);await clock.to(k.discoveryStarted+8000);
  assert.equal(k.outcome.state,'rejected','Cleared retained state cannot revive the cancelled publication');assert.equal(roomOffers(f).length,0);assertRetired(f,k.guest,k.session);
}));

console.log(JSON.stringify({kind:'unit-fixture-only',connector:fileURLToPath(connectorURL),sourceSHA256,realWebRTC:false,nativeGame:false,P4Pass:false}));
const result=await runCases(cases);
assert.equal(hashSource(),sourceSHA256,'Connector source changed while this isolated process ran; do not accept a mixed-source result');
console.log(JSON.stringify({kind:'initial-room-presence-unit-summary',sourceSHA256,...result,phaseSweepCases:phases.length*2,observations,realWebRTC:false,nativeGame:false,P4Pass:false}));

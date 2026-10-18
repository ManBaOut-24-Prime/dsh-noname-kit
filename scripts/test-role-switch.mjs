#!/usr/bin/env node
/** Explicit party exit with deterministic PC/DC/discovery and native-retirement fixtures. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixture,CarrierRuntime,deferred,drain,until,enter,runCases} from './fixtures/keepalive-lifecycle.mjs';
globalThis.require=createRequire(import.meta.url);
const cases=[];
const test=(name,fn)=>cases.push([name,fn]);

async function isolated(fn){
 const f=fixture(),runtimes=[];
 const make=(name='Same player',signaling=f.signaling)=>{
  const bridge=f.bridge(),native={onInvalidated:()=>()=>{},snapshot:async()=>({})},ipc={on(){},removeListener(){}},nnk={state:{},modules:{rtc:f.rtc,signaling,bridge}};
  const runtime=new CarrierRuntime({nnk,native,ipc,profile:{config:{onlineName:name,onlineAvatar:'caocao'},identity:{}}});
  const value={runtime,bridge};runtimes.push(value);return value;
 };
 const pair=async(host,guest)=>{
  await host.runtime.createInternetRoom('single','invite');
  const invitation=host.bridge.events.findLast(e=>e.type==='invite_ready').data;
  await guest.runtime.joinByInvite(invitation.code);
  const answer=guest.bridge.events.findLast(e=>e.type==='answer_ready').data.code;
  await host.runtime.acceptAnswer(invitation.id,answer);
  await until(()=>host.runtime.sessions.snapshot().length===1&&guest.runtime.sessions.snapshot().length===1,'actual current registry adoption');
  await drain();
  return {hostRecord:host.runtime.sessions.snapshot()[0],guestRecord:guest.runtime.sessions.snapshot()[0]};
 };
 try{return await fn({f,make,pair,runtimes});}
 finally{
  for(const {runtime}of runtimes){
   runtime.nativeSnapshot=null;runtime.coordinator.round=null;runtime.coordinator.next.committed=null;runtime.coordinator.room.pending=null;
   runtime.engines.current=null;
   try{await runtime.lobby.cancelAll();}catch{}
   for(const record of runtime.sessions.snapshot())runtime.sessions.getOwner(record.peerId)?.stopTransport('fixture cleanup');
   for(const attempt of [...runtime.connector.attempts])attempt.closeUnentered('fixture cleanup');
   runtime.dispose();
  }
  await f.close();
 }
}
const rejected=fn=>assert.rejects(Promise.resolve().then(fn));
function simulatedBinding(runtime){
 const lease={role:'host',partySessionId:'fixture-party',roundId:'fixture-round',operationId:'fixture-operation',operationGeneration:7};
 runtime.coordinator.setRole('host');runtime.coordinator.operationGeneration=7;
 runtime.coordinator.round={...lease,phase:'waiting',failed:false};
 const binding={lease,windowId:107,scope:null,status:{waiting:true},pending:new Map(),closed:false,error:null};runtime.engines.current=binding;return binding;
}

test('changing role without an explicit exit still uses the original role guard',()=>isolated(async({make})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');
 assert.throws(()=>runtime.coordinator.setRole('guest'));
 await rejected(()=>runtime.joinByInvite('invalid'));
 assert.equal(runtime.coordinator.role,'host');assert.equal(runtime.lobby.snapshot().lobbyOpen,true);
}));

test('both roles can reverse only after explicit exit using fresh actual transport identities',()=>isolated(async({make,pair})=>{
 const host=make(),guest=make(),first=await pair(host,guest);
 const oldHost=host.runtime.sessions.getOwner(first.hostRecord.peerId),oldGuest=guest.runtime.sessions.getOwner(first.guestRecord.peerId);
 const oldActual=[oldHost.actualIdentity(),oldGuest.actualIdentity()],oldCoordinators=[host.runtime.coordinator,guest.runtime.coordinator];
 const connector=host.runtime.connector;
 await host.runtime.cancelAll();await guest.runtime.endSession();
 assert.equal(oldHost.stopped,true);assert.equal(oldGuest.stopped,true);
 assert.equal(host.runtime.connector,connector,'Retired initial operations must stay under one connector resource budget');
 assert.notEqual(host.runtime.coordinator,oldCoordinators[0]);assert.notEqual(guest.runtime.coordinator,oldCoordinators[1]);
 assert.equal(oldCoordinators[0].closed,true);assert.equal(oldCoordinators[1].closed,true);
 const second=await pair(guest,host);
 assert.equal(host.runtime.coordinator.role,'guest');assert.equal(guest.runtime.coordinator.role,'host');
 for(const [side,record,previous,index]of [[host,second.guestRecord,first.hostRecord,0],[guest,second.hostRecord,first.guestRecord,1]]){
  const owner=side.runtime.sessions.getOwner(record.peerId),actual=owner.actualIdentity();
  assert.notEqual(record.peerId,previous.peerId);assert.notEqual(record.connectionSessionId,previous.connectionSessionId);
  for(const key of ['pc','link','ping'])assert.notEqual(actual[key],oldActual[index][key]);
  assert.equal(record.entered,false);assert.equal(record.wasEverEntered,false);assert.equal(record.lease,null);
 }
}));

test('explicit waiting-room exit stops even previously entered actual Owners',()=>isolated(async({make,pair})=>{
 const host=make(),guest=make(),records=await pair(host,guest),runtime=host.runtime;
 const owner=runtime.sessions.getOwner(records.hostRecord.peerId),actual=owner.actualIdentity();
 enter(runtime.sessions,records.hostRecord,owner);
 assert.equal(runtime.sessions.hasEnteredConnections(),true);
 const beforeExit=host.bridge.events.length;
 await runtime.endSession();
 assert.equal(host.bridge.events.slice(beforeExit).filter(event=>event.type==='error').length,0,'Explicit exit must not report an old-party broadcast failure');
 assert.equal(owner.stopped,true);assert.equal(actual.pc.closed,1);assert.equal(actual.link.readyState,'closed');assert.equal(actual.ping.readyState,'closed');
 assert.deepEqual(runtime.sessions.snapshot(),[]);assert.equal(runtime.identities.size,0);assert.equal(runtime.engines.current,null);
}));

for(const phase of ['playing','settling'])test('active '+phase+' refuses exit before changing the old party',()=>isolated(async({make,f})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');const coordinator=runtime.coordinator;
 coordinator.round={phase,failed:false};const before=runtime.lobby.snapshot(),sessions=f.brokerSessions.size;
 await rejected(()=>runtime.endSession());
 assert.equal(runtime.coordinator,coordinator);assert.equal(coordinator.closed,false);assert.deepEqual(runtime.lobby.snapshot(),before);
 assert.equal(f.brokerSessions.size,sessions);assert.equal(runtime.leaving===true,false);
}));

for(const kind of ['next','room','native'])test(kind+' committed/native playing evidence protects the current party',()=>isolated(async({make})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');const coordinator=runtime.coordinator;
 if(kind==='next')coordinator.next.committed={plan:{},promise:Promise.resolve()};
 if(kind==='room')coordinator.room.pending={committed:true};
 if(kind==='native')runtime.nativeSnapshot={playing:true};
 await rejected(()=>runtime.endSession());
 assert.equal(runtime.coordinator,coordinator);assert.equal(coordinator.closed,false);assert.equal(runtime.lobby.snapshot().lobbyOpen,true);
}));

test('concurrent exits share retirement and prevent new role operations until close proof',()=>isolated(async({make})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');const old=runtime.coordinator,binding=simulatedBinding(runtime),gate=deferred();let retireCalls=0;
 runtime.engines.retire=async()=>{retireCalls++;await gate.promise;binding.closed=true;runtime.engines.current=null;return {confirmation:{confirmed:true}};};
 const first=runtime.endSession(),second=runtime.endSession();await until(()=>retireCalls===1,'single native retirement started');
 for(const call of [()=>runtime.createInternetRoom('single'),()=>runtime.joinByRoomCode('ABC234'),()=>runtime.joinByInvite('invalid'),()=>runtime.restartRoom('single'),()=>runtime.acceptAnswer(1,'invalid'),()=>runtime.refreshInvite('invite')])await rejected(call);
 assert.equal(runtime.coordinator,old);assert.equal(old.closed,true);assert.equal(runtime.engines.current,binding);
 gate.resolve();await Promise.all([first,second]);assert.equal(retireCalls,1);
 assert.notEqual(runtime.coordinator,old);assert.equal(runtime.engines.current,null);assert.equal(runtime.coordinator.operationGeneration,7);
 await runtime.createInternetRoom('single');assert.equal(runtime.coordinator.role,'host');
}));

test('unconfirmed engine closure keeps role replacement blocked until explicit retry succeeds',()=>isolated(async({make})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');const old=runtime.coordinator,binding=simulatedBinding(runtime);let calls=0;
 runtime.engines.retire=async()=>{if(++calls===1)throw Error('fixture native close not confirmed');binding.closed=true;runtime.engines.current=null;return {confirmation:{confirmed:true}};};
 await assert.rejects(runtime.endSession(),/fixture native close not confirmed/);
 assert.equal(runtime.coordinator,old);assert.equal(runtime.engines.current,binding);assert.equal(runtime.leaving,true);
 await rejected(()=>runtime.joinByInvite('invalid'));await rejected(()=>runtime.createInternetRoom('single'));
 await runtime.endSession();assert.equal(calls,2);assert.notEqual(runtime.coordinator,old);assert.equal(runtime.engines.current,null);
 assert.equal(runtime.coordinator.operationGeneration,7);assert.equal(runtime.leaving,false);
}));

test('explicit exit retires old identity, request, capability, seating and controller timers',()=>isolated(async({make,f})=>{
 const {runtime}=make();await runtime.createInternetRoom('single');const old=runtime.coordinator,owned=[];
 const timeout=()=>{const timer=setTimeout(()=>{throw Error('Retired timer executed');},12345);owned.push(timer);return timer;};
 old.identityPending={timer:timeout()};old.capabilityTimers.set('fixture-peer',timeout());old.members.set('fixture-peer',{timer:timeout()});old.guestRoundTimer=timeout();
 old.requestTimer=setInterval(()=>{throw Error('Retired interval executed');},12345);owned.push(old.requestTimer);
 old.next.timer=timeout();old.room.timer=timeout();old.settlement.timer=timeout();old.identityVersions.set('fixture-peer',{revision:1});
 await runtime.endSession();
 for(const timer of owned)assert.equal(f.timers.timers.has(timer),false);
 assert.equal(old.closed,true);assert.equal(old.identityPending,null);assert.equal(old.identityVersions.size,0);assert.equal(old.members.size,0);assert.equal(old.capabilityTimers.size,0);
 assert.equal(runtime.coordinator.round,null);assert.equal(runtime.coordinator.role,null);
}));

test('late retired offer work stays counted and cannot publish old identity or UI into a new role',()=>isolated(async({make,f})=>{
 const side=make(),gate=deferred();f.plans.push({offerGate:gate});
 const pending=side.runtime.createInternetRoom('single','invite');pending.catch(()=>{});
 await until(()=>f.pcs.length===1&&f.pcs[0].offers===1,'old offer native work started');
 const connector=side.runtime.connector,pc=f.pcs[0];await side.runtime.endSession();
 const resources=connector.resourceSnapshot();assert.equal(resources.activeAttempts,0);assert.equal(resources.retiredPending,1);assert.equal(pc.closed,1);
 const other=make('New host');await other.runtime.createInternetRoom('single','invite');
 const invitation=other.bridge.events.findLast(e=>e.type==='invite_ready').data;
 await side.runtime.joinByInvite(invitation.code);const phase=side.bridge.phases.at(-1),errors=side.bridge.events.filter(e=>e.type==='error').length;
 gate.resolve({type:'offer',sdp:'fixture:'+pc.id});await assert.rejects(pending);await drain();
 assert.equal(side.runtime.connector,connector);assert.equal(connector.resourceSnapshot().retiredPending,0);assert.equal(side.runtime.coordinator.role,'guest');
 assert.equal(side.runtime.sessions.snapshot().length,0);assert.equal(side.bridge.events.filter(e=>e.type==='error').length,errors);assert.deepEqual(side.bridge.phases.at(-1),phase);
}));

test('a late retired publication closes its actual discovery session without reviving the old lobby',()=>isolated(async({make,f})=>{
 const gate=deferred(),base=f.signaling.openRoomSession;let captured=null;
 const signaling={...f.signaling,async openRoomSession(...args){const session=await base(...args);if(args[1]==='host'&&!captured){captured=session;await gate.promise;}return session;}};
 const side=make('Host',signaling),pending=side.runtime.createInternetRoom('single');pending.catch(()=>{});
 await until(()=>captured!==null,'old discovery opening');await side.runtime.endSession();
 const coordinator=side.runtime.coordinator;coordinator.setRole('guest');const phases=side.bridge.phases.length,errors=side.bridge.events.filter(e=>e.type==='error').length;
 gate.resolve();await assert.rejects(pending);await drain();
 assert.equal(captured.ended,1);assert.equal(side.runtime.coordinator,coordinator);assert.equal(side.runtime.coordinator.role,'guest');
 assert.equal(side.runtime.lobby.snapshot().lobbyOpen,false);assert.equal(side.runtime.connector.resourceSnapshot().activePublications,0);
 assert.equal(side.bridge.events.filter(e=>e.type==='error').length,errors);assert.equal(side.bridge.phases.length,phases);
}));

test('a create command awaiting recovery cannot restart after explicit session exit',()=>isolated(async({make,f})=>{
 const {runtime}=make(),gate=deferred();runtime.recovery.maybeRecover=()=>gate.promise;
 const pending=runtime.createInternetRoom('single');pending.catch(()=>{});await drain();
 await runtime.endSession();const coordinator=runtime.coordinator;
 gate.resolve();await assert.rejects(pending);
 assert.equal(runtime.coordinator,coordinator);assert.equal(coordinator.role,null);assert.equal(runtime.lobby.snapshot().lobbyOpen,false);assert.equal(f.brokerSessions.size,0);
}));

test('an old actual registration awaiting recovery cannot assign a role in the fresh party',()=>isolated(async({make,pair})=>{
 const host=make(),guest=make(),records=await pair(host,guest),runtime=host.runtime,gate=deferred();runtime.recovery.maybeRecover=()=>gate.promise;
 const pending=runtime.lobby.onRegistered({...records.hostRecord,role:'host'});pending.catch(()=>{});await drain();
 await runtime.endSession();const coordinator=runtime.coordinator;
 gate.resolve();await assert.rejects(pending);
 assert.equal(runtime.coordinator,coordinator);assert.equal(coordinator.role,null);assert.equal(runtime.sessions.snapshot().length,0);assert.equal(runtime.identities.size,0);
}));

await runCases(cases);

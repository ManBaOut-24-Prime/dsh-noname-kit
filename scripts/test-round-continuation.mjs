// Scalar protocol fixtures; real native continuation must be tested separately.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {RoundContinuation} from '../online-kernel/keepalive/round-continuation.js';
globalThis.require=createRequire(import.meta.url);const D='2'.repeat(64),clone=x=>JSON.parse(JSON.stringify(x));
const scope=id=>({sessionId:'party',roundId:'old',documentGeneration:3,bindingId:'binding-'+id,bindingNonce:'nonce-'+id,expectedOrigin:'http://localhost:8089'});
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('Fixture control not emitted');};
function fixture(){
 const r={partySessionId:'party',roundId:'old',operationId:'old-operation',phase:'plugin-room',mode:'single',settlementReady:false},b=null,out=[],events=[],owners=new Map([['a',{}],['b',{}]]),map=new WeakMap([...owners].map(([id,owner])=>[owner,id]));let loads=0,req=0;
 const c={role:'host',round:r,engines:{current:null,command:async()=>{throw Error('No retired document can be queried from the plugin room');}},continuationCapable:new Set(['a','b']),members:new Map(),live:round=>c.round===round&&!round.failed,
  sessions:{peerForActualOwner:owner=>map.get(owner),isLive:peer=>owners.has(peer),sendControl:(peer,type,data)=>out.push({peer,type,data:clone(data)})},envelope:(round,data)=>({partySessionId:round.partySessionId,roundId:round.roundId,operationId:round.operationId,requestId:'request-'+(++req),...data}),settlement:{ready:()=>c.round===r&&r.phase==='settled'&&r.settlementReady,host:{peers:['a','b'],barrierId:'barrier',revision:1,acks:new Map([['a',{}],['b',{}]])}},publishState:()=>{},onEvent:(name,data)=>events.push({name,data}),
  loadNextHost:async plan=>{loads++;c.round={...plan.lease,phase:'seating'};return c.round;}};
 c.room={receipt:{id:'returned',round:r,complete:true,localScope:scope('host'),hostScope:scope('host'),guestScopes:{a:scope('a'),b:scope('b')},peers:['a','b'],barrierId:'barrier',revision:1,plans:Object.fromEntries(['identity','guozhan','versus','doudizhu','single'].map(mode=>[mode,{mode,admission:true,capacity:3,configDigest:D}]))},available:()=>!!c.room.receipt?.complete&&c.engines.current===null&&c.live(r),ready:()=>c.room.available()&&r.phase==='plugin-room'};
 const n=new RoundContinuation(c);c.next=n;
 const ready=peer=>({type:'next-ready',data:{...c.envelope(r,{protocol:'nnk-next/1'}),planId:n.pending.plan.id,planSignature:n.pending.signature,guestScope:scope(peer),hostGeneration:3,ready:true}});
 return {c,n,r,b,out,events,owners,ready,loads:()=>loads};
}
let count=0;async function test(label,run){await run();count++;console.log('  ✓ '+label);}
await test('Full original roster is prepared from plugin room; one ready cannot create a new document',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>f.out.some(x=>x.type==='next-prepare'));assert.equal(f.out.filter(x=>x.type==='next-prepare').length,2);assert.equal(f.c.engines.current,f.b);assert.equal(f.n.validate(f.owners.get('a'),f.ready('a')),true);await f.n.control(f.owners.get('a'),f.ready('a'));assert.equal(f.loads(),0);await f.n.control(f.owners.get('b'),f.ready('b'));await p;assert.equal(f.loads(),1);assert.equal(f.out.filter(x=>x.type==='next-commit').length,2);assert.notEqual(f.c.round.roundId,'old');}finally{f.n.dispose();}
});
await test('Duplicate clicks share one plan and unique Host commit',async()=>{
 const f=fixture();try{const a=f.n.begin(),b=f.n.begin();await wait(()=>!!f.n.pending?.plan);await f.n.control(f.owners.get('a'),f.ready('a'));const second=f.ready('b');await f.n.control(f.owners.get('b'),second);await Promise.all([a,b]);assert.equal(f.loads(),1);assert.equal(f.out.filter(x=>x.type==='next-prepare').length,2);}finally{f.n.dispose();}
});
await test('Unknown source, old nonce, wrong plan and future generation cannot satisfy readiness',async()=>{
 const f=fixture();try{const p=f.n.begin();p.catch(()=>{});await wait(()=>!!f.n.pending?.plan);const base=f.ready('a');assert.notEqual(f.n.validate({},base),true);for(const patch of [{planId:'other'},{planSignature:D},{guestScope:{...scope('a'),bindingNonce:'old'}},{guestScope:{...scope('a'),documentGeneration:4}},{hostGeneration:4},{ready:false}])assert.notEqual(f.n.validate(f.owners.get('a'),{...base,data:{...base.data,...patch}}),true);f.n.cancel('test cleanup');await assert.rejects(p,/cleanup/);assert.equal(f.loads(),0);}finally{f.n.dispose();}
});
await test('Cancellation stays in plugin room with no old binding or new document',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>f.out.some(x=>x.type==='next-prepare'));f.n.cancel('new output');await assert.rejects(p,/new output/);assert.equal(f.loads(),0);assert.equal(f.c.engines.current,null);assert.equal(f.r.phase,'plugin-room');assert.equal(f.n.snapshot().resources.timers,0);}finally{f.n.dispose();}
});
await test('Configuration changes between prepare and commit cancel the entire plan',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>f.out.some(x=>x.type==='next-prepare'));await f.n.control(f.owners.get('a'),f.ready('a'));f.c.room.receipt.plans.single.configDigest='3'.repeat(64);await f.n.control(f.owners.get('b'),f.ready('b'));await assert.rejects(p,/配置/);assert.equal(f.loads(),0);assert.equal(f.c.engines.current,null);}finally{f.n.dispose();}
});
await test('Missing capability or incomplete return cannot load from settlement',async()=>{
 const f=fixture();try{f.c.continuationCapable.delete('a');await assert.rejects(f.n.begin(),/协议/);f.c.continuationCapable.add('a');f.r.phase='settled';await assert.rejects(f.n.begin(),/返回插件房间/);assert.equal(f.loads(),0);}finally{f.n.dispose();}
});
await test('Mode changes preserve the full original roster and actual capacity rejection keeps old documents',async()=>{
 const f=fixture();try{const p=f.n.begin({mode:'identity'});await wait(()=>!!f.n.pending?.plan);assert.equal(f.n.pending.plan.mode,'identity');assert.deepEqual(f.n.pending.plan.targetPeers,['a','b']);f.n.cancel('mode test complete');await assert.rejects(p,/complete/);
  f.c.room.receipt.plans.single.capacity=2;
  await assert.rejects(f.n.begin({mode:'single'}),/容量/);assert.equal(f.loads(),0);assert.equal(f.c.engines.current,f.b);
 }finally{f.n.dispose();}
});
await test('Lobby preparation cancellation keeps the in-game transport group and rejects late ready',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>!!f.n.pending?.plan);const late=f.ready('a');f.n.cancel('大厅已解散');await assert.rejects(p,/大厅/);assert.notEqual(f.n.validate(f.owners.get('a'),late),true);assert.equal(f.loads(),0);assert.equal(f.c.engines.current,f.b);assert.equal(f.owners.size,2);}finally{f.n.dispose();}
});
await test('Retry requires an actually failed committed round and healthy original peers; only one retry is allowed',async()=>{
 const f=fixture();try{await assert.rejects(f.n.retry(),/不能/);f.n.lastPlan={id:'committed',lease:{partySessionId:'party',roundId:'old',operationId:'old-operation'},mode:'single',configDigest:D,targetPeers:['a','b']};f.r.failed=true;f.r.phase='failed';f.c.loadNextHost=async(plan,_old,retry)=>{assert.equal(retry,true);assert.equal(plan.retryOf,'old');return plan.lease;};const next=await f.n.retry();assert.notEqual(next.roundId,'old');await assert.rejects(f.n.retry(),/不能/);assert.equal(f.n.retryRemaining,0);}finally{f.n.dispose();}
});
await test('Cancel notification failure cannot leave the preparation promise or timer pending',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>f.out.some(x=>x.type==='next-prepare'));f.c.sessions.sendControl=()=>{throw Error('actual sender failed');};assert.equal(f.n.cancel('cancel current prepare'),true);await assert.rejects(p,/cancel current/);assert.equal(f.n.snapshot().resources.timers,0);assert.equal(f.n.pending,null);assert.equal(f.r.phase,'plugin-room');assert.equal(f.events.filter(x=>x.name==='next-cancel-notice-failed').length,2);}finally{f.n.dispose();}
});
await test('Partial commit plus failed cancellation still advances one failed lease for normal cleanup',async()=>{
 const f=fixture();try{const p=f.n.begin();await wait(()=>f.out.some(x=>x.type==='next-prepare'));await f.n.control(f.owners.get('a'),f.ready('a'));const second=f.ready('b'),send=f.c.sessions.sendControl;f.c.sessions.sendControl=(peer,type,data)=>{if(type==='next-cancel'||type==='next-commit'&&peer==='b')throw Error('commit wire failed');return send(peer,type,data);};let failedLease;f.c.loadNextHost=async(plan,old,retry,failure)=>{assert.equal(old,f.r);assert.equal(retry,false);assert.match(failure.message,/commit wire/);failedLease={...plan.lease,failed:true};f.c.round=failedLease;throw failure;};await f.n.control(f.owners.get('b'),second);await assert.rejects(p,/commit wire/);assert.notEqual(failedLease.roundId,f.r.roundId);assert.equal(f.n.pending,null);assert.equal(f.n.committed,null);assert.equal(f.n.snapshot().resources.timers,0);}finally{f.n.dispose();}
});
await test('Partial retry broadcast advances a new failed operation with no retry budget reset',async()=>{
 const f=fixture();try{f.n.lastPlan={id:'committed',lease:{partySessionId:'party',roundId:'old',operationId:'old-operation'},mode:'single',configDigest:D,targetPeers:['a','b']};f.r.failed=true;f.r.phase='failed';f.c.sessions.sendControl=peer=>{if(peer==='b')throw Error('retry send failed');};f.c.loadNextHost=async(plan,old,retry,failure)=>{assert.equal(retry,true);assert.equal(old,f.r);assert.equal(plan.retryOf,'old');assert.match(failure.message,/retry send/);f.c.round={...plan.lease,failed:true};throw failure;};await assert.rejects(f.n.retry(),/retry send/);assert.notEqual(f.c.round.roundId,'old');await assert.rejects(f.n.retry(),/不能/);assert.equal(f.n.retryRemaining,0);assert.equal(f.n.committed,null);}finally{f.n.dispose();}
});
await test('Guest cannot load a game or select a mode on behalf of Host',async()=>{
 const f=fixture();try{f.c.role='guest';await assert.rejects(f.n.begin({mode:'identity'}),/房主/);assert.equal(f.loads(),0);assert.equal(f.out.length,0);assert.equal(f.c.engines.current,null);}finally{f.n.dispose();}
});
await test('Complete return receipt and absence of a live old document are both required',async()=>{
 const f=fixture();try{f.c.room.receipt.complete=false;await assert.rejects(f.n.begin(),/返回/);f.c.room.receipt.complete=true;f.c.engines.current={scope:scope('stale')};await assert.rejects(f.n.begin(),/返回/);assert.equal(f.loads(),0);assert.equal(f.out.length,0);}finally{f.n.dispose();}
});
await test('A valid load-ready callback released after cancellation cannot revive the plan or create an owner',async()=>{
 const f=fixture();try{const p=f.n.begin();const held=f.ready('a');assert.equal(f.n.validate(f.owners.get('a'),held),true);f.n.cancel('cancel before late callback');await assert.rejects(p,/cancel/);await f.n.control(f.owners.get('a'),held);assert.equal(f.r.phase,'plugin-room');assert.equal(f.loads(),0);assert.equal(f.n.pending,null);assert.equal(f.c.engines.current,null);}finally{f.n.dispose();}
});
await test('Malformed duplicate commit with no plan is rejected without throwing after a previous receipt',async()=>{
 const f=fixture();try{f.n.receipts.push({peer:'a',oldLease:clone(f.r),planSignature:D});const frame={type:'next-commit',data:f.c.envelope(f.r,{protocol:'nnk-next/1'})};assert.notEqual(f.n.validate(f.owners.get('a'),frame),true);await f.n.control(f.owners.get('a'),frame);assert.equal(f.loads(),0);}finally{f.n.dispose();}
});
console.log('\n全部通过: '+count+' 项\n失败: 0 项');

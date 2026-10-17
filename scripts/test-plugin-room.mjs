// Scalar protocol/lifecycle fixtures; never substitutes for native or P4 evidence.
import assert from 'node:assert/strict';
import {PluginRoom} from '../online-kernel/keepalive/plugin-room.js';
const H='1'.repeat(64),D='2'.repeat(64),clone=x=>JSON.parse(JSON.stringify(x));
const scope=id=>({sessionId:'party',roundId:'round',documentGeneration:3,bindingId:'binding-'+id,bindingNonce:'nonce-'+id,expectedOrigin:'http://localhost:8089'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,0));}throw Error('Fixture event missing');};
function world(){
 const nodes={},wire=[],events=[];let serial=0;
 for(const name of ['host','a','b']){
  const role=name==='host'?'host':'guest',peers=role==='host'?['a','b']:['host'],owners=new Map(peers.map(p=>[p,{}])),map=new WeakMap([...owners].map(([p,o])=>[o,p]));
  const r={partySessionId:'party',roundId:'round',operationId:'operation',mode:'single',phase:'settled',settlementReady:true,remotePeerToken:name},b={scope:scope(name),windowId:name==='host'?1:name==='a'?2:3},commands=[];
  const c={role,round:r,guestPeer:role==='guest'?'host':null,roomCapable:new Set(peers),continuationCapable:new Set(peers),members:new Map(peers.map(p=>[p,{phase:'entered',engineScope:scope(p)}])),live:r2=>c.round===r2&&!r2.failed,
   sessions:{peerForActualOwner:o=>map.get(o),isLive:p=>owners.has(p),sendControl:(p,type,data)=>wire.push({from:name,to:role==='host'?p:'host',type,data:clone(data)})},
   engines:{current:b,command:async(type,args)=>{commands.push({type,args});if(type==='next-plan')return {scope:clone(b.scope),mode:args.mode,admission:true,capacity:args.mode==='single'?2:8,configDigest:D};if(type==='next-admission')return {scope:clone(b.scope),admission:true};if(type==='settlement-state')return {phase:args.phase,ready:args.ready};return {}; }},
   settlement:{host:role==='host'?{round:r,peers,barrierId:'barrier',revision:1,rosterDigest:H,acks:new Map(peers.map(p=>[p,{}]))}:null,guest:role==='guest'?{round:r,acked:true,data:{terminalSeq:11,finalSeq:13,hostScope:scope('host'),barrierId:'barrier',revision:1,rosterDigest:H}}:null,ready:()=>r.phase==='settled'&&r.settlementReady===true},
   envelope:(r2,d)=>({partySessionId:r2.partySessionId,roundId:r2.roundId,operationId:r2.operationId,requestId:'request-'+(++serial),...d}),publishState:()=>{},onEvent:(type,data)=>events.push({node:name,type,data}),fail:(r2,error)=>{r2.failed=true;r2.phase='failed';r2.error=error.message;c.room.abort(error.message);},
   retire:async()=>{b.scope=null;c.engines.current=null;c.members.clear();c.settlement.host=null;c.settlement.guest=null;return {windowId:b.windowId,confirmation:{confirmed:true},errors:[]};}};
  c.room=new PluginRoom(c);nodes[name]={c,r,b,commands,owners};
 }
 const deliver=async(row,allowRejected=false)=>{const node=nodes[row.to],owner=node.owners.get(row.from),frame={type:row.type,data:row.data};const verdict=node.c.room.validate(owner,frame);if(allowRejected&&verdict!==true)return {rejected:verdict};assert.equal(verdict,true,'Rejected '+row.type+': '+String(verdict));return node.c.room.control(owner,frame);};
 const pump=async(allowRejected=false)=>{while(wire.length)await deliver(wire.shift(),allowRejected);};
 const begin=async()=>{const promise=nodes.host.c.room.begin();await wait(()=>wire.some(x=>x.type==='room-return-prepare'));return {promise};};
 const dispose=()=>{for(const n of Object.values(nodes))n.c.room.dispose();};
 return {nodes,wire,events,deliver,pump,begin,dispose};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('  ✓ '+name);}
await test('All actual participants return and close once; plugin room stays idle with no game owner',async()=>{
 const f=world();try{const {promise}=await f.begin();await f.pump();await promise;for(const n of Object.values(f.nodes)){assert.equal(n.c.engines.current,null);assert.equal(n.c.room.ready(),true);assert.equal(n.r.phase,'plugin-room');assert.equal(n.c.room.snapshot().resources.timers,0);assert.equal(n.c.room.snapshot().resources.pending,0);assert.equal(n.b.scope,null);assert.equal(n.owners.size,n.c.role==='host'?2:1);assert.equal(JSON.stringify(n.c.room.receipt).includes('windowId'),false);}assert.equal(f.events.filter(e=>e.type==='plugin-room-ready').length,3);assert.equal(f.wire.length,0);assert.ok(f.nodes.host.c.room.receipt.plans.identity);assert.ok(f.nodes.host.c.room.receipt.plans.single);}finally{f.dispose();}
});
await test('One player ready cannot close either current game window',async()=>{
 const f=world();try{const {promise}=await f.begin();promise.catch(()=>{});await f.deliver(f.wire.shift());await f.deliver(f.wire.find(x=>x.type==='room-return-ready'));assert.notEqual(f.nodes.host.c.engines.current,null);assert.notEqual(f.nodes.a.c.engines.current,null);assert.equal(f.wire.filter(x=>x.type==='room-return-commit').length,0);}finally{f.dispose();}
});
await test('Unknown owner, stale lease, wrong return/barrier/scope cannot authorize a close',async()=>{
 const f=world();try{const {promise}=await f.begin();promise.catch(()=>{});const prepare=f.wire.shift();await f.deliver(prepare);const ready=f.wire.find(x=>x.type==='room-return-ready'),n=f.nodes.host,owner=n.owners.get('a');assert.notEqual(n.c.room.validate({},ready),true);for(const patch of [{roundId:'old'},{operationId:'future'},{returnId:'unknown'},{barrierId:'old'},{revision:2},{rosterDigest:D},{guestScope:{...scope('a'),bindingNonce:'old'}},{hostGeneration:4},{admission:false}])assert.notEqual(n.c.room.validate(owner,{type:ready.type,data:{...ready.data,...patch}}),true);assert.notEqual(n.c.engines.current,null);}finally{f.dispose();}
});
await test('Guest request and repeated settlement clicks return to room without automatically loading',async()=>{
 const f=world();try{await f.nodes.a.c.room.begin({requestId:'click'});const request=f.wire.shift(),task=f.deliver(request);await wait(()=>f.wire.some(x=>x.type==='room-return-prepare'));const again=f.nodes.host.c.room.begin();await f.pump();await task;await again;for(const n of Object.values(f.nodes))assert.equal(n.r.phase,'plugin-room');await f.nodes.host.c.room.begin();await f.nodes.a.c.room.begin();assert.equal(f.wire.length,0);}finally{f.dispose();}
});
await test('Incomplete settlement or missing room capability leaves all old documents intact',async()=>{
 const f=world();try{const n=f.nodes.host;n.r.settlementReady=false;await assert.rejects(n.c.room.begin(),/结算/);n.r.settlementReady=true;n.c.roomCapable.delete('b');await assert.rejects(n.c.room.begin(),/协议/);assert.equal(n.c.engines.current,n.b);assert.equal(f.wire.length,0);}finally{f.dispose();}
});
await test('Failed file admission cancels return instead of closing old game owners',async()=>{
 const f=world();try{const n=f.nodes.host,command=n.c.engines.command;n.c.engines.command=async(type,args,b)=>{if(type==='next-plan')throw Error('active file transaction');return command(type,args,b);};await assert.rejects(n.c.room.begin(),/file transaction/);assert.equal(n.c.engines.current,n.b);assert.equal(n.r.phase,'settled');assert.equal(n.c.room.snapshot().resources.timers,0);}finally{f.dispose();}
});
await test('Held old plan reply after cancellation cannot send prepare or change a later round',async()=>{
 const f=world(),hold=deferred();try{const n=f.nodes.host;n.c.engines.command=async type=>type==='next-plan'?hold.promise:{};const p=n.c.room.begin();n.c.room.abort('cancel held');await assert.rejects(p,/cancel held/);n.c.round={...n.r,roundId:'new',phase:'playing'};hold.resolve({scope:scope('host'),mode:'identity',admission:true,capacity:8,configDigest:D});await new Promise(r=>setTimeout(r,0));assert.equal(f.wire.filter(x=>x.type==='room-return-prepare').length,0);assert.equal(n.c.round.phase,'playing');assert.equal(n.c.room.ready(),false);}finally{f.dispose();}
});
await test('Missing real owner-destruction confirmation fails explicitly and never publishes room ready',async()=>{
 const f=world();try{const n=f.nodes.host;n.c.retire=async()=>({confirmation:{confirmed:false},errors:[]});const {promise}=await f.begin();promise.catch(()=>{});await f.pump(true);await assert.rejects(promise,/回收/);assert.equal(n.r.failed,true);assert.equal(n.c.room.ready(),false);assert.equal(f.events.some(e=>e.node==='host'&&e.type==='plugin-room-ready'),false);}finally{f.dispose();}
});
await test('Duplicate commit after local close resends only the closure receipt',async()=>{
 const f=world();try{const {promise}=await f.begin();let commit;while(f.wire.length){const row=f.wire.shift();if(row.type==='room-return-commit'&&row.to==='a')commit=clone(row);await f.deliver(row);}await promise;const n=f.nodes.a;assert.equal(n.c.engines.current,null);await f.deliver(commit);await f.pump();assert.equal(f.events.filter(e=>e.node==='a'&&e.type==='plugin-room-engine-closed').length,1);assert.equal(n.c.room.ready(),true);}finally{f.dispose();}
});
await test('Old return receipt cannot affect a new document or a new round',async()=>{
 const f=world();try{const {promise}=await f.begin();const old=clone(f.wire[0]);await f.pump();await promise;const n=f.nodes.a;n.c.room.reset();n.c.round={...n.r,roundId:'new',phase:'playing'};n.c.engines.current={scope:{...scope('a'),roundId:'new'}};assert.notEqual(n.c.room.validate(n.owners.get('host'),old),true);assert.equal(n.c.round.phase,'playing');}finally{f.dispose();}
});
await test('A once-valid ready callback released after cancellation cannot fail or close the retained game',async()=>{
 const f=world();try{const {promise}=await f.begin();promise.catch(()=>{});await f.deliver(f.wire.shift());const held=clone(f.wire.find(x=>x.type==='room-return-ready')),n=f.nodes.host;assert.equal(n.c.room.validate(n.owners.get('a'),held),true);n.c.room.abort('cancel before callback release');await assert.rejects(promise,/cancel/);await n.c.room.control(n.owners.get('a'),held);assert.equal(n.c.engines.current,n.b);assert.equal(n.r.phase,'settled');assert.equal(n.r.failed,undefined);assert.equal(n.c.room.pending,null);}finally{f.dispose();}
});
console.log('\n全部通过: '+passed+' 项\n失败: 0 项');

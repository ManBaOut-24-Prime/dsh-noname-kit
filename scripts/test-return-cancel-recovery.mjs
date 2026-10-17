// Deterministic controller/native-adapter fixtures, not a real game or P4 result.
// The reviewed official over method is fingerprinted, never executed here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import testPaths from './fixtures/test-paths.cjs';
import {PluginRoom} from '../online-kernel/keepalive/plugin-room.js';
import {createNativeSettlement,NATIVE_OVER_SHA256} from '../online-kernel/keepalive/native-settlement.js';
globalThis.require=createRequire(import.meta.url);
const clone=x=>JSON.parse(JSON.stringify(x)),H='1'.repeat(64);
const scope=id=>({sessionId:'party',roundId:'round',documentGeneration:3,bindingId:'binding-'+id,bindingNonce:'nonce-'+id,expectedOrigin:'http://fixture'});
const wait=async fn=>{for(let i=0;i<50;i++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('Current cancellation recovery did not complete');};
function officialOver(label){
 const source=fs.readFileSync(testPaths.officialRoot(label)+'/noname/game/index.js','utf8');
 const method=source.match(/\n  over\(result, bool\) \{[\s\S]*?\n  \}/)?.[0].trimStart();
 assert.ok(method,'Reviewed official over method source is required');
 const over=new Function('return ({'+method+'}).over;')();
 assert.equal(createHash('sha256').update(String(over)).digest('hex'),NATIVE_OVER_SHA256);
 return over;
}
function fixture(over){
 const r={partySessionId:'party',roundId:'round',operationId:'operation',phase:'settled',settlementReady:true},b={scope:scope('guest')},owner={},wire=[],commands=[],events=[];let click;
 const classes=new Set(),env={_status:{over:false},lib:{onover:[]},game:{over,reload(){}},get:{funcInfoOL:fn=>String(fn)},ui:{dialogs:[],create:{control(_text,callback){click=callback;return {classList:{toggle(name,on){on?classes.add(name):classes.delete(name);},add:name=>classes.add(name)},dataset:{},close(){}};}}}};
 const c={role:'guest',round:r,guestPeer:'host',roomCapable:new Set(['host']),live:x=>c.round===x&&!x.failed,engines:{current:b},
  sessions:{peerForActualOwner:o=>o===owner?'host':null,isLive:p=>p==='host',sendControl:(peer,type,data)=>wire.push({peer,type,data:clone(data)})},
  envelope:(round,data)=>({...round,requestId:crypto.randomUUID(),...data}),publishState(){},onEvent:(type,data)=>events.push({type,data}),fail:(round,error)=>{round.failed=true;round.phase='failed';round.settlementReady=false;events.push({type:'failed',error:error.message});}};
 const native=createNativeSettlement({env,role:'guest',scope:b.scope,isCurrent:()=>c.engines.current===b,emit:(type,data)=>{events.push({type,data});if(type==='round-return-request')c.room.begin({requestId:data.requestId});},actualRoster:()=>[],expectedPeers:()=>[]});
 assert.equal(native.install().available,true);
 const terminal=JSON.stringify(['exec',env.get.funcInfoOL(over),'fixture-result']),before=native.beforeFrame(terminal);
 env._status.over=true;env.ui.dialogs.push({isConnected:true,content:{innerText:'战斗胜利',innerHTML:'fixture settlement'}});
 native.afterFrame('host',terminal,11,before);
 assert.equal(native.state({phase:'settled',ready:true,terminalSeq:11,finalSeq:13}).ready,true);
 const g={round:r,acked:true,data:{hostScope:scope('host'),barrierId:'barrier',revision:1,rosterDigest:H,terminalSeq:11,finalSeq:13}};
 c.settlement={guest:g,ready:()=>c.round===r&&r.phase==='settled'&&r.settlementReady===true&&c.settlement.guest.acked};
 c.engines.command=async(type,args,candidate=b)=>{assert.equal(candidate,b);commands.push({type,args:clone(args)});if(type==='next-admission')return {admission:true,scope:clone(b.scope)};if(type==='settlement-state')return native.state(args);throw Error('Unexpected fixture command '+type);};
 c.room=new PluginRoom(c);
 const prepare={type:'room-return-prepare',data:{protocol:'nnk-room/1',partySessionId:r.partySessionId,roundId:r.roundId,operationId:r.operationId,requestId:'prepare',returnId:'return',barrierId:'barrier',revision:1,rosterDigest:H,hostScope:scope('host')}};
 return {c,r,b,g,wire,commands,events,native,classes,prepare,owner,click:()=>click(),async enterPreparing(){await c.room.control(owner,prepare);assert.equal(native.snapshot().phase,'preparing');assert.equal(native.snapshot().ready,false);assert.equal(classes.has('disabled'),true);},dispose(){c.room.dispose();native.dispose();}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('  ✓ '+name);}
for(const label of ['Old','Latest']){
 const over=officialOver(label);
 await test(label+': cancellation restores actual adapter readiness and Guest can request again',async()=>{
  const f=fixture(over);try{await f.enterPreparing();f.c.room.abort('fixture cancel');await wait(()=>f.native.snapshot().ready&&f.r.phase==='settled');assert.equal(f.classes.has('disabled'),false);const state=f.commands.findLast(x=>x.type==='settlement-state');assert.equal(state.args.terminalSeq,11);assert.equal(state.args.finalSeq,13);f.click();assert.equal(f.wire.at(-1).type,'room-return-proposal');assert.equal(f.c.engines.current,f.b);}finally{f.dispose();}
 });
 await test(label+': preparation timeout restores the same retained Guest control',async()=>{
  const f=fixture(over),original=globalThis.setTimeout;let timeout;
  try{globalThis.setTimeout=(fn,ms)=>{assert.equal(ms,20000);timeout=fn;return original(()=>{},20000);};await f.enterPreparing();globalThis.setTimeout=original;clearTimeout(f.c.room.timer);timeout();await wait(()=>f.native.snapshot().ready&&f.r.phase==='settled');f.click();assert.equal(f.wire.at(-1).type,'room-return-proposal');assert.equal(f.c.room.pending,null);}finally{globalThis.setTimeout=original;f.dispose();}
 });
 await test(label+': native stale fence rejection cannot falsely restore settled readiness',async()=>{
  const f=fixture(over);try{await f.enterPreparing();f.g.data.terminalSeq=10;f.c.room.abort('fixture obsolete fence');await wait(()=>f.c.room.pending===null&&f.commands.some(x=>x.args.phase==='settled'));await new Promise(r=>setImmediate(r));assert.equal(f.native.snapshot().ready,false);assert.equal(f.r.settlementReady,false);assert.notEqual(f.r.phase,'settled');f.click();assert.equal(f.wire.some(x=>x.type==='room-return-proposal'),false);}finally{f.dispose();}
 });
 await test(label+': obsolete unready recovery replies cannot regress a newer confirmation',async()=>{
  for(const newerPhase of ['settling','settled'])for(const outcome of ['resolved','rejected']){
   const f=fixture(over);let release;
   try{
    await f.enterPreparing();f.r.phase='settling';f.r.settlementReady=false;f.g.acked=false;
    const original=f.c.engines.command;
    f.c.engines.command=(type,args,b)=>{
     const result=original(type,args,b);
     if(type!=='settlement-state'||args.phase!=='settling')return result;
     return new Promise((resolve,reject)=>{release=async()=>{const reply=await result;outcome==='resolved'?resolve(reply):reject(Error('obsolete recovery reply failed'));};});
    };
    f.c.room.abort('fixture unready return cancellation');assert.equal(typeof release,'function');
    f.c.settlement.guest={...f.g,acked:true,data:{...f.g.data,revision:2}};
    f.r.phase=newerPhase;f.r.settlementReady=newerPhase==='settled';
    f.native.state({phase:newerPhase,ready:f.r.settlementReady,terminalSeq:11,finalSeq:13});
    await release();await new Promise(r=>setImmediate(r));
    assert.equal(f.r.phase,newerPhase);assert.equal(f.r.settlementReady,newerPhase==='settled');assert.equal(f.r.failed,undefined);assert.equal(f.native.snapshot().ready,newerPhase==='settled');
   }finally{f.dispose();}
  }
 });
 await test(label+': late recovery reply cannot complete a replacement fence or round',async()=>{
  for(const changed of ['fence','round','binding']){
   const f=fixture(over);let release;try{await f.enterPreparing();const original=f.c.engines.command;f.c.engines.command=(type,args,b)=>type==='settlement-state'&&args.phase==='settled'?new Promise(resolve=>release=()=>resolve({phase:'settled',ready:true})):original(type,args,b);f.c.room.abort('fixture held recovery');assert.equal(typeof release,'function');if(changed==='fence')f.c.settlement.guest={...f.g,data:{...f.g.data,revision:2}};if(changed==='round')f.c.round={...f.r,roundId:'new',phase:'playing',settlementReady:false};if(changed==='binding')f.c.engines.current={scope:{...scope('guest'),bindingNonce:'new'}};release();await new Promise(r=>setImmediate(r));assert.equal(f.c.round.settlementReady,false);assert.equal(f.c.round.failed,undefined);if(changed==='round')assert.equal(f.c.round.phase,'playing');}finally{f.dispose();}
  }
 });
}
console.log('\n全部通过: '+passed+' 项\n失败: 0 项');

// Synthetic protocol clocks and registered owners; physical throughput is verified separately.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {CarrierTransfer,TRANSFER_PROTOCOL,TRANSFER_MAX_BYTES,TRANSFER_MAX_TTL_MS,transferBudgetMs} from '../online-kernel/keepalive/carrier-transfer.js';
import {InitialPartyCoordinator} from '../online-kernel/keepalive/initial-party.js';
import {LobbyManifest,LOBBY_MANIFEST_PROTOCOL} from '../online-kernel/keepalive/lobby-manifest.js';
const require=createRequire(import.meta.url),core=require('../online-kernel/lib/batch-files.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const manifest=total=>core.normalize({extensions:[{name:'Budget',files:[{path:'extension.js',size:total,sha256:'a'.repeat(64)}]}]});
const binding=row=>Object.fromEntries(['session','peerSession','proposal','digest','peerId','scope'].map(key=>[key,clone(row[key])]));
const inventory=()=>({exts:[],installed:[],packs:['standard'],cards:['standard'],kernel:'protocol-fixture',identity:{name:'Peer',avatar:'caocao'},batchProtocol:2,inventoryVersion:1,contents:{}});
function fixture({role='host',total=300*1048576,handshake=true}={}){
 let now=1700000000000,serial=0,timerId=0;const timers=new Map(),sent=[],events=[],counts={grants:0,stops:0,files:0,transportStops:0};
 const scope={carrierSessionId:'local-carrier',partyEpoch:0},remoteScope={carrierSessionId:'remote-carrier',partyEpoch:0},peer='remote-peer',connectionSessionId='current-physical-session';
 const owner={role,stopped:false,link:{bufferedAmount:0},snapshot:()=>({lastAcceptedControlSeq:0}),stopTransport(){counts.transportStops++;this.stopped=true;}};
 const record={peerId:peer,connectionSessionId,live:true,entered:false,joinOrdinal:1,identity:{name:'Peer',avatar:'caocao'}};
 const sessions={get:p=>p===peer?record:null,getOwner:p=>p===peer?owner:null,peerForActualOwner:o=>o===owner?peer:null,isLive:p=>p===peer&&!owner.stopped,
  snapshot:()=>[record],wasEverEntered:()=>false,setIdentity(_peer,actual,value){assert.equal(actual,owner);record.identity=clone(value);},
  sendControl(p,type,data){assert.equal(p,peer);assert.equal(owner.stopped,false);sent.push({type,data:clone(data)});}};
 const setTimer=(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay});return timerId;},clearTimer=id=>timers.delete(id);
 const ctl=new CarrierTransfer({sessions,getRole:()=>role,getScope:()=>scope,canTransfer:()=>({available:true}),collect:async()=>manifest(total),normalize:core.normalize,digest:core.manifestDigest,
  now:()=>now,newId:()=> (++serial).toString(16).padStart(32,'0'),setTimer,clearTimer,
  createChannel:options=>({granted(){const grant=options.authorize();assert.ok(grant);counts.grants++;this.grant=grant;},stop(){counts.stops++;},close(){}}),
  source:async()=>{counts.files++;throw Error('No disk adapter belongs in a protocol-clock test');},receiver:async()=>{counts.files++;throw Error('No disk adapter belongs in a protocol-clock test');},emit:(type,data)=>events.push({type,data:clone(data)})});
 const frame=(op,fields={})=>{const r=ctl.peers.get(peer);return {type:'transfer-consent',sourcePeer:role==='host'?'guest':'host',sessionId:connectionSessionId,seq:(r?.lastSequence||0)+1,data:{protocol:TRANSFER_PROTOCOL,partySessionId:null,roundId:null,operationId:null,requestId:'request-'+(++serial),connectionSessionId,scope:clone(remoteScope),op,...fields}};};
 const init=async()=>{if(handshake){ctl.setPeerCapability(peer);assert.equal(await ctl.control(owner,frame('hello',{nonce:'f'.repeat(32)})),true);}};
 const offer=async()=>{if(role==='host'){assert.equal(await ctl.autoOffer(peer,{verification:'verified',inventoryVerified:true,exts:{needsFiles:['Budget']}}),true);}else{const r=ctl.peers.get(peer),batch=manifest(total);assert.equal(await ctl.control(owner,frame('offer',{from:r.remote,to:r.local,proposal:'e'.repeat(32),digest:core.manifestDigest(batch),batch,ttlMs:transferBudgetMs(total)})),true);}return ctl.snapshot().proposals.at(-1);};
 async function advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await drain();}
 return {role,peer,owner,record,sessions,ctl,scope,remoteScope,sent,events,counts,frame,init,offer,advance,now:()=>now,close:()=>ctl.dispose()};
}
let passed=0;async function test(label,run){await run();passed++;console.log('  ✓ '+label);}
for(const [total,expected]of [[0,120000],[1,121000],[1048576,121000],[1048577,122000],[128*1048576,248000],[300*1048576,420000],[779*1048576,899000],[780*1048576,900000],[TRANSFER_MAX_BYTES,900000]]){
 await test('fixed authorization budget at '+total+' bytes is '+expected+' ms',()=>assert.equal(transferBudgetMs(total),expected));
}
for(const value of [-1,0.1,NaN,Infinity,'1',null,undefined,TRANSFER_MAX_BYTES+1,Number.MAX_SAFE_INTEGER]){
 await test('reject invalid or over-1-GiB batch total '+String(value),()=>assert.throws(()=>transferBudgetMs(value),RangeError));
}
await test('protocol and native canonical manifest agree on the 1-GiB inclusive bound',()=>{
 assert.equal(TRANSFER_PROTOCOL,'nnk-transfer/2');assert.equal(TRANSFER_MAX_BYTES,1073741824);assert.equal(TRANSFER_MAX_TTL_MS,900000);assert.equal(manifest(TRANSFER_MAX_BYTES).total,TRANSFER_MAX_BYTES);assert.throws(()=>manifest(TRANSFER_MAX_BYTES+1));
});
for(const role of ['host','guest'])await test(role+' creates one immutable 300-MiB seven-minute budget before consent',async()=>{
 const f=fixture({role});await f.init();try{const q=await f.offer();assert.equal(q.ttlMs,420000);assert.equal(q.expires,f.now()+420000);assert.equal(f.counts.grants,0);assert.equal(f.counts.files,0);await f.advance(90000);assert.equal(f.ctl.snapshot().proposals.at(-1).expires,q.expires);assert.equal(f.ctl.snapshot().proposals.at(-1).ttlMs,q.ttlMs);}finally{await f.close();}
});
await test('guest rejects arbitrary, old fixed, noninteger and over-cap advertised durations',async()=>{
 const f=fixture({role:'guest'});await f.init();try{const r=f.ctl.peers.get(f.peer),batch=manifest(300*1048576),fields={from:r.remote,to:r.local,proposal:'e'.repeat(32),digest:core.manifestDigest(batch),batch};for(const ttlMs of [120000,419999,420001,900001,'420000',Infinity,0])assert.notEqual(f.ctl.validate(f.owner,f.frame('offer',{...fields,ttlMs})),true);assert.equal(f.ctl.snapshot().proposals.length,0);assert.equal(f.counts.files,0);}finally{await f.close();}
});
await test('guest recomputes budget from canonical file bytes rather than trusting declared totals',async()=>{
 const f=fixture({role:'guest'});await f.init();try{const r=f.ctl.peers.get(f.peer),batch=manifest(300*1048576);batch.total=TRANSFER_MAX_BYTES;assert.notEqual(f.ctl.validate(f.owner,f.frame('offer',{from:r.remote,to:r.local,proposal:'e'.repeat(32),digest:core.manifestDigest(batch),batch,ttlMs:900000})),true);assert.equal(f.ctl.snapshot().proposals.length,0);}finally{await f.close();}
});
await test('duplicate offers cannot reset a pending or already expired deadline',async()=>{
 const f=fixture({role:'guest'});await f.init();try{const first=await f.offer(),r=f.ctl.peers.get(f.peer),fields={from:r.remote,to:r.local,proposal:first.proposal,digest:first.digest,batch:manifest(300*1048576),ttlMs:first.ttlMs};await f.advance(90000);await f.ctl.control(f.owner,f.frame('offer',fields));assert.equal(f.ctl.snapshot().proposals.at(-1).expires,first.expires);await f.advance(330000);assert.equal(f.ctl.snapshot().proposals.at(-1).status,'expired');await f.ctl.control(f.owner,f.frame('offer',fields));assert.equal(f.ctl.snapshot().proposals.at(-1).expires,first.expires);assert.equal(f.ctl.snapshot().proposals.at(-1).status,'expired');assert.equal(f.ctl.decide({...binding(first),yes:true}),false);}finally{await f.close();}
});
await test('accept can shorten the original deadline and no duplicate accept can extend it',async()=>{
 const f=fixture({role:'guest'});await f.init();try{const first=await f.offer(),r=f.ctl.peers.get(f.peer),fields={from:r.remote,to:r.local,proposal:first.proposal,digest:first.digest};assert.equal(f.ctl.decide({...binding(first),yes:true}),true);await f.advance(5000);for(const remainingMs of [420001,900000,0,-1,1.5])assert.notEqual(f.ctl.validate(f.owner,f.frame('accept',{...fields,remainingMs})),true);await f.ctl.control(f.owner,f.frame('accept',{...fields,remainingMs:1500}));const end=f.ctl.snapshot().proposals.at(-1).expires;assert.equal(end,f.now()+1500);assert.ok(end<first.expires);assert.equal(f.counts.grants,1);await f.advance(500);await f.ctl.control(f.owner,f.frame('accept',{...fields,remainingMs:420000}));assert.equal(f.ctl.snapshot().proposals.at(-1).expires,end);assert.equal(f.counts.grants,1);await f.advance(1000);assert.equal(f.ctl.snapshot().proposals.at(-1).status,'expired');assert.equal(f.counts.stops,1);}finally{await f.close();}
});
await test('late guest consent and repeated host decisions retain the creation deadline',async()=>{
 const f=fixture();await f.init();try{const first=await f.offer(),r=f.ctl.peers.get(f.peer),fields={from:r.remote,to:r.local,proposal:first.proposal,digest:first.digest,yes:true};await f.advance(300000);await f.ctl.control(f.owner,f.frame('decision',fields));assert.equal(f.sent.findLast(x=>x.data.op==='accept').data.remainingMs,120000);assert.equal(f.ctl.snapshot().proposals.at(-1).expires,first.expires);await f.advance(10000);await f.ctl.control(f.owner,f.frame('decision',fields));assert.equal(f.sent.findLast(x=>x.data.op==='accept').data.remainingMs,110000);assert.equal(f.ctl.snapshot().proposals.at(-1).expires,first.expires);assert.equal(f.counts.grants,1);await f.advance(110000);const accepts=f.sent.filter(x=>x.data.op==='accept').length;await f.ctl.control(f.owner,f.frame('decision',fields));assert.equal(f.sent.filter(x=>x.data.op==='accept').length,accepts);assert.equal(f.ctl.snapshot().proposals.at(-1).status,'expired');}finally{await f.close();}
});
await test('retry allocates a fresh proposal and full fixed budget without carrying old consent',async()=>{
 const f=fixture({total:TRANSFER_MAX_BYTES});await f.init();try{const old=await f.offer();await f.advance(12345);assert.equal(await f.ctl.cancel(binding(old)),true);assert.equal(await f.ctl.retry(binding(old)),true);const current=f.ctl.snapshot().proposals.at(-1);assert.notEqual(current.proposal,old.proposal);assert.equal(current.status,'pending');assert.equal(current.ttlMs,900000);assert.equal(current.expires,f.now()+900000);assert.equal(f.counts.grants,0);assert.equal(f.counts.files,0);const r=f.ctl.peers.get(f.peer);assert.notEqual(f.ctl.validate(f.owner,f.frame('decision',{from:r.remote,to:r.local,proposal:old.proposal,digest:old.digest,yes:true})),true);}finally{await f.close();}
});
for(const role of ['host','guest'])await test('new '+role+' keeps ordinary lobby and read-only health usable with an old transfer/1 peer',async()=>{
 const f=fixture({role,handshake:false}),healthEvents=[];let scans=0;const lm=new LobbyManifest({sessions:f.sessions,getRole:()=>role,getScope:()=>f.scope,collect:async()=>{scans++;return inventory();},emit:(type,data)=>healthEvents.push({type,data}),now:f.now,setTimer:()=>1,clearTimer:()=>{}});
 const party=new InitialPartyCoordinator({sessions:f.sessions,engines:{current:null},getLocalIdentity:()=>({name:'Local',avatar:'caocao'})});party.setRole(role);party.lobbyManifest=lm;party.lobbyTransfer=f.ctl;
 try{await party.onRegistered(f.record);const advertised=f.sent.findLast(row=>row.type===(role==='host'?'lobby-state':'party-request'));assert.ok(advertised.data.roundCapabilities.includes('nnk-transfer/2'));assert.equal(advertised.data.roundCapabilities.includes('nnk-transfer/1'),false);
  const caps=['nnk-settle/1','nnk-next/1','nnk-room/1','nnk-lobby-manifest/1','nnk-transfer/1'],data=party.envelope(null,{roundCapabilities:caps,...(role==='host'?{identity:inventory().identity}:{hostIdentity:inventory().identity,roomCode:null,mode:'identity',capacity:8,members:[{peerId:'host',name:'Peer',role:'host',entered:false,queued:false}]})}),frame={type:role==='host'?'party-request':'lobby-state',sourcePeer:role==='host'?'guest':'host',sessionId:f.record.connectionSessionId,seq:20,data};assert.equal(party.validate(f.owner,frame),true);await party.control(f.owner,frame);assert.equal(party.supportedPeers.has(f.peer),true);assert.equal(f.owner.stopped,false);assert.equal(f.counts.transportStops,0);assert.equal(f.ctl.availability().available,false);assert.match(f.ctl.availability().reason,/升级.*重启/);assert.equal(f.ctl.capabilitySnapshot().length,0);assert.equal(lm.readiness().available,true);
  await lm.recheck();const request=f.sent.findLast(row=>row.type==='lobby-manifest-request'),response={type:'lobby-manifest-response',sourcePeer:role==='host'?'guest':'host',sessionId:f.record.connectionSessionId,seq:21,data:{...request.data,requestId:'old-peer-manifest-response',responseTo:request.data.requestId,inventory:inventory()}};assert.equal(response.data.protocol,LOBBY_MANIFEST_PROTOCOL);assert.equal(lm.validate(f.owner,response),true);await lm.control(f.owner,response);assert.equal(scans,1);assert.equal(healthEvents.some(e=>e.type==='manifest_diff'&&e.data.verification==='verified'),true);assert.equal(f.counts.files,0);assert.equal(f.counts.grants,0);assert.equal(f.owner.stopped,false);
 }finally{party.dispose();lm.dispose();await f.close();}
});
console.log('\n全部通过: '+passed+' 项\n失败: 0 项');
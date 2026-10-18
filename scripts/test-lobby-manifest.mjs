// Synthetic registered-owner/control scheduling only. No game, sockets, files or AI are started.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LobbyManifest, LOBBY_MANIFEST_PROTOCOL, validLobbyInventory, sanitizeLobbyInventory } from '../online-kernel/keepalive/lobby-manifest.js';
import { compareManifests } from '../online-kernel/keepalive/manifest-compare.js';
import { TransportOwner } from '../online-kernel/keepalive/transport-owner.js';
const clone = value => structuredClone(value), drain = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };
const inventory = (name='A', digest='a') => ({ exts:[name], installed:[name], packs:['standard'], cards:['standard'], kernel:'test-only',
  identity:{name:'Sample',avatar:'caocao'},batchProtocol:2,inventoryVersion:1,contents:{[name]:{digest:digest.repeat(64),count:2,total:30}} });
function fixture({ role='host', collect, peers=1 }={}) {
  let clock=10000, epoch=0, next=0, request=0; const timers=new Map(), events=[], sends=[], records=new Map(), scans=[];
  for(let i=0;i<peers;i++){const owner={role,sequence:0,ready:true,stopped:false,snapshot(){return {lastAcceptedControlSeq:this.sequence}}};records.set('peer-'+i,{peerId:'peer-'+i,connectionSessionId:'connection-'+i,owner});}
  const sessions={get:peer=>records.has(peer)?{...records.get(peer),owner:undefined}:null,getOwner:peer=>records.get(peer)?.owner,
    peerForActualOwner:owner=>[...records.values()].find(record=>record.owner===owner)?.peerId,
    isLive:peer=>!!records.get(peer)?.owner.ready&&!records.get(peer)?.owner.stopped,snapshot:()=>[...records.values()].map(({owner,...record})=>record),
    sendControl(peer,type,data){if(!this.isLive(peer))throw Error('stopped');sends.push({peer,type,data:clone(data)});return sends.length;}};
  const module=new LobbyManifest({sessions,getRole:()=>role,getScope:()=>({carrierSessionId:'synthetic-carrier',partyEpoch:epoch}),
    collect:async args=>{scans.push(args);return collect?collect(args):inventory();},emit:(type,data)=>events.push({type,data:clone(data)}),
    now:()=>clock,setTimer:(fn,ms)=>{timers.set(++next,{fn,at:clock+ms});return next;},clearTimer:id=>timers.delete(id),newRequestId:()=>`synthetic-request-${++request}`});
  const peer='peer-0',owner=records.get(peer).owner;for(const record of records.values())module.setPeerCapability(record.peerId);
  function frame(type,data,overrides={}){return {type,data:clone(data),sourcePeer:role==='host'?'guest':'host',sessionId:'connection-0',seq:owner.sequence+1,...overrides};}
  function incoming(remote=inventory(),requestId='remote-request'){return frame('lobby-manifest-request',{protocol:LOBBY_MANIFEST_PROTOCOL,partySessionId:null,roundId:null,operationId:null,requestId,connectionSessionId:'connection-0',inventory:remote});}
  function response(remote=inventory(),overrides={}){const sent=sends.findLast(item=>item.type==='lobby-manifest-request');return frame('lobby-manifest-response',{...sent.data,requestId:'remote-response',responseTo:sent.data.requestId,inventory:remote,...overrides});}
  async function deliver(message,source=owner){const verdict=module.validate(source,message);if(verdict!==true)return verdict;source.sequence=Math.max(source.sequence,message.seq);return module.control(source,message);}
  function tick(ms){clock+=ms;for(const[id,timer]of[...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}}
  return {module,events,sends,scans,records,owner,sessions,peer,frame,incoming,response,deliver,timers,tick,nextScope(){epoch++;return module.readiness();},disconnect(){module.forgetPeer(peer);records.delete(peer);},scope:()=>({carrierSessionId:'synthetic-carrier',partyEpoch:epoch})};
}
let count=0;async function test(name,fn){await fn();count++;console.log('  ✓ '+name);}
await test('valid inventory preserves only bounded content summaries and redacts exception paths',()=>{
  const raw=inventory();raw.contents.A={error:'E:/private/failed-file'};raw.inventoryError='E:/private/root';assert.equal(validLobbyInventory(raw),true);
  const clean=sanitizeLobbyInventory(raw);assert.doesNotMatch(JSON.stringify(clean),/private/);assert.match(clean.contents.A.error,/摘要/);assert.notDeepEqual(clean,raw);
});
await test('read-only inventory accepts an exact 1-GiB extension summary',()=>{
 const value=inventory();value.contents.A.total=1073741824;assert.equal(validLobbyInventory(value),true);assert.equal(sanitizeLobbyInventory(value).contents.A.total,1073741824);
});
await test('read-only inventory rejects one byte above the 1-GiB bound',()=>{
 const value=inventory();value.contents.A.total=1073741825;assert.equal(validLobbyInventory(value),false);assert.throws(()=>sanitizeLobbyInventory(value));
});
for(const [label,mutate]of[
  ['unknown path field',v=>v.root='E:/private'],['too many extensions',v=>v.exts=Array.from({length:65},(_,i)=>'E'+i)],
  ['duplicate IDs',v=>v.packs=['A','A']],['path names',v=>v.installed=['../outside']],['long identity',v=>v.identity.name='x'.repeat(13)],
  ['arbitrary consent',v=>v.batchProtocol=1],['file payload',v=>v.contents.A.bytes='payload'],['invalid digest',v=>v.contents.A.digest='f'.repeat(63)],
  ['negative file size',v=>v.contents.A.total=-1],['huge file count',v=>v.contents.A.count=4097],['unlisted digest',v=>v.contents.B={digest:'a'.repeat(64)}],
  ['oversized metadata',v=>v.packs=Array.from({length:3000},(_,i)=>String(i)+'中'.repeat(100))],
])await test('reject '+label,()=>{const value=inventory();mutate(value);assert.equal(validLobbyInventory(value),false);assert.throws(()=>sanitizeLobbyInventory(value));});
await test('host can request a metadata-only check without any engine or native API',async()=>{
  const f=fixture();try{const result=await f.module.recheck();assert.equal(result.requested,true);assert.equal(f.scans.length,1);assert.equal(f.sends.length,1);assert.equal(f.sends[0].type,'lobby-manifest-request');assert.equal(f.sends[0].data.partySessionId,null);assert.equal(f.sends[0].data.roundId,null);assert.equal(f.sends[0].data.operationId,null);assert.equal(await f.deliver(f.response()),true);assert.equal(f.module.readiness().pending,0);assert.equal(f.events.at(-1).data.status,'verified');assert.equal(f.events.find(e=>e.type==='manifest_diff').data.metadataOnly,true);}finally{f.module.dispose();}
});
await test('guest uses canonical host-to-guest comparison for missing local packages',async()=>{
  const f=fixture({role:'guest',collect:()=>({...inventory(),exts:[],installed:[],contents:{}})});try{await f.module.recheck();await f.deliver(f.response());const diff=f.events.find(e=>e.type==='manifest_diff').data;assert.deepEqual(diff.exts.missing,['A']);assert.equal(diff.role,'guest');}finally{f.module.dispose();}
});
await test('a received request is answered with local inventory rather than trusting a remote diff',async()=>{
  const f=fixture();try{assert.equal(await f.deliver(f.incoming(inventory('A','b'))),true);assert.equal(f.sends[0].type,'lobby-manifest-response');assert.equal(f.sends[0].data.responseTo,'remote-request');assert.equal(f.sends[0].data.inventory.contents.A.digest,'a'.repeat(64));assert.deepEqual(f.events.find(e=>e.type==='manifest_diff').data.exts.changed,['A']);}finally{f.module.dispose();}
});
for(const [label,mutate]of[
  ['wrong protocol',m=>m.data.protocol='legacy'],['wrong direction',m=>m.sourcePeer='host'],['wrong physical session',m=>m.sessionId='other'],
  ['forged data session',m=>m.data.connectionSessionId='other'],['non-null lease',m=>m.data.roundId='fake-round'],['extra transfer fields',m=>m.data.files=['payload']],
  ['invalid sequence',m=>m.seq=0],['unbounded request ID',m=>m.data.requestId='x'.repeat(161)],['foreign scope',m=>m.data.scope={partyEpoch:0}],
])await test('control rejects '+label,()=>{const f=fixture();try{const m=f.incoming();mutate(m);assert.notEqual(f.module.validate(f.owner,m),true);assert.equal(f.events.length,0);assert.equal(f.scans.length,0);}finally{f.module.dispose();}});
await test('unregistered and replaced actual owners cannot submit a result',async()=>{
  const f=fixture();try{await f.module.recheck();assert.notEqual(f.module.validate({...f.owner},f.response()),true);const old=f.owner;f.records.get(f.peer).owner={...old};assert.notEqual(f.module.validate(old,f.response()),true);assert.equal(f.events.some(e=>e.type==='manifest_diff'),false);}finally{f.module.dispose();}
});
await test('unadvertised peers and legacy responses have no downgrade path',async()=>{
  const f=fixture();f.module.setPeerCapability(f.peer,false);try{assert.equal(f.module.readiness().available,false);await assert.rejects(f.module.recheck(),/支持/);assert.notEqual(f.module.validate(f.owner,f.incoming()),true);assert.equal(f.module.validate(f.owner,{type:'nnk_manifest_diff'}),null);assert.equal(f.sends.length,0);}finally{f.module.dispose();}
});
await test('a response must correlate current request, owner, inventory, and later sequence',async()=>{
  const f=fixture();try{await f.module.recheck();for(const modify of[m=>m.data.responseTo='stale',m=>m.seq=0,m=>delete m.data.inventory,m=>m.data.exts={matching:['fake']}]){const msg=f.response();modify(msg);assert.notEqual(f.module.validate(f.owner,msg),true);}assert.equal(await f.deliver(f.response()),true);assert.notEqual(f.module.validate(f.owner,f.response()),true);assert.equal(f.events.filter(e=>e.type==='manifest_diff').length,1);}finally{f.module.dispose();}
});
await test('pending and rapid repeat checks cannot create duplicate scans',async()=>{
  const wait=deferred(),f=fixture({collect:()=>wait.promise});try{const first=f.module.recheck();await drain();await assert.rejects(f.module.recheck(),/正在进行|过快/);assert.equal(f.scans.length,1);wait.resolve(inventory());await first;await f.deliver(f.response());await assert.rejects(f.module.recheck(),/过快/);f.tick(1500);await f.module.recheck();assert.equal(f.scans.length,2);}finally{wait.resolve(inventory());f.module.dispose();}
});
await test('a new scope aborts collection and never publishes or sends late inventory',async()=>{
  const wait=deferred(),f=fixture({collect:()=>wait.promise});try{const running=f.module.recheck();await drain();const events=f.events.length;f.nextScope();assert.equal(f.scans[0].signal.aborted,true);wait.resolve(inventory());await running;assert.equal(f.sends.length,0);assert.equal(f.events.length,events);assert.equal(f.events.some(e=>e.type==='manifest_diff'),false);assert.equal(f.module.readiness().pendingScans,0);}finally{wait.resolve(inventory());f.module.dispose();}
});
await test('a late response cannot cross the same carrier party epoch',async()=>{
  const f=fixture();try{await f.module.recheck();const old=f.response();f.nextScope();assert.notEqual(f.module.validate(f.owner,old),true);assert.equal(f.events.some(e=>e.type==='manifest_diff'),false);}finally{f.module.dispose();}
});
await test('an aborted unresolved read cannot accumulate more underlying scans',async()=>{
  const wait=deferred(),f=fixture({collect:()=>wait.promise});try{const first=f.module.recheck();await drain();f.nextScope();
    for(let i=0;i<4;i++){f.tick(1500);await f.module.recheck();assert.equal(f.scans.length,1);assert.equal(f.module.readiness().pendingScans,1);}
    wait.resolve(inventory());await first;assert.equal(f.module.readiness().pendingScans,0);f.tick(1500);await f.module.recheck();assert.equal(f.scans.length,2);
  }finally{wait.resolve(inventory());f.module.dispose();}
});
await test('capability snapshots contain only current actual owner bindings and no prior results',async()=>{
  const f=fixture({peers:2});try{await f.module.recheck();const cap=f.module.capabilitySnapshot();assert.equal(cap.length,2);assert.deepEqual(Object.keys(cap[0]).sort(),['connectionSessionId','owner','peerId']);assert.equal(cap[0].owner,f.owner);
    f.records.get('peer-1').owner={role:'host',ready:true,stopped:false};assert.equal(f.module.capabilitySnapshot().length,1);f.module.forgetPeer(f.peer);assert.deepEqual(f.module.capabilitySnapshot(),[]);
  }finally{f.module.dispose();assert.deepEqual(f.module.capabilitySnapshot(),[]);}
});
await test('timeout suppresses a late successful reply and permits a new bounded request',async()=>{
  const f=fixture();try{await f.module.recheck();const old=f.response();f.tick(15000);assert.equal(f.events.at(-1).data.status,'unverified');assert.notEqual(f.module.validate(f.owner,old),true);await f.module.recheck();assert.notEqual(f.module.validate(f.owner,old),true);assert.equal(f.module.readiness().pending,1);}finally{f.module.dispose();}
});
await test('disconnect invalidates completed success and cancels pending scans',async()=>{
  const f=fixture();await f.module.recheck();await f.deliver(f.response());f.disconnect();assert.equal(f.events.at(-1).data.status,'closed');assert.equal(f.module.readiness().available,false);assert.equal(f.module.latest.size,0);f.module.dispose();
  const wait=deferred(),g=fixture({collect:()=>wait.promise});const work=g.module.recheck();await drain();g.disconnect();assert.equal(g.scans[0].signal.aborted,true);wait.resolve(inventory());await work;assert.equal(g.sends.length,0);g.module.dispose();
});
await test('incoming replay and request rate cannot trigger repeated collection',async()=>{
  const f=fixture();try{const message=f.incoming();await f.deliver(message);assert.notEqual(f.module.validate(f.owner,message),true);assert.notEqual(f.module.validate(f.owner,f.incoming(inventory(),'another')),true);assert.equal(f.scans.length,1);f.tick(1500);await f.deliver(f.incoming(inventory(),'new-after-interval'));assert.equal(f.scans.length,2);}finally{f.module.dispose();}
});
await test('one batch coalesces local reads across multiple registered peers',async()=>{
  const f=fixture({peers:4});try{await f.module.recheck();assert.equal(f.scans.length,1);assert.equal(f.sends.length,4);assert.equal(new Set(f.sends.map(v=>v.data.requestId)).size,4);assert.equal(f.module.readiness().pending,4);}finally{f.module.dispose();assert.equal(f.timers.size,0);}
});
await test('incoming concurrency is bounded and simultaneous requests share one local scan',async()=>{
  const wait=deferred(),f=fixture({peers:5,collect:()=>wait.promise});try{const calls=[];for(let i=0;i<4;i++){const peer='peer-'+i,owner=f.records.get(peer).owner,message=f.incoming(inventory(),'remote-'+i);message.sessionId='connection-'+i;message.data.connectionSessionId=message.sessionId;calls.push(f.deliver(message,owner));}await drain();assert.equal(f.scans.length,1);const last=f.incoming(inventory(),'remote-4');last.sessionId='connection-4';last.data.connectionSessionId=last.sessionId;assert.notEqual(f.module.validate(f.records.get('peer-4').owner,last),true);wait.resolve(inventory());await Promise.all(calls);assert.equal(f.sends.length,4);}finally{wait.resolve(inventory());f.module.dispose();}
});
await test('collection failure replies with an explicit metadata error and never claims equality',async()=>{
  const f=fixture({collect:()=>{throw Error('E:/private/root')}});try{await f.deliver(f.incoming());assert.equal(f.sends[0].data.error,'inventory-unavailable');assert.equal('inventory'in f.sends[0].data,false);assert.doesNotMatch(JSON.stringify(f.events)+JSON.stringify(f.sends),/private/);assert.equal(f.events.at(-1).data.status,'unverified');assert.equal(f.events.some(e=>e.type==='manifest_diff'),false);}finally{f.module.dispose();}
});
await test('remote inventory failure closes only its matching health request',async()=>{
  const f=fixture();try{await f.module.recheck();const r=f.response();delete r.data.inventory;r.data.error='inventory-unavailable';await f.deliver(r);assert.equal(f.events.at(-1).data.status,'unverified');assert.equal(f.events.some(e=>e.type==='manifest_diff'),false);assert.equal(f.module.readiness().available,true);}finally{f.module.dispose();}
});
await test('zero enabled packages with failed inventory cannot claim verified file collection',()=>{
  const v={...inventory(),exts:[],installed:[],contents:{},inventoryError:'unreadable'};assert.equal(compareManifests(v,v).inventoryVerified,false);
});
await test('new comparison agrees with the existing game manifest on all legacy result fields',()=>{
  const source=readFileSync(new URL('../online-kernel/src/manifest.js',import.meta.url),'utf8');
  const legacy=new Function(source.slice(source.indexOf('    function diff(host,guest){'),source.indexOf('    function current(p)'))+';return diff;')();
  for(const change of[()=>{},v=>v.exts=[],v=>{v.installed=[];v.exts=[];v.contents={}},v=>v.contents.A.digest='b'.repeat(64),v=>v.inventoryVersion=0,v=>{delete v.contents},v=>v.packs=[],v=>v.cards=[]]){
    const host=inventory(),guest=inventory();change(guest);const result=compareManifests(host,guest);delete result.inventoryVerified;delete result.inventoryErrors;assert.deepEqual(result,legacy(host,guest));
  }
});
await test('disposing a pending module aborts reads and clears timers without external actions',async()=>{
  const wait=deferred(),f=fixture({collect:()=>wait.promise});const work=f.module.recheck();await drain();f.module.dispose();assert.equal(f.scans[0].signal.aborted,true);assert.equal(f.timers.size,0);wait.resolve(inventory());await work;assert.equal(f.sends.length,0);assert.equal(f.module.readiness().available,false);assert.equal(f.module.readiness().pendingScans,0);f.module.dispose();
});
await test('actual TransportOwner dispatch carries only correlated metadata and preserves the current channels',async()=>{
  class Channel{constructor(label){this.label=label;this.readyState='connecting';this.sent=[];}send(raw){this.sent.push(raw);}open(){this.readyState='open';this.onopen?.();}close(){this.readyState='closed';}}
  class PC{constructor(){this.connectionState='connected';this.channels=[];}createDataChannel(label){const channel=new Channel(label);this.channels.push(channel);return channel;}close(){this.connectionState='closed';}}
  const rtc={RTCPeerConnection:PC,encodeCode(){},decodeCode(){},waitGather(){},startPing:()=>({stop(){}})};
  const host=fixture(),guest=fixture({role:'guest'}),failures=[];
  function actual(f,role){f.module.forgetPeer(f.peer);let owner;owner=new TransportOwner({role,sessionId:'connection-0',peerId:role,remotePeerId:role==='host'?'guest':'host',rtc,
    validateControl:frame=>f.module.validate(owner,frame),onControl:frame=>f.module.control(owner,frame),onControlFailure:error=>failures.push(error),onGame:()=>assert.fail('Health must not send game payloads')});
    if(role==='guest')for(const label of['nnk-link','nnk-ping'])owner.pc.ondatachannel({channel:new Channel(label)});
    f.records.get(f.peer).owner=owner;owner.link.open();owner.ping.open();return owner;
  }
  const h=actual(host,'host'),g=actual(guest,'guest');
  h.link.onmessage({data:g.link.sent[0]});g.link.onmessage({data:h.link.sent[0]});assert.equal(h.ready,true);assert.equal(g.ready,true);
  host.module.setPeerCapability(host.peer);guest.module.setPeerCapability(guest.peer);
  for(const f of[host,guest]){const record=f.sessions.sendControl.bind(f.sessions);f.sessions.sendControl=(peer,type,data)=>{record(peer,type,data);return f.sessions.getOwner(peer).sendControl(type,data);};}
  let hi=1,gi=1;async function flush(){for(let turn=0;turn<12;turn++){while(hi<h.link.sent.length)g.link.onmessage({data:h.link.sent[hi++]});while(gi<g.link.sent.length)h.link.onmessage({data:g.link.sent[gi++]});await drain();}}
  const hlink=h.link,glink=g.link;
  try{await host.module.recheck();await flush();const firstDetail=JSON.stringify({host:h.snapshot(),guest:g.snapshot(),hostEvents:host.events,guestEvents:guest.events,hostDiagnostics:h.diagnostics,guestDiagnostics:g.diagnostics});assert.equal(host.events.at(-1).data.status,'verified',firstDetail);assert.equal(guest.events.at(-1).data.status,'verified',firstDetail);
    await guest.module.recheck();await flush();const detail=JSON.stringify({host:h.snapshot(),guest:g.snapshot(),hostEvents:host.events,guestEvents:guest.events,hostDiagnostics:h.diagnostics,guestDiagnostics:g.diagnostics});assert.equal(host.events.at(-1).data.status,'verified',detail);assert.equal(guest.events.at(-1).data.status,'verified',detail);
    const before=h.snapshot().lastAcceptedControlSeq;h.link.onmessage({data:JSON.stringify({protocol:'keepalive/1',kind:'control',sessionId:'connection-0',sourcePeer:'guest',seq:999,type:'batch_tx',data:{protocol:LOBBY_MANIFEST_PROTOCOL}})});
    assert.equal(h.snapshot().lastAcceptedControlSeq,before);assert.equal(h.link,hlink);assert.equal(g.link,glink);assert.equal(h.snapshot().gameSent,0);assert.equal(g.snapshot().gameSent,0);assert.deepEqual(failures,[]);
  }finally{host.module.dispose();guest.module.dispose();h.stopTransport('synthetic cleanup');g.stopTransport('synthetic cleanup');}
});
console.log(`\n全部通过: ${count} 项（内存协议与只读比较；不替代原生或双机验收）`);

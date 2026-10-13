#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = name => readFileSync(new URL('../online-kernel/src/'+name+'.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
async function drain() { for(let i=0;i<25;i++) await Promise.resolve() }
function fixture(options={}) {
  const pcs=[], signals=[], events=[], timers=new Map(), storage=new Map(), saves=[]; let id=0, reloads=0, resumes=0, closes=0, nativeServers=0
  class PC {
    constructor() { this.offer=deferred(); this.remote=deferred(); this.channels=[]; this.closed=0; this.locals=0; this.connectionState='new'; this.signalingState='have-local-offer'; this.localDescription={type:'offer',sdp:'fixture'}; pcs.push(this) }
    createDataChannel(label) { const c={label,readyState:'connecting',bufferedAmount:0,sent:[],send(data){this.sent.push(data)},close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.()}}; this.channels.push(c); return c }
    createOffer(){return this.offer.promise} createAnswer(){return Promise.resolve({type:'answer',sdp:'fixture'})}
    setLocalDescription(){this.locals++;return Promise.resolve()} setRemoteDescription(){this.remotes=(this.remotes||0)+1;return this.remote.promise}
    close(){if(this.closed)return;this.closed++;this.connectionState='closed';this.channels.forEach(c=>c.close())}
  }
  const nnk={state:{},modules:{},env:{lib:{config:{},configprefix:'b5-',translate:{},mode:{},node:{clients:[]},message:{server:{}},onover:[],init:{connection(conn){conn.on('close',()=>closes++);options.connection?.(conn)}},configOL:{mode:'single',number:2}},
    _status:{connectMode:true},get:{connectNickname:()=> 'host'},ui:{create:{roomInfo(){},chat(){}},click:{exit(){}}},
    game:{players:[],saveConfig(...args){saves.push(args.at(-1))},reload(){reloads++},createServer(){nativeServers++},switchMode(){},resume(){resumes++},over(){nnk.env._status.over=true;const result=options.over?.(nnk);nnk.env.lib.onover.forEach(fn=>fn());return result}},
  }}
  nnk.modules.bridge={emit:(type,data)=>events.push({type,data}),setPhase:(phase,data)=>events.push({phase,data})}
  nnk.modules.config={get:()=>[]}
  nnk.modules.signaling={roomTopic:(c,l)=>c+'/'+l,openRoomSession:(code,role,topics,cb,signal)=>{const d=deferred(); const e={...d,cb,signal,ended:0};e.session={publish:()=>Promise.resolve(),publishRaw(){},end:()=>e.ended++};signals.push(e);return e.promise}}
  const timer=(fn,ms)=>{timers.set(++id,{fn,ms});return id}
  const context={window:{__nnk__:nnk},RTCPeerConnection:PC,AbortController,crypto:{getRandomValues(bytes){bytes.fill(pcs.length+signals.length)}},Uint8Array,
    setTimeout:timer,setInterval:timer,clearTimeout:n=>timers.delete(n),clearInterval:n=>timers.delete(n),Date,TextEncoder,TextDecoder,console:{log(){},error(){},warn(){}},btoa,atob,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}}
  runInNewContext(source('rtc'),context);nnk.modules.rtc.waitGather=()=>Promise.resolve();nnk.modules.rtc.trackPc=()=>{};nnk.modules.rtc.directHosts=()=>[];nnk.modules.rtc.addInjected=()=>0
  const nativeOver=nnk.env.game.over
  runInNewContext(source('host'),context);nnk.modules.host.init()
  return {nnk,pcs,signals,events,timers,saves,storage,nativeOver,stats:()=>({reloads,resumes,closes,nativeServers})}
}
let passed=0,failed=0
async function test(name,fn){try{await fn();passed++;console.log('  ✓ '+name)}catch(e){failed++;console.error('  ✗ '+name+': '+e.message)}}
function invite(k){k.nnk.modules.host.refreshInvite('invite');return k.pcs.at(-1)}
function openInvite(k,pc){const c=pc.channels[0];c.readyState='open';c.onopen();return k.nnk.state.host.bridges.at(-1)}
function load(k) { k.nnk.state.host.stage='loaded';k.nnk.env.game.createServer();k.nnk.env._status.waitingForPlayer=true }
await test('dissolve keeps engine owner and prevents rebuilding over a running game',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env.game.players=[{}];k.nnk.env._status.waitingForPlayer=false
  const pc=invite(k),conn=openInvite(k,pc);api.cancelAll();assert.equal(pc.closed,0)
  assert.ok(k.nnk.state.host.engineOwner?.bridges.includes(conn));const count=k.events.length;api.createInternetRoom('identity')
  assert.equal(k.nnk.state.host.active,false);assert.equal(k.stats().reloads,0);assert.ok(k.events.slice(count).some(e=>e.type==='error'))
  k.nnk.env.game.over();assert.equal(pc.closed,0);assert.equal(k.nnk.state.host.engineOwner.ended,true)
  conn.send(JSON.stringify(['settlement']));assert.equal(pc.channels[0].sent.at(-1),'["settlement"]')
  k.nnk.env.game.reload();assert.equal(pc.closed,1);assert.equal(k.stats().closes,1);assert.equal(k.nnk.state.host.engineOwner,null);assert.equal(k.timers.size,0)
})
await test('native game.over stays unchanged and local end hook registers once',()=>{
  const k=fixture();assert.equal(k.nnk.env.game.over,k.nativeOver);assert.equal(k.nnk.env.lib.onover.length,1)
  k.nnk.modules.host.init();assert.equal(k.nnk.env.game.over,k.nativeOver);assert.equal(k.nnk.env.lib.onover.length,1)
})
await test('normal settlement keeps current room connection and original room-code reload behavior',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc);const code=k.nnk.state.host.roomCode
  k.nnk.env.game.over();assert.equal(pc.closed,0);assert.equal(k.nnk.state.host.engineOwner.ended,true)
  k.nnk.env.game.reload();assert.equal(k.stats().reloads,0);assert.equal(k.storage.get('b5-nnk_host_roomcode'),code)
  k.saves.filter(x=>typeof x==='function').at(-1)();assert.equal(k.stats().reloads,1);assert.equal(pc.closed,0)
})
await test('local end observation cannot interrupt later native end hooks',()=>{
  const k=fixture();let observed=0;const owner={bridges:[]};Object.defineProperty(owner,'ended',{set(){throw new Error('failed observation')}});k.nnk.state.host.engineOwner=owner;k.nnk.env.lib.onover.push(()=>observed++)
  assert.doesNotThrow(()=>k.nnk.env.game.over());assert.equal(observed,1)
})
await test('stale MQTT offer cannot create a PC after dissolve and rebuild',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const old=k.signals[0];api.cancelAll();api.createInternetRoom('single')
  old.cb('old/offer',{guestId:'abcd',sdp:{}});assert.equal(k.pcs.length,0)
})
await test('cancelled invitation offer cannot install descriptions or publish into new room',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k);api.cancelAll();api.createInternetRoom('single');const count=k.events.length
  pc.offer.resolve({});await drain();assert.equal(pc.locals,0);assert.equal(k.events.length,count);assert.equal(pc.closed,1)
})
await test('old invite answer completion cannot create retries in a new room',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k);pc.offer.resolve({});await drain()
  const entry=k.nnk.state.host.invites[0];api.acceptAnswer(entry.id,k.nnk.modules.rtc.encodeCode('answer',{type:'answer',sdp:'fixture'}));api.cancelAll();api.createInternetRoom('single')
  pc.remote.resolve();await drain();pc.connectionState='failed';pc.onconnectionstatechange?.();assert.equal(k.nnk.state.host.invites.length,0)
})
await test('dissolve cancels pending start gate before new clients become ready',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');k.nnk.env._status.waitingForPlayer=true;k.nnk.env.lib.node.clients=[{inited:false}]
  k.nnk.env.game.resume();const callbacks=[...k.timers.values()].map(t=>t.fn);api.cancelAll();k.nnk.env.lib.node.clients=[];callbacks.forEach(fn=>fn());assert.equal(k.stats().resumes,0)
})
await test('saveConfig callbacks from a dissolved room cannot reload a new room',()=>{
  const k=fixture(),api=k.nnk.modules.host;k.nnk.env._status.connectMode=false;api.createInternetRoom('single');const saved=k.saves.filter(x=>typeof x==='function');api.cancelAll();k.nnk.env._status.connectMode=true;api.createInternetRoom('single');saved.forEach(fn=>fn());assert.equal(k.stats().reloads,0)
})
await test('next mode selection does not alter loaded game capacity',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);api.setRoomMode('identity')
  const payload=k.events.filter(e=>e.type==='room_members').at(-1).data;assert.equal(payload.capacity,2)
})
await test('dissolve releases parked invitations and all their timers',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k);openInvite(k,pc);api.cancelAll();assert.equal(pc.closed,1);assert.equal(k.timers.size,0)
})
for(const kind of ['close','throw']) await test('synchronous native admission '+kind+' never resurrects an engine bridge',()=>{
  const k=fixture({connection(conn){if(kind==='close')conn.close();else throw new Error('native admission failed')}}),api=k.nnk.modules.host
  api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc)
  assert.equal(pc.closed,1);assert.equal(k.nnk.state.host.engineOwner.bridges.length,0);assert.equal(k.nnk.state.host.bridges.length,0)
  assert.equal(k.events.filter(e=>e.type==='guest_connected').length,0)
})
await test('same room restart invalidates old save callbacks',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env._status.waitingForPlayer=true
  api.restartRoom('single');const old=k.saves.filter(x=>typeof x==='function');api.restartRoom('identity');old.forEach(fn=>fn());assert.equal(k.stats().reloads,0)
  k.saves.filter(x=>typeof x==='function').at(-1)();assert.equal(k.stats().reloads,1)
})
await test('same room in-place restart invalidates old fallback watchdog',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');api.restartRoom('single')
  const old=[...k.timers.values()].filter(t=>t.ms===12000).map(t=>t.fn);api.restartRoom('identity');old.forEach(fn=>fn())
  assert.equal(k.storage.has('b5-nnk_host_pending'),false);assert.equal(k.stats().reloads,0)
  ;[...k.timers.values()].find(t=>t.ms===12000).fn();assert.equal(JSON.parse(k.storage.get('b5-nnk_host_pending')).mode,'identity')
})
await test('parked guest receives closed stage before channel closure',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k);openInvite(k,pc);api.cancelAll()
  assert.ok(pc.channels[0].sent.some(s=>JSON.parse(s).nnk_stage==='closed'));assert.equal(pc.closed,1)
})
await test('waiting room vacancy promotes exactly one queued guest',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env._status.waitingForPlayer=true
  const first=invite(k),a=openInvite(k,first),second=invite(k),b=openInvite(k,second);assert.ok(a._entered);assert.ok(b._queued)
  a.close();assert.ok(b._entered);assert.equal(k.nnk.state.host.engineOwner.bridges.length,1)
})
await test('ongoing game vacancy never promotes queued guest',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env.game.players=[{}];k.nnk.env._status.waitingForPlayer=false
  const a=openInvite(k,invite(k)),b=openInvite(k,invite(k));a.close();assert.ok(b._queued);assert.ok(!b._entered)
})
await test('capacity changes use current engine mode rather than next selected mode',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('identity');k.nnk.env.lib.configOL={mode:'identity',number:2};load(k)
  const a=openInvite(k,invite(k));api.setRoomMode('single');k.nnk.env.lib.configOL.number=3;const b=openInvite(k,invite(k))
  assert.ok(a._entered&&b._entered);const payload=k.events.filter(e=>e.type==='room_members').at(-1).data;assert.equal(payload.capacity,3);assert.equal(payload.mode,'identity');assert.equal(payload.nextMode,'single')
})
await test('late MQTT session ends once without heartbeat or new room mutation',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const old=k.signals[0];api.cancelAll();api.createInternetRoom('single');const n=k.events.length
  old.resolve(old.session);await drain();assert.equal(old.ended,1);assert.ok(old.signal.aborted);assert.equal(k.events.length,n);assert.equal(k.nnk.state.host.mqttSession,null)
})
await test('MQTT in-flight PC is closed on rotation and late description cannot publish',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const s=k.signals[0];s.resolve(s.session);await drain()
  s.cb('room/offer',{guestId:'abcd',sdp:{}});const pc=k.pcs[0];api.refreshInvite();pc.remote.resolve();await drain();assert.equal(pc.closed,1);assert.equal(pc.locals,0)
})
await test('MQTT adopted connection survives dissolve until native close',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const s=k.signals.at(-1);s.resolve(s.session);await drain();s.cb('room/offer',{guestId:'abcd',sdp:{}})
  const pc=k.pcs[0],c=pc.createDataChannel('nnk-link');pc.ondatachannel({channel:c});c.readyState='open';c.onopen();const conn=k.nnk.state.host.bridges[0]
  api.cancelAll();assert.equal(pc.closed,0);assert.equal(s.ended,1);conn.close();assert.equal(pc.closed,1);assert.equal(k.stats().closes,1);assert.equal(k.timers.size,0)
})
await test('explicit native exit closes retained engine PC exactly once',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc);api.cancelAll();k.nnk.env.ui.click.exit();k.nnk.env.ui.click.exit()
  assert.equal(pc.closed,1);assert.equal(k.stats().closes,1);assert.equal(k.nnk.state.host.engineOwner,null)
})
await test('native game over error preserves error and leaves cleanup to explicit exit',()=>{
  const k=fixture({over(){throw new Error('native over failed')}}),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc);api.cancelAll()
  assert.throws(()=>k.nnk.env.game.over(),/native over failed/);assert.equal(pc.closed,0);k.nnk.env.ui.click.exit();assert.equal(pc.closed,1);assert.equal(k.stats().closes,1)
})
await test('async old game over cannot close a replacement engine owner',async()=>{
  const d=deferred(),k=fixture({over:()=>d.promise}),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const oldPc=invite(k);openInvite(k,oldPc);api.cancelAll();const done=k.nnk.env.game.over()
  k.nnk.env.ui.click.exit();api.createInternetRoom('identity');load(k);const newPc=invite(k);openInvite(k,newPc);api.cancelAll();d.resolve('result');assert.equal(await done,'result');assert.equal(newPc.closed,0)
})
await test('HostBridge close hooks cannot swallow native close or deliver it twice',()=>{
  const k=fixture() // standalone channel without room ownership
  const c={readyState:'open',send(){},close(){this.onclose()}},conn=new k.nnk.modules.rtc.HostBridge(c);let native=0
  conn.onDown(()=>{conn.onclose=null;throw new Error('hook failure')});conn.on('close',()=>native++);conn.close();conn.close();assert.equal(native,1)
})
for(const order of [['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']]) await test('adopted invitation closes once: '+order.join('/'),()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc)
  pc.channels[1].readyState='open';pc.channels[1].onopen();const ice=pc.onconnectionstatechange
  api.cancelAll();for(const event of order){if(event==='ice'){pc.connectionState='failed';ice()}else pc.channels[event==='main'?0:1].close()}
  assert.equal(pc.closed,1);assert.equal(k.stats().closes,1);assert.equal(k.timers.size,0)
})
await test('duplicate invitation answers cannot concurrently apply SDP',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k),id=k.nnk.state.host.invites[0].id,code=k.nnk.modules.rtc.encodeCode('answer',{type:'answer',sdp:'fixture'})
  api.acceptAnswer(id,code);api.acceptAnswer(id,code);await drain();assert.equal(pc.remotes,1);pc.remote.resolve();await drain();assert.equal(k.nnk.state.host.invites[0].status,'answering')
})
await test('invitation SDP rejection retires PC and timers without concurrent retry',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k),entry=k.nnk.state.host.invites[0]
  api.acceptAnswer(entry.id,k.nnk.modules.rtc.encodeCode('answer',{type:'answer',sdp:'fixture'}));await drain();pc.remote.reject(new Error('bad SDP'));await drain()
  assert.equal(entry.status,'dead');assert.equal(pc.closed,1);assert.equal(k.timers.size,0)
})
await test('hung invitation SDP times out once and late completion cannot touch replacement',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k),entry=k.nnk.state.host.invites[0]
  api.acceptAnswer(entry.id,k.nnk.modules.rtc.encodeCode('answer',{type:'answer',sdp:'fixture'}));await drain();const timeout=[...k.timers.values()].find(t=>t.ms===45000).fn;timeout();timeout()
  assert.equal(k.pcs.length,2);assert.equal(pc.closed,1);const n=k.events.length;pc.remote.resolve();await drain();assert.equal(k.events.length,n)
})
await test('cancelled invitation SDP never starts application or retry',async()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k),entry=k.nnk.state.host.invites[0]
  api.acceptAnswer(entry.id,k.nnk.modules.rtc.encodeCode('answer',{type:'answer',sdp:'fixture'}));api.refreshInvite('cancel',entry.id);await drain();assert.equal(pc.remotes,undefined);assert.equal(pc.closed,1);assert.equal(k.timers.size,0)
})
await test('hung invitation generation has an expiry before offer resolves',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const pc=invite(k);[...k.timers.values()].find(t=>t.ms===600000).fn();assert.equal(pc.closed,1);assert.equal(k.nnk.state.host.invites[0].status,'dead')
})
await test('duplicate createServer preserves already admitted native clients',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);openInvite(k,invite(k));const clients=k.nnk.env.lib.node.clients
  clients.push({native:true});k.nnk.env.game.createServer();assert.equal(k.nnk.env.lib.node.clients,clients);assert.equal(clients.length,1)
})
await test('load generation cancels a same room old start gate',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env._status.waitingForPlayer=true;k.nnk.env.lib.node.clients=[{inited:false}]
  k.nnk.env.game.resume();const old=[...k.timers.values()].filter(t=>t.ms===1000).map(t=>t.fn);api.restartRoom('identity');k.nnk.env.lib.node.clients=[];old.forEach(fn=>fn());assert.equal(k.stats().resumes,0)
})
await test('late engine createServer from cancelled load cannot start native server or overwrite new lobby',()=>{
  const k=fixture(),api=k.nnk.modules.host;k.nnk.env.game.createServer();assert.equal(k.stats().nativeServers,1)
  api.createInternetRoom('single');api.restartRoom('single');api.cancelAll();k.nnk.env.game.createServer();assert.equal(k.stats().nativeServers,1)
  api.createInternetRoom('identity');k.nnk.env.game.createServer();assert.equal(k.nnk.state.host.stage,'lobby');assert.equal(k.nnk.state.host.engineOwner,undefined)
})
await test('guest arriving during in-place load parks until actual server and seats are ready',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');api.restartRoom('single');const pc=invite(k),conn=openInvite(k,pc)
  assert.ok(!conn._entered);assert.equal(k.nnk.state.host.engineOwner,undefined)
  k.nnk.env.game.createServer();assert.ok(k.nnk.state.host.engineOwner);assert.ok(!conn._entered);k.nnk.env._status.waitingForPlayer=true
  ;[...k.timers.values()].filter(t=>t.ms===200).forEach(t=>t.fn());assert.ok(conn._entered);assert.equal(pc.closed,0)
})
await test('guest arriving after server creation still waits for native seats',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');k.nnk.state.host.stage='loaded';k.nnk.env.game.createServer();const conn=openInvite(k,invite(k));assert.ok(!conn._entered)
  k.nnk.env._status.waitingForPlayer=true;[...k.timers.values()].filter(t=>t.ms===200).forEach(t=>t.fn());assert.ok(conn._entered)
})
await test('repeated resume cannot bypass an armed readiness gate',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);k.nnk.env.lib.node.clients=[{inited:false}]
  k.nnk.env.game.resume();k.nnk.env.game.resume();assert.equal(k.stats().resumes,0)
  k.nnk.env.lib.node.clients[0].inited=true;[...k.timers.values()].find(t=>t.ms===1000).fn();assert.equal(k.stats().resumes,1)
})
await test('native async over rejection preserves error and reload releases detached resources',async()=>{
  const d=deferred(),k=fixture({over:()=>d.promise}),api=k.nnk.modules.host;api.createInternetRoom('single');load(k);const pc=invite(k);openInvite(k,pc);api.cancelAll();const done=k.nnk.env.game.over()
  d.reject(new Error('native async failure'));await assert.rejects(done,/native async failure/);assert.equal(pc.closed,0)
  k.nnk.env.game.reload();assert.equal(pc.closed,1);assert.equal(k.stats().closes,1);assert.equal(k.nnk.state.host.engineOwner,null)
})
await test('overflow parked guests become queued and fill a later waiting vacancy',()=>{
  const k=fixture(),api=k.nnk.modules.host;api.createInternetRoom('single');const a=openInvite(k,invite(k)),b=openInvite(k,invite(k));load(k)
  ;[...k.timers.values()].filter(t=>t.ms===200).forEach(t=>t.fn());assert.ok(a._entered);assert.ok(b._queued&&!b._entered)
  assert.ok(b.channel.sent.some(s=>JSON.parse(s).nnk_stage==='queued'));a.close();assert.ok(b._entered)
})
await test('workshop refresh restores next selected mode while keeping current engine mode',()=>{
  const client=readFileSync(new URL('../client.js',import.meta.url),'utf8'),start=client.indexOf('function onlinePickEvent('),end=client.indexOf('\n    }',start)+6
  const effect=client.slice(client.indexOf('      React.useEffect',client.indexOf('/* 主机模式单选跟随内核')),client.indexOf('      /* 码正文只走事件流'))
  let selected,key;const data={mode:'single',nextMode:'identity',capacity:2},ctx={React:{useEffect:fn=>fn()},status:{bridge:{events:[{type:'room_members',data}]}},rmSyncKey:null,ONLINE_MODES:[{id:'identity'},{id:'single'}],setRoomMode:m=>{selected=m},setRmSyncKey:m=>{key=m}}
  runInNewContext(client.slice(start,end)+'\n'+effect,ctx);assert.equal(selected,'identity');assert.equal(key,'identity');assert.equal(data.mode,'single')
  delete data.nextMode;runInNewContext(client.slice(start,end)+'\n'+effect,ctx);assert.equal(selected,'single')
})
console.log(`全部通过:${passed} 项; 失败:${failed}`);if(failed)process.exitCode=1

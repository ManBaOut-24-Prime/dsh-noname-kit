#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fixture,deferred,drain,until,runCases,source,enter,InitialPartyCoordinator,enrollment,endpointEngineAdapter} from './fixtures/keepalive-lifecycle.mjs';
const cases=[],test=(name,fn)=>cases.push([name,fn]);
test('dissolve retains ever-entered actual PC/link/ping and cannot rebuild an active round',async()=>{
 const f=fixture();try{const p=await f.pair();enter(p.hs,p.hostRecord,p.host);const identity=p.host.actualIdentity(),l=f.lobby({connector:p.h,sessions:p.hs});l.role='host';l.lobby={open:true,code:'ABC234',controller:new AbortController(),attempts:new Set()};await l.cancelAll();assert.equal(l.snapshot().roomCode,null);assert.equal(p.host.stopped,false);assert.deepEqual(p.host.actualIdentity(),identity);
  const c=new InitialPartyCoordinator({sessions:p.hs,engines:{}});c.role='host';c.round={...enrollment,phase:'playing',failed:false};await assert.rejects(c.start('identity'),/尚未结束/);assert.equal(p.host.snapshot().negotiations,1);
 }finally{await f.close();}
});
test('current Host delegate and endpoint do not replace native over/reload/resume/exit or onover hooks',async()=>{
 const f=fixture();try{const k=f.endpoint(),hook=()=>{};k.env.lib.onover.push(hook);runInNewContext(source('host'),{window:{__nnk__:k.nnk}});for(const key of ['over','reload','resume'])assert.equal(k.env.game[key],k.originals[key]);assert.equal(k.env.ui.click.exit,k.originals.exit);assert.deepEqual(k.env.lib.onover,[hook]);}finally{await f.close();}
});
test('per-document retirement retains transport and refuses old game sends before fresh generation',async()=>{
 const f=fixture();try{const p=await f.pair();enter(p.hs,p.hostRecord,p.host);const identity=p.host.actualIdentity(),old=p.host.currentScope;p.host.detachEngineBinding(old,'document retirement');assert.throws(()=>p.host.sendGame(old,'["settlement"]'),/retired/);p.host.attachEngine({roundId:'new-round',documentGeneration:4},{remoteDocumentGeneration:6});assert.deepEqual(p.host.actualIdentity(),identity);assert.equal(p.host.pc.closed,0);assert.equal(p.host.snapshot().negotiations,1);}finally{await f.close();}
});
test('stale MQTT offer after public rotation cannot allocate an Owner',async()=>{
 const f=fixture();try{const l=f.lobby();await l.createInternetRoom('single');const old=[...f.brokerSessions][0];await l.cancelAll();await l.createInternetRoom('identity');const count=f.owners.length;old.callback('ABC234/offer',{guestId:'123456',sdp:{type:'offer',sdp:'fixture:99'}});await drain();assert.equal(f.owners.length,count);assert.equal(old.ended,1);await l.cancelAll();}finally{await f.close();}
});
test('cancelled Host offer cannot set local SDP or emit code into rebuilt lobby',async()=>{
 const f=fixture(),d=deferred();let pending;try{const l=f.lobby();await l.createInternetRoom('single');f.plans.push({offerGate:d});pending=l.refreshInvite('invite').catch(e=>e);await until(()=>f.pcs.length===1);await l.cancelAll();await l.createInternetRoom('identity');d.resolve({type:'offer',sdp:'fixture:1'});await pending;await drain();assert.equal(f.pcs[0].locals,0);assert.equal(l.inviteMetadata().some(r=>r.status==='pending'),false);await l.cancelAll();}finally{d.resolve({type:'offer',sdp:'fixture:1'});await f.close();await pending;}
});
test('late old Host answer completion cannot touch fresh invitation or retry',async()=>{
 const f=fixture(),d=deferred();let answer;try{const l=f.lobby();await l.createInternetRoom('single');f.plans.push({remoteGate:d});await l.refreshInvite('invite');const row=l.invites[0],old=row.attempt,g=f.connector(),join=await g.joinInvite({code:old.offerText});answer=l.acceptAnswer(row.id,join.answerText).catch(e=>e);await until(()=>f.pcs[0].remotes===1);await l.cancelAll();await l.createInternetRoom('single');await l.refreshInvite('invite');const fresh=f.owners.at(-1);d.resolve();await answer;await drain();f.timers.fire(45000);assert.equal(fresh.stopped,false);assert.equal(f.pcs[0].closed,1);assert.equal(fresh.snapshot().negotiations,1);await l.cancelAll();}finally{d.resolve();await f.close();await answer;}
});
test('next selected mode does not change current endpoint actual capacity',async()=>{
 const f=fixture();try{const k=f.endpoint({capacity:2});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);const l=f.lobby({coordinator:{lobbySnapshot:()=>({mode:k.ep.snapshot().mode,capacity:k.ep.snapshot().capacity,hostEntered:true})}});l.role='host';l.lobby={open:true,code:'ABC234',controller:new AbortController(),attempts:new Set()};l.setRoomMode('identity');const data=l.bridge.events.findLast(e=>e.type==='room_members').data;assert.equal(data.mode,'single');assert.equal(data.nextMode,'identity');assert.equal(data.capacity,2);}finally{await f.close();}
});
test('dissolve releases never-entered queued Owner and pending invitation timers',async()=>{
 const f=fixture();try{const p=await f.pair(),l=f.lobby({connector:p.h,sessions:p.hs});l.role='host';l.lobby={open:true,code:'ABC234',controller:new AbortController(),attempts:new Set()};await l.refreshInvite('invite');await l.cancelAll();assert.equal(p.host.pc.closed,1);assert.equal(p.hs.list().length,0);assert.equal(p.h.resourceSnapshot().activeAttempts,0);assert.equal(l.resourceSnapshot().attempts,0);}finally{await f.close();}
});
for(const kind of ['close','throw'])test('synchronous actual endpoint admission '+kind+' cannot mark Registry entered',async()=>{
 const f=fixture();try{const k=f.endpoint({admission(socket){if(kind==='close')socket.close();else throw Error('native admission failed');}});await k.command('prepare-host',{mode:'single'});await k.command('approve-peer',{peerId:'peer'});const result=await k.command('admit',{peerId:'peer'});
  if(kind==='throw')assert.equal(result.ok,false);else assert.ok(k.posted.some(m=>m.type==='engine-close'));assert.equal(k.ep.snapshot().peerProofs[0].clientInited,false);assert.equal(k.ep.snapshot().peerProofs[0].handshake.in.inited||0,0);
 }finally{await f.close();}
});
test('capacity and duplicate admit use the current actual waiting room and preserve Client identity',async()=>{
 const f=fixture();try{const k=f.endpoint({capacity:2});await k.command('prepare-host',{mode:'single'});for(const peerId of ['a','b'])await k.command('approve-peer',{peerId});const first=await k.command('admit',{peerId:'a'}),client=k.env.lib.node.clients[0];assert.equal(first.ok,true);assert.equal((await k.command('admit',{peerId:'a'})).ok,true);assert.equal(k.stats().nativeConnections,1);assert.equal(k.env.lib.node.clients[0],client);assert.equal((await k.command('admit',{peerId:'b'})).ok,false);k.env.lib.configOL.number=3;assert.equal((await k.command('admit',{peerId:'b'})).ok,true);assert.equal(k.ep.snapshot().capacity,3);}finally{await f.close();}
});
test('ongoing game cannot promote queued Guest; actual endpoint reserves ordinal peers in its current waiting room',async()=>{
 const f=fixture();let c;try{
  const k=f.endpoint({capacity:2});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);
  const sent=[],records=[{peerId:'a',joinOrdinal:1},{peerId:'b',joinOrdinal:2}],actualOwners=new Map([[{},'a'],[{},'b']]),sessions={snapshot:()=>records,isLive:()=>true,wasEverEntered:()=>false,peerForActualOwner:o=>actualOwners.get(o),setIdentity(peer,owner){assert.equal(actualOwners.get(owner),peer);},bindEnrollment(){},sendControl:(...x)=>sent.push(x)},engines=endpointEngineAdapter(k);
  c=new InitialPartyCoordinator({sessions,engines});c.role='host';c.round={...enrollment,phase:'playing',capacity:2,failed:false};k.env._status.waitingForPlayer=false;
  for(const [owner]of actualOwners){const frame={type:'party-request',data:{protocol:'nnk-round/1',requestId:crypto.randomUUID(),partySessionId:null,roundId:null,operationId:null,identity:{name:'actual guest',avatar:'caocao'}}};assert.equal(c.validate(owner,frame),true);await c.control(owner,frame);}
  await c.promote();assert.equal(c.members.size,0);assert.equal(engines.calls.length,0);
  k.env._status.waitingForPlayer=true;c.round.phase='waiting';await c.promote();assert.equal(c.members.size,1);assert.ok(c.members.has('a'));assert.equal(sent.filter(x=>x[1]==='party-accepted').length,1);assert.deepEqual(engines.calls.map(x=>[x.action,x.args.peerId]),[['reserve-start-peer','a']]);
  const click=k.env.ui.connectStartButton.click(),touch=k.env.ui.connectStartButton.fire('touchend');assert.equal(click.allowed,false);assert.equal(touch.allowed,false);assert.equal(k.env.ui.connectStartButton.nativeCalls,0);assert.equal(k.env._status.waitingForPlayer,true);
 }finally{c?.dispose();await f.close();}
});
test('HostBridge failing down hook cannot swallow or duplicate native close callback',async()=>{
 const f=fixture();try{const channel=new f.Channel('local-shim'),bridge=new f.rtc.HostBridge(channel);let native=0;bridge.onDown(()=>{bridge.onclose=null;throw Error('hook failure');});bridge.on('close',()=>native++);bridge.close();bridge.close();assert.equal(native,1);}finally{await f.close();}
});
for(const order of [['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']])test('entered Host actual transport terminal stops once after public dissolve: '+order.join('/'),async()=>{
 const f=fixture();try{const p=await f.pair();enter(p.hs,p.hostRecord,p.host);const l=f.lobby({connector:p.h,sessions:p.hs});l.role='host';l.lobby={open:true,code:'ABC234',controller:new AbortController(),attempts:new Set()};await l.cancelAll();assert.equal(p.host.stopped,false);const ice=p.host.pc.onconnectionstatechange;
  for(const event of order){if(event==='ice'){p.host.pc.connectionState='failed';ice();}else(event==='main'?p.host.link:p.host.ping).close();}await drain();assert.equal(p.host.pc.closed,1);assert.equal(p.host.snapshot().stopEvents,1);assert.equal(p.host.snapshot().reconnectAttempts,0);assert.equal(p.hs.list().length,0);assert.equal(f.pcs.length,2);
 }finally{await f.close();}
});
test('duplicate invitation answer cannot concurrently apply original SDP',async()=>{
 const f=fixture(),d=deferred();let first;try{f.plans.push({remoteGate:d});const h=f.connector(),g=f.connector(),invite=await h.makeInvite(),join=await g.joinInvite({code:invite.offerText});first=invite.acceptAnswer(join.answerText);await assert.rejects(invite.acceptAnswer(join.answerText),/selected/);await until(()=>f.pcs[0].remotes===1);d.resolve();await first;assert.equal(f.pcs[0].remotes,1);}finally{d.resolve();await f.close();await first;}
});
for(const kind of ['reject','timeout'])test('Host invitation SDP '+kind+' stops once without concurrent retry',async()=>{
 const f=fixture(),d=deferred();let answer;try{f.plans.push({remoteGate:d});const h=f.connector({limits:{inviteAnswerMs:45}}),g=f.connector(),invite=await h.makeInvite(),join=await g.joinInvite({code:invite.offerText});answer=invite.acceptAnswer(join.answerText).catch(e=>e);await until(()=>f.pcs[0].remotes===1);kind==='reject'?d.reject(Error('bad SDP')):f.timers.fire(45);await answer;assert.equal(f.pcs[0].closed,1);assert.equal(f.owners[0].snapshot().stopEvents,1);assert.equal(f.pcs.length,2);assert.equal(f.owners[0].snapshot().reconnectAttempts,0);if(kind==='timeout')assert.equal(h.resourceSnapshot().retiredPending,1);d.resolve();await drain();assert.equal(h.resourceSnapshot().retiredPending,0);}finally{d.resolve();await f.close();await answer;}
});
test('cancel before Host answer scheduled SDP prevents native application',async()=>{
 const f=fixture();try{const h=f.connector(),g=f.connector(),invite=await h.makeInvite(),join=await g.joinInvite({code:invite.offerText}),answer=invite.acceptAnswer(join.answerText).catch(e=>e);invite.closeUnentered('user canceled');await answer;assert.equal(f.pcs[0].remotes,0);assert.equal(f.pcs[0].closed,1);}finally{await f.close();}
});
test('hung invitation generation expires before native offer returns and keeps pending truth',async()=>{
 const f=fixture(),d=deferred();let invite;try{f.plans.push({offerGate:d});const h=f.connector({limits:{inviteUnusedMs:60}});invite=h.makeInvite().catch(e=>e);await until(()=>f.pcs[0]?.offers===1);f.timers.fire(60);await invite;assert.equal(f.pcs[0].closed,1);assert.equal(h.resourceSnapshot().retiredPending,1);d.resolve({type:'offer',sdp:'fixture:1'});await drain();assert.equal(h.resourceSnapshot().retiredPending,0);assert.equal(f.pcs[0].locals,0);}finally{d.resolve({type:'offer',sdp:'fixture:1'});await f.close();await invite;}
});
test('guest metadata arriving before native admission queues, then flushes once into its current facade',async()=>{
 const f=fixture();try{const k=f.endpoint();await k.command('prepare-host',{mode:'single'});await k.command('approve-peer',{peerId:'peer'});await k.ep.handleMessage({type:'game',scope:k.scope,peerId:'peer',seq:1,raw:'["fixture-message"]'});assert.equal(k.ep.resourceSnapshot().endpoint.handshakeBuffer,1);await k.command('admit',{peerId:'peer'});assert.equal(k.ep.resourceSnapshot().endpoint.handshakeBuffer,0);assert.equal(k.ep.snapshot().peerProofs[0].appliedSeq,1);}finally{await f.close();}
});
test('retired endpoint callbacks and status timers cannot create another native server',async()=>{
 const f=fixture();try{const k=f.endpoint();await k.command('prepare-host',{mode:'single'});const late=k.env.game.createServer,callbacks=[...f.timers.timers.values()].map(x=>x.fn),count=k.stats().nativeConnections;await k.retire();assert.throws(()=>late(),/Retired/);for(const callback of callbacks)callback();assert.equal(k.stats().nativeConnections,count);assert.equal(k.ep.resourceSnapshot().endpoint.portCallbacks,0);}finally{await f.close();}
});
test('workshop refresh follows next mode while actual current mode remains',()=>{
 const client=readFileSync(new URL('../client.js',import.meta.url),'utf8'),start=client.indexOf('function onlinePickEvent('),end=client.indexOf('\n    }',start)+6,effect=client.slice(client.indexOf('      React.useEffect',client.indexOf('/* 主机模式单选跟随内核')),client.indexOf('      /* 码正文只走事件流'));let selected,key;const data={mode:'single',nextMode:'identity',capacity:2},context={React:{useEffect:fn=>fn()},status:{bridge:{events:[{type:'room_members',data}]}},rmSyncKey:null,ONLINE_MODES:[{id:'identity'},{id:'single'}],setRoomMode:m=>selected=m,setRmSyncKey:m=>key=m};runInNewContext(client.slice(start,end)+'\n'+effect,context);assert.equal(selected,'identity');assert.equal(key,'identity');assert.equal(data.mode,'single');delete data.nextMode;runInNewContext(client.slice(start,end)+'\n'+effect,context);assert.equal(selected,'single');
});
test('a peer that closes while its actual reservation reply is held is released before party acceptance',async()=>{
 const f=fixture(),reply=deferred();let c;try{
  const k=f.endpoint({capacity:2});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);
  const engines=endpointEngineAdapter(k),realCommand=engines.command.bind(engines),sent=[];let live=true,reserved=false;
  engines.command=async(action,args,b)=>{const value=await realCommand(action,args,b);if(action==='reserve-start-peer'){reserved=true;await reply.promise;}return value;};
  const sessions={snapshot:()=>[{peerId:'a',joinOrdinal:1}],isLive:()=>live,bindEnrollment(){},sendControl:(...x)=>sent.push(x)};
  c=new InitialPartyCoordinator({sessions,engines});c.role='host';c.round={...enrollment,phase:'waiting',capacity:2,failed:false};c.supportedPeers.add('a');
  const operation=c.promote();await until(()=>reserved);assert.equal(k.env.ui.connectStartButton.click().allowed,false);live=false;reply.resolve();await operation;
  assert.equal(c.members.size,0);assert.equal(sent.filter(x=>x[1]==='party-accepted').length,0);assert.deepEqual(engines.calls.map(x=>x.action),['reserve-start-peer','release-start-peer']);assert.equal(k.env.ui.connectStartButton.click().allowed,true);
 }finally{reply.resolve();c?.dispose();await f.close();}
});
test('native start between carrier snapshot and reservation keeps the new Guest queued without acceptance',async()=>{
 const f=fixture();let c;try{
  const k=f.endpoint({capacity:2});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);k.env.game.connectPlayers[1].playerid='native-existing-seat';
  const engines=endpointEngineAdapter(k),realCommand=engines.command.bind(engines),sent=[];let actualReservation;
  engines.command=async(action,args,b)=>{if(action==='reserve-start-peer'){assert.equal(k.env.ui.connectStartButton.click().allowed,true);assert.equal(k.env._status.waitingForPlayer,false);}const value=await realCommand(action,args,b);if(action==='reserve-start-peer')actualReservation=value;return value;};
  const sessions={snapshot:()=>[{peerId:'a',joinOrdinal:1}],isLive:()=>true,bindEnrollment(){},sendControl:(...x)=>sent.push(x)};
  c=new InitialPartyCoordinator({sessions,engines});c.role='host';c.round={...enrollment,phase:'waiting',capacity:2,failed:false};c.supportedPeers.add('a');await c.promote();
  assert.equal(actualReservation.reserved,false);assert.equal(actualReservation.reason,'native-game-started');assert.equal(c.members.size,0);assert.equal(sent.filter(x=>x[1]==='party-accepted').length,0);assert.equal(c.round.failed,false);
 }finally{c?.dispose();await f.close();}
});
async function completeHostFixtureHandshake(k,peerId){
 assert.equal((await k.command('reserve-start-peer',{peerId})).ok,true);assert.equal((await k.command('approve-peer',{peerId})).ok,true);assert.equal((await k.command('admit',{peerId})).ok,true);
 await k.ep.handleMessage({type:'game',scope:k.scope,peerId,seq:1,raw:'["init"]'});await k.ep.handleMessage({type:'game',scope:k.scope,peerId,seq:2,raw:'["inited"]'});
 const s=k.ep.snapshot(),client=s.clients.find(x=>x.peerId===peerId),ids=s.seats.filter(x=>x.playerid&&!x.unselectable).map(x=>x.playerid);
 return {hostClientId:client.id,hostClientInited:true,guestOnlineID:client.id,guestInited:true,hostSeats:ids,guestSeats:ids,hostDocumentGeneration:k.scope.documentGeneration,guestDocumentGeneration:2,roundId:k.scope.roundId,ordered:true,seated:true};
}
test('consumed native start button refuses a reservation while the asynchronous waiting flag remains true',async()=>{
 const f=fixture();try{
  const k=f.endpoint({capacity:2});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);k.env.game.connectPlayers[1].playerid='native-existing-seat';let resumes=0;k.env.game.resume=()=>{resumes++;};
  const originalButton=k.env.ui.connectStartButton;assert.equal(originalButton.click().allowed,true);assert.equal(resumes,1);assert.equal(originalButton.clicked,true);assert.equal(k.env.ui.connectStartButton,undefined);assert.equal(k.env._status.waitingForPlayer,true);
  const result=await k.command('reserve-start-peer',{peerId:'late'});assert.equal(result.ok,true);assert.equal(result.value.reserved,false);assert.equal(result.value.reason,'native-game-started');
 }finally{await f.close();}
});
function handshakeAdmission(facade,client,k){facade.on('message',raw=>{const m=JSON.parse(raw);if(m[0]==='init')facade.send(JSON.stringify(['init',client.id]));if(m[0]==='inited'){client.inited=true;const vacant=k.env.game.connectPlayers.find(x=>!x.playerid);assert.ok(vacant);vacant.playerid=client.id;}});facade.send('["opened"]');}
test('actual endpoint confirmation remains blocked until exact proof activation; later seat expansion retains earlier Client proof',async()=>{
 const f=fixture();try{
  let k;k=f.endpoint({capacity:3,admission:(facade,client)=>handshakeAdmission(facade,client,k)});assert.equal((await k.command('prepare-host',{mode:'identity'})).ok,true);
  const first=await completeHostFixtureHandshake(k,'a');assert.equal((await k.command('confirm-seat',{peerId:'a',proof:first})).ok,true);assert.equal(k.env.ui.connectStartButton.click().allowed,false);assert.equal(k.env.ui.connectStartButton.fire('touchend').allowed,false);
  assert.equal((await k.command('activate-seat',{peerId:'a',proof:{...first,guestOnlineID:'forged'}})).ok,false);assert.equal(k.env.ui.connectStartButton.click().allowed,false);assert.equal((await k.command('activate-seat',{peerId:'a',proof:first})).ok,true);
  const second=await completeHostFixtureHandshake(k,'b');assert.equal(k.env.ui.connectStartButton.click().allowed,false);assert.equal((await k.command('confirm-seat',{peerId:'b',proof:second})).ok,true);assert.equal(k.env.ui.connectStartButton.click().allowed,false);assert.equal((await k.command('activate-seat',{peerId:'b',proof:second})).ok,true);
  assert.equal(k.env.ui.connectStartButton.click().allowed,true);assert.equal(k.env._status.waitingForPlayer,false);
 }finally{await f.close();}
});
test('coordinator uses real endpoint confirmation, Registry enrollment, then exact activation before entered notification',async()=>{
 const f=fixture();let c;try{
  const p=await f.pair();let k;k=f.endpoint({capacity:2,admission:(facade,client)=>handshakeAdmission(facade,client,k)});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);
  const peer=p.hostRecord.peerId,proof=await completeHostFixtureHandshake(k,peer),r={partySessionId:k.scope.sessionId,roundId:k.scope.roundId,operationId:'actual-activation-operation',phase:'waiting',capacity:2,failed:false};
  p.hs.bindEnrollment(peer,r);p.host.attachEngine({roundId:r.roundId,documentGeneration:k.scope.documentGeneration},{remoteDocumentGeneration:2});const engines=endpointEngineAdapter(k),realCommand=engines.command.bind(engines),events=[];
  engines.command=async(action,args,b)=>{if(action==='confirm-seat')assert.equal(p.hs.getRecord(peer).entered,false);if(action==='activate-seat'){assert.equal(p.hs.getRecord(peer).entered,true);assert.equal(k.env.ui.connectStartButton.click().allowed,false);}return await realCommand(action,args,b);};
  c=new InitialPartyCoordinator({sessions:p.hs,engines,onEvent:(...x)=>events.push(x)});c.role='host';c.round=r;c.members.set(peer,{peerId:peer,phase:'seating',slot:1,documentGeneration:2,proof:{guestOnlineID:proof.guestOnlineID,guestInitComplete:true,guestSeatIds:proof.guestSeats,guestDocumentGeneration:2,wireSequence:'in:opened,out:init,in:init,out:inited'},timer:null});
  await c.trySeat(peer);assert.deepEqual(engines.calls.map(x=>x.action),['confirm-seat','activate-seat']);assert.equal(p.hs.getRecord(peer).entered,true);assert.equal(c.members.get(peer).phase,'entered');assert.equal(events.filter(x=>x[0]==='native-seated').length,1);assert.equal(k.env.ui.connectStartButton.click().allowed,true);
 }finally{c?.dispose();await f.close();}
});
test('Client invalidation after carrier status capture rejects real confirmation and cannot mark enrollment entered',async()=>{
 const f=fixture();let c;try{
  const p=await f.pair(),identity=p.host.actualIdentity();let k;k=f.endpoint({capacity:2,admission:(facade,client)=>handshakeAdmission(facade,client,k)});assert.equal((await k.command('prepare-host',{mode:'single'})).ok,true);
  const peer=p.hostRecord.peerId,proof=await completeHostFixtureHandshake(k,peer),r={partySessionId:k.scope.sessionId,roundId:k.scope.roundId,operationId:'actual-invalidation-operation',phase:'waiting',capacity:2,failed:false};p.hs.bindEnrollment(peer,r);p.host.attachEngine({roundId:r.roundId,documentGeneration:k.scope.documentGeneration},{remoteDocumentGeneration:2});
  const engines=endpointEngineAdapter(k),realCommand=engines.command.bind(engines);engines.command=async(action,args,b)=>{if(action==='confirm-seat')k.env.lib.node.clients[0].inited=false;return await realCommand(action,args,b);};
  c=new InitialPartyCoordinator({sessions:p.hs,engines});c.role='host';c.round=r;c.members.set(peer,{peerId:peer,phase:'seating',slot:1,documentGeneration:2,proof:{guestOnlineID:proof.guestOnlineID,guestInitComplete:true,guestSeatIds:proof.guestSeats,guestDocumentGeneration:2,wireSequence:'in:opened,out:init,in:init,out:inited'},timer:null});await c.trySeat(peer);
  assert.equal(r.failed,true);assert.equal(p.hs.getRecord(peer).entered,false);assert.equal(p.hs.wasEverEntered(peer),false);assert.equal(p.host.stopped,false);assert.deepEqual(p.host.actualIdentity(),identity);assert.deepEqual(engines.calls.map(x=>x.action),['confirm-seat']);
 }finally{c?.dispose();await f.close();}
});
test('actual endpoint seat expansion during confirmation requests a scoped fresh proof and preserves the existing deadline',async()=>{
 const f=fixture();let c;try{
  const p=await f.pair();let k;k=f.endpoint({capacity:3,admission:(facade,client)=>handshakeAdmission(facade,client,k)});assert.equal((await k.command('prepare-host',{mode:'identity'})).ok,true);
  const peer=p.hostRecord.peerId,proof=await completeHostFixtureHandshake(k,peer),r={partySessionId:k.scope.sessionId,roundId:k.scope.roundId,operationId:'actual-expansion-operation',phase:'waiting',capacity:3,failed:false};p.hs.bindEnrollment(peer,r);p.host.attachEngine({roundId:r.roundId,documentGeneration:k.scope.documentGeneration},{remoteDocumentGeneration:2});
  const frames=[],realSend=p.hs.sendControl.bind(p.hs);p.hs.sendControl=(...args)=>{frames.push(args);return realSend(...args);};const engines=endpointEngineAdapter(k),realCommand=engines.command.bind(engines);let expand=true;
  engines.command=async(action,args,b)=>{if(action==='confirm-seat'&&expand){expand=false;await completeHostFixtureHandshake(k,'second-actual-endpoint-peer');}return await realCommand(action,args,b);};
  const timer=setTimeout(()=>{},30000),m={peerId:peer,phase:'seating',slot:1,documentGeneration:2,proof:{guestOnlineID:proof.guestOnlineID,guestInitComplete:true,guestSeatIds:proof.guestSeats,guestDocumentGeneration:2,wireSequence:'in:opened,out:init,in:init,out:inited'},timer};
  c=new InitialPartyCoordinator({sessions:p.hs,engines});c.role='host';c.round=r;c.members.set(peer,m);await c.trySeat(peer);
  assert.equal(r.failed,false);assert.equal(m.phase,'seating');assert.equal(m.proof,null);assert.equal(m.timer,timer);assert.equal(m.seatRechecks,1);assert.equal(p.hs.getRecord(peer).entered,false);assert.equal(k.env.ui.connectStartButton.click().allowed,false);
  const recheck=frames.filter(x=>x[1]==='seating-recheck');assert.equal(recheck.length,1);assert.equal(recheck[0][2].partySessionId,r.partySessionId);assert.equal(recheck[0][2].roundId,r.roundId);assert.equal(recheck[0][2].operationId,r.operationId);assert.equal(recheck[0][2].hostDocumentGeneration,k.scope.documentGeneration);assert.equal(recheck[0][2].guestDocumentGeneration,2);
  const ids=k.ep.snapshot().seats.filter(x=>x.playerid&&!x.unselectable).map(x=>x.playerid);m.proof={guestOnlineID:proof.guestOnlineID,guestInitComplete:true,guestSeatIds:ids,guestDocumentGeneration:2,wireSequence:'in:opened,out:init,in:init,out:inited'};await c.trySeat(peer);
  assert.equal(r.failed,false);assert.equal(m.phase,'entered');assert.equal(p.hs.getRecord(peer).entered,true);assert.equal(m.timer,null);assert.deepEqual(engines.calls.map(x=>x.action),['confirm-seat','confirm-seat','activate-seat']);assert.equal(k.env.ui.connectStartButton.click().allowed,false,'other unactivated actual endpoint peer must still block start');
 }finally{c?.dispose();await f.close();}
});
await runCases(cases);

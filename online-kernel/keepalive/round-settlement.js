import {sameScope} from './engine-binding.js';
import {NATIVE_OVER_SHA256} from './native-settlement.js';
const TYPES=new Set(['settle-fence','settle-ack','round-settled']);
const KEYS=['partySessionId','roundId','operationId'];
const same=(a,b)=>!!a&&!!b&&KEYS.every(key=>a[key]===b[key]);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scope=value=>value&&Object.keys(value).length===6&&['sessionId','roundId','bindingId','bindingNonce','expectedOrigin'].every(key=>id(value[key]))&&Number.isSafeInteger(value.documentGeneration)&&value.documentGeneration>0;
const clone=value=>JSON.parse(JSON.stringify(value));
export class RoundSettlement {
 constructor(coordinator,{deadlineMs=12000}={}){if(!Number.isFinite(deadlineMs)||deadlineMs<1||deadlineMs>12000)throw Error('Settlement deadline may only be lowered from 12000 ms');this.c=coordinator;this.deadlineMs=deadlineMs;this.ledger=new Map();this.applied=new Map();this.host=null;this.guest=null;this.tail=null;this.timer=null;this.pending=new Set();this.closed=false;}
 current(r,b){return !this.closed&&!!b&&!!b.scope&&!b.closed&&this.c.live(r)&&this.c.round===r&&this.c.engines.current===b&&b.scope.sessionId===r.partySessionId&&b.scope.roundId===r.roundId;}
 envelope(r,data){return this.c.envelope(r,{protocol:'nnk-settle/1',...data});}
 send(peer,type,r,data){return this.c.sessions.sendControl(peer,type,this.envelope(r,data));}
 sent(b,peer,seq,terminal){
  const r=this.c.round;if(!this.current(r,b))return;
  const previous=this.ledger.get(peer)||{seq:0,terminalSeq:null,terminalHash:null};
  if(!Number.isSafeInteger(seq)||seq<=previous.seq)throw Error('Actual sent game sequence must advance');
  previous.seq=seq;if(terminal){if(!hash(terminal.rawHash)||terminal.codec!==NATIVE_OVER_SHA256)throw Error('Invalid native terminal metadata');previous.terminalSeq=seq;previous.terminalHash=terminal.rawHash;previous.codec=terminal.codec;}
  this.ledger.set(peer,previous);
  if(this.c.role==='guest'&&this.guest?.round===r&&seq>this.guest.data.guestFinalSeq){this.guest.acked=false;r.settlementReady=false;r.phase='settling';this.c.cancelNextPreparation?.('本机结算后出现新的输出');}
  if(this.host?.round===r&&this.host.sentFences&&previous.seq>this.host.fences.get(peer)?.finalSeq){
   this.host.acks.clear();r.phase='settling';r.settlementReady=false;this.c.cancelNextPreparation?.('本局出现新的输出，结算确认已失效');
   this.c.engines.command('settlement-state',{phase:'settling',ready:false},b).catch(error=>{if(this.current(r,b))this.unavailable(r,error.message);});
   this.publishFences(r,b);
  }
 }
 validate(owner,frame){
  if(!TYPES.has(frame.type))return null;
  const r=this.c.round,b=this.c.engines.current,d=frame.data,peer=this.c.sessions.peerForActualOwner(owner);
  if(!this.current(r,b)||!peer||!this.c.sessions.isLive(peer)||d.protocol!=='nnk-settle/1'||!same(r,d)||!id(d.requestId))return 'retired-settlement-control';
  if(frame.type==='settle-fence'){
   if(this.c.role!=='guest'||peer!==this.c.guestPeer||d.targetPeerId!==r.remotePeerToken||!scope(d.hostScope)||d.hostScope.sessionId!==r.partySessionId||d.hostScope.roundId!==r.roundId||d.hostScope.documentGeneration!==r.hostDocumentGeneration||d.guestGeneration!==b.scope?.documentGeneration||!id(d.barrierId)||!Number.isSafeInteger(d.revision)||d.revision<1||d.revision>16||!Number.isSafeInteger(d.guestFinalSeq)||d.guestFinalSeq<1||!Number.isSafeInteger(d.finalSeq)||!Number.isSafeInteger(d.terminalSeq)||d.terminalSeq<1||d.finalSeq<d.terminalSeq||!hash(d.terminalHash)||!hash(d.rosterDigest))return 'invalid-current-settlement-fence';
   if(this.guest&&this.guest.round===r&&(d.barrierId!==this.guest.data.barrierId||d.revision<this.guest.data.revision||d.revision===this.guest.data.revision&&JSON.stringify(d)!==JSON.stringify(this.guest.data)))return 'old-or-conflicting-settlement-fence';
   if(this.tail?.round===r&&(d.finalSeq<this.tail.seq||d.terminalSeq!==this.tail.terminalSeq||d.terminalHash!==this.tail.terminalHash))return 'pre-tail-settlement-fence';
   return true;
  }
  if(frame.type==='settle-ack'){
   const h=this.host,m=this.c.members.get(peer),f=h?.fences.get(peer);
   return this.c.role==='host'&&h?.round===r&&!!m&&!!f&&d.barrierId===h.barrierId&&d.revision===h.revision&&d.fenceRequestId===f.requestId&&scope(d.guestScope)&&sameScope(d.guestScope,m.engineScope)&&d.hostGeneration===b.scope.documentGeneration&&d.guestSentSeq===f.guestFinalSeq&&d.appliedSeq===f.finalSeq&&d.receivedSeq===f.finalSeq&&d.terminalSeq===f.terminalSeq&&d.terminalHash===f.terminalHash&&d.nativeEnded===true&&d.nativeOverUnchanged===true&&d.sequenceGap===false&&d.pendingOfficialHandlers===0&&hash(d.domHash);
  }
  return this.c.role==='guest'&&peer===this.c.guestPeer&&this.guest?.round===r&&this.guest.acked===true&&d.barrierId===this.guest.data.barrierId&&d.revision===this.guest.data.revision&&d.rosterDigest===this.guest.data.rosterDigest&&d.guestGeneration===b.scope.documentGeneration;
 }
 engineEvent(b,name,data){
  const r=this.c.round;if(!this.current(r,b))return;
  if(name==='native-round-ended'&&this.c.role==='host'){
   if(data.canonical!==true||data.nativeEnded!==true||data.nativeTailObserved!==true||data.nativeOverUnchanged!==true||data.dom?.present!==true){this.unavailable(r,'当前原生结算边界无法核验');return;}
   const peers=data.roster.map(row=>row.peerId).sort(),members=[...this.c.members.values()].filter(m=>m.phase==='entered').map(m=>m.peerId).sort();
   if(!peers.length||data.codec!==NATIVE_OVER_SHA256||JSON.stringify(peers)!==JSON.stringify(members)||peers.some(peer=>{const terminal=data.terminalFrames?.find(row=>row.peerId===peer),ledger=this.ledger.get(peer);return !scope(this.c.members.get(peer)?.engineScope)||!this.c.sessions.isEntered(peer)||!ledger?.terminalSeq||terminal?.codec!==NATIVE_OVER_SHA256||terminal?.rawHash!==ledger.terminalHash;})){this.unavailable(r,'实际结算名单、文档或终端帧未匹配');return;}
   for(const row of data.roster)this.applied.set(row.peerId,row.appliedSeq);
   const rosterDigest=this.digest(JSON.stringify(data.roster.map(row=>[row.peerId,row.playerId,row.clientId]).sort()));
   this.host={round:r,bindingScope:clone(b.scope),barrierId:crypto.randomUUID(),revision:0,peers,rosterDigest,fences:new Map(),acks:new Map(),sentFences:false,native:clone(data)};
   r.phase='settling';r.settlementReady=false;this.publishFences(r,b);
  }else if(['native-terminal-applied','native-settlement-tail-applied'].includes(name)&&this.c.role==='guest'){
   if(data.canonical!==true||data.nativeEnded!==true||data.nativeOverUnchanged!==true||data.dom?.present!==true){this.unavailable(r,'当前客端原生结算应用未核验');return;}
   if(name==='native-settlement-tail-applied'){
    const tail=data.tail,identity=tail?.kind==='native-identity-reveal'&&typeof tail.popup==='boolean'&&Array.isArray(tail.playerIds)&&tail.playerIds.length>=2&&tail.playerIds.length<=8&&tail.playerIds.every(id)&&new Set(tail.playerIds).size===tail.playerIds.length&&id(tail.zhuId)&&tail.playerIds.includes(tail.zhuId),avatar=tail?.kind==='native-avatar-restore'&&id(tail.playerId)&&typeof tail.name==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(tail.name);
    if(data.peerId!==this.c.guestPeer||!Number.isSafeInteger(data.terminalSeq)||data.terminalSeq<1||!hash(data.rawHash)||!Number.isSafeInteger(tail?.seq)||tail.seq<=data.terminalSeq||!hash(tail.rawHash)||!identity&&!avatar||this.guest?.round===r&&(data.terminalSeq!==this.guest.data.terminalSeq||data.rawHash!==this.guest.data.terminalHash)||this.tail?.round===r&&(tail.seq<=this.tail.seq||data.terminalSeq!==this.tail.terminalSeq||data.rawHash!==this.tail.terminalHash)){this.unavailable(r,'原生展示末帧证明未匹配');return;}
    this.tail={round:r,seq:tail.seq,terminalSeq:data.terminalSeq,terminalHash:data.rawHash};
    if(this.guest?.round===r){this.guest.acked=false;this.guest.ack=null;}
    this.c.cancelNextPreparation?.('原生展示恢复后重新确认本局末帧');
   }
   r.settlementReady=false;r.phase='settling';this.c.publishState();
  }else if(name==='native-settlement-unavailable')this.unavailable(r,data.message||'原生结算观察失败');
 }
 digest(value){return require('node:crypto').createHash('sha256').update(value).digest('hex');}
 status(b,status){
  const r=this.c.round;if(!this.current(r,b)||this.c.role!=='host')return;
  for(const peer of status.peerProofs||[])if(Number.isSafeInteger(peer.appliedSeq)){const prior=this.applied.get(peer.peerId)||0;this.applied.set(peer.peerId,peer.appliedSeq);if(this.host?.round===r&&peer.appliedSeq>prior&&peer.appliedSeq>this.host.fences.get(peer.peerId)?.guestFinalSeq){this.host.acks.clear();r.phase='settling';r.settlementReady=false;this.c.cancelNextPreparation?.('客端结算后出现新的输出');this.publishFences(r,b);}}
 }
 publishFences(r,b){
  const h=this.host;if(!this.current(r,b)||h?.round!==r)return;
  if(++h.revision>16){this.unavailable(r,'结算后的输出持续变化，停止本次确认');return;}
  h.acks.clear();h.fences.clear();h.sentFences=true;
  for(const peer of h.peers){const ledger=this.ledger.get(peer),member=this.c.members.get(peer);if(!ledger?.terminalSeq||!member?.engineScope){this.unavailable(r,'当前原生结算终端帧缺失');return;}
   const data=this.envelope(r,{barrierId:h.barrierId,revision:h.revision,hostScope:clone(b.scope),targetPeerId:peer,guestGeneration:member.documentGeneration,guestFinalSeq:this.applied.get(peer),finalSeq:ledger.seq,terminalSeq:ledger.terminalSeq,terminalHash:ledger.terminalHash,rosterDigest:h.rosterDigest});
   h.fences.set(peer,data);this.c.sessions.sendControl(peer,'settle-fence',data);
  }
  clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;if(this.current(r,b)&&!r.settlementReady)this.unavailable(r,'等待所有实际玩家应用结算末帧超时');},this.deadlineMs);
  this.c.onEvent('settlement-fence',{...this.envelope(r,{}),barrierId:h.barrierId,revision:h.revision,roster:h.peers.slice(),fences:[...h.fences.values()].map(clone)});this.c.publishState();
 }
 async control(owner,frame){
  const r=this.c.round,b=this.c.engines.current,peer=this.c.sessions.peerForActualOwner(owner),d=frame.data;
  if(frame.type==='settle-fence'){
   if(this.tail?.round===r&&(d.finalSeq<this.tail.seq||d.terminalSeq!==this.tail.terminalSeq||d.terminalHash!==this.tail.terminalHash))return;
   if(this.guest?.round===r&&this.guest.acked&&d.revision===this.guest.data.revision){this.send(peer,'settle-ack',r,this.guest.ack);return;}
   const captured={round:r,data:clone(d),acked:false,ack:null};this.guest=captured;r.phase='settling';r.settlementReady=false;this.c.cancelNextPreparation?.('房主重新确认本局末帧');this.c.publishState();
   const token={};this.pending.add(token);
   try{
    await this.c.engines.command('settlement-state',{phase:'settling',ready:false},b);if(!this.current(r,b)||this.guest!==captured)return;
    await this.c.engines.wait(b,()=>{if(!this.current(r,b)||this.guest!==captured)return 'retired';const s=b.status;return s?.over===true&&s.settlement?.guest?.canonical===true&&s.peerProofs?.some(p=>p.peerId===peer&&p.appliedSeq>=d.finalSeq&&p.receivedSeq>=d.finalSeq);},'当前原生结算帧实际应用',Math.min(10000,this.deadlineMs));
    if(!this.current(r,b)||this.guest!==captured)return;
    const tail=this.tail,proof=await this.c.engines.command('settlement-proof',{},b);
    if(!this.current(r,b)||this.guest!==captured||this.tail!==tail||this.tail?.round===r&&d.finalSeq<this.tail.seq)return;
    const applied=proof.peers.find(p=>p.peerId===peer),native=proof.settlement.guest;
    if(!scope(proof.scope)||!sameScope(proof.scope,b.scope)||proof.over!==true||proof.queueCount!==0||proof.settlement.nativeOverUnchanged!==true||proof.settlement.currentDOM?.present!==true||native?.canonical!==true||native.terminalSeq!==d.terminalSeq||native.rawHash!==d.terminalHash||this.ledger.get(peer)?.seq!==d.guestFinalSeq||applied?.sequenceGap!==false||applied.pendingOfficialHandlers!==0||applied.appliedSeq!==d.finalSeq||applied.receivedSeq!==d.finalSeq)throw Error('结算末帧、双向应用序号或真实 DOM 未匹配');
    const ack={barrierId:d.barrierId,revision:d.revision,fenceRequestId:d.requestId,guestScope:clone(b.scope),hostGeneration:d.hostScope.documentGeneration,guestSentSeq:this.ledger.get(peer).seq,appliedSeq:applied.appliedSeq,receivedSeq:applied.receivedSeq,terminalSeq:native.terminalSeq,terminalHash:native.rawHash,nativeEnded:true,nativeOverUnchanged:true,sequenceGap:false,pendingOfficialHandlers:0,domHash:proof.settlement.currentDOM.hash};
    captured.acked=true;captured.ack=ack;this.send(peer,'settle-ack',r,ack);this.c.onEvent('settlement-applied-ack',{...this.envelope(r,{}),...ack});
   }catch(error){if(this.current(r,b)&&this.guest===captured)this.unavailable(r,error.message);}
   finally{this.pending.delete(token);}
  }else if(frame.type==='settle-ack'){
   const h=this.host;if(h.acks.has(peer))return;h.acks.set(peer,clone(d));
   if(h.peers.every(id=>h.acks.has(id))){
    const settledRevision=h.revision;clearTimeout(this.timer);this.timer=null;
    await this.c.engines.command('settlement-state',{phase:'settled',ready:true},b);if(!this.current(r,b)||this.host!==h||h.revision!==settledRevision||!h.peers.every(id=>h.acks.has(id)))return;
    r.phase='settled';r.settlementReady=true;r.settlementError=null;
    for(const id of h.peers)this.send(id,'round-settled',r,{barrierId:h.barrierId,revision:h.revision,rosterDigest:h.rosterDigest,guestGeneration:this.c.members.get(id).documentGeneration});
    this.c.onEvent('settlement-complete',{...this.envelope(r,{}),barrierId:h.barrierId,revision:h.revision,roster:h.peers.slice(),acks:[...h.acks.values()].map(clone)});this.c.publishState();
   }
  }else{
   if(r.settlementReady&&['settled','preparing'].includes(r.phase))return;
   const captured=this.guest;
   const currentCompletion=()=>this.current(r,b)&&this.guest===captured&&captured?.round===r&&captured.acked===true&&captured.data.barrierId===d.barrierId&&captured.data.revision===d.revision;
   const reply=await this.c.engines.command('settlement-state',{phase:'settled',ready:true,terminalSeq:captured.data.terminalSeq,finalSeq:captured.data.finalSeq},b);
   if(!currentCompletion())return;
   if(reply?.staleSettlementFence){captured.acked=false;captured.ack=null;r.phase='settling';r.settlementReady=false;this.c.cancelNextPreparation?.('原生末帧已变化，等待当前确认');this.c.publishState();return;}
   r.phase='settled';r.settlementReady=true;r.settlementError=null;this.c.publishState();
  }
 }
 unavailable(r,message){if(!this.c.live(r))return;clearTimeout(this.timer);this.timer=null;r.settlementReady=false;r.settlementError=String(message);r.phase='settling';this.c.onEvent('settlement-incomplete',{...this.envelope(r,{}),message:r.settlementError});this.c.publishState();}
 ready(){const r=this.c.round;return this.c.live(r)&&r.phase==='settled'&&r.settlementReady===true&&(this.c.role==='host'?this.host?.round===r&&this.host.peers.every(id=>this.host.acks.has(id)):this.guest?.round===r&&this.guest.acked===true);}
 snapshot(){return {ready:this.ready(),error:this.c.round?.settlementError||null,host:this.host&&{barrierId:this.host.barrierId,revision:this.host.revision,roster:this.host.peers.slice(),fences:[...this.host.fences.values()].map(clone),acks:[...this.host.acks.keys()]},guest:this.guest&&{fence:clone(this.guest.data),acked:this.guest.acked},resources:{timers:Number(this.timer!==null),pendingCommands:this.pending.size,ledger:this.ledger.size}};}
 retire(){clearTimeout(this.timer);this.timer=null;this.host=null;this.guest=null;this.tail=null;this.ledger.clear();this.applied.clear();}
 dispose(){this.closed=true;this.retire();}
}

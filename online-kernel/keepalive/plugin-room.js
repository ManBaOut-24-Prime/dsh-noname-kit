import {sameScope} from './engine-binding.js';
export const ROOM_TYPES=new Set(['room-return-proposal','room-return-prepare','room-return-ready','room-return-commit','room-return-closed','room-return-complete','room-return-cancel']);
export const ROOM_MODES=['identity','guozhan','versus','doudizhu','single'];
const KEYS=['partySessionId','roundId','operationId'];
const same=(a,b)=>!!a&&!!b&&KEYS.every(k=>a[k]===b[k]);
const id=x=>typeof x==='string'&&x.length>0&&x.length<=160;
const clone=x=>JSON.parse(JSON.stringify(x));
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);

// Between rounds retain only scalar receipts, never an old binding/game/document.
export class PluginRoom {
 constructor(c){this.c=c;this.pending=null;this.receipt=null;this.timer=null;this.closed=false;}
 current(t){return !this.closed&&this.pending===t&&this.c.live(t.round);}
 available(){return !this.closed&&!!this.receipt?.complete&&this.c.live(this.receipt.round)&&this.c.engines.current===null;}
 ready(){return this.available()&&this.receipt.round.phase==='plugin-room';}
 envelope(r,d){return this.c.envelope(r,{protocol:'nnk-room/1',...d});}
 send(peer,type,t,d={}){return this.c.sessions.sendControl(peer,type,this.envelope(t.round,{returnId:t.id,barrierId:t.barrierId,revision:t.revision,rosterDigest:t.rosterDigest,...d}));}
 validate(owner,frame){
  if(!ROOM_TYPES.has(frame.type))return null;
  const c=this.c,r=c.round,d=frame.data,peer=c.sessions.peerForActualOwner(owner),t=this.pending||this.receipt;
  if(this.closed||!peer||!c.sessions.isLive(peer)||!c.roomCapable.has(peer)||d.protocol!=='nnk-room/1'||!id(d.requestId)||!c.live(r)||!same(r,d))return 'invalid-room-return-source';
  if(frame.type==='room-return-proposal')return c.role==='host'&&id(d.proposalId)&&(c.members.get(peer)?.phase==='entered'||this.receipt?.peers.includes(peer));
  if(!id(d.returnId)||!id(d.barrierId)||!Number.isSafeInteger(d.revision)||!hash(d.rosterDigest))return 'invalid-room-return-receipt';
  if(frame.type==='room-return-prepare'){
   const fence=c.settlement.guest?.data;
   if(t)return c.role==='guest'&&peer===c.guestPeer&&d.returnId===t.id&&d.barrierId===t.barrierId&&d.revision===t.revision&&d.rosterDigest===t.rosterDigest&&sameScope(d.hostScope,t.hostScope);
   return c.role==='guest'&&peer===c.guestPeer&&c.settlement.ready()&&d.barrierId===fence?.barrierId&&d.revision===fence.revision&&d.rosterDigest===fence.rosterDigest&&sameScope(d.hostScope,fence.hostScope);
  }
  if(!t||d.returnId!==t.id||d.barrierId!==t.barrierId||d.revision!==t.revision||d.rosterDigest!==t.rosterDigest)return 'retired-room-return';
  if(frame.type==='room-return-ready')return c.role==='host'&&this.pending===t&&!t.committed&&t.peers.includes(peer)&&d.admission===true&&sameScope(d.guestScope,c.members.get(peer)?.engineScope)&&d.hostGeneration===t.hostScope.documentGeneration;
  if(frame.type==='room-return-commit')return c.role==='guest'&&peer===c.guestPeer&&t.prepared===true;
  if(frame.type==='room-return-closed')return c.role==='host'&&t.committed===true&&t.peers.includes(peer)&&sameScope(d.guestScope,t.guestScopes[peer])&&d.confirmed===true;
  if(frame.type==='room-return-complete')return c.role==='guest'&&peer===c.guestPeer&&t.localClosed===true&&d.confirmed===true;
  return frame.type==='room-return-cancel'&&typeof d.reason==='string'&&d.reason.length<=1000&&((c.role==='guest'&&peer===c.guestPeer)||(c.role==='host'&&t.peers.includes(peer)));
 }
 async begin({requestId=crypto.randomUUID()}={}){
  const c=this.c;if(this.ready())return {returned:true,returnId:this.receipt.id};
  if(this.pending)return this.pending.promise||{requested:true};
  if(!c.settlement.ready())throw Error('请等待所有实际玩家完成本局结算确认');
  if(c.role==='guest'){
   if(!c.roomCapable.has(c.guestPeer))throw Error('房主不支持返回插件房间协议');
   c.sessions.sendControl(c.guestPeer,'room-return-proposal',this.envelope(c.round,{proposalId:requestId}));return {requested:true,hostConfirmsReturn:true};
  }
  const h=c.settlement.host,peers=h.peers.slice();
  if(peers.some(p=>!c.roomCapable.has(p)||!c.continuationCapable.has(p)))throw Error('原玩家未确认返回插件房间协议');
  const binding=c.engines.current,t={id:crypto.randomUUID(),round:c.round,peers,hostScope:clone(binding.scope),localScope:clone(binding.scope),barrierId:h.barrierId,revision:h.revision,rosterDigest:h.rosterDigest,plans:{},guestScopes:{},ready:new Set(),closedPeers:new Set(),committed:false,localClosed:false,complete:false};
  t.promise=new Promise((resolve,reject)=>{t.resolve=resolve;t.reject=reject;});t.promise.catch(()=>{});this.pending=t;
  this.prepareHost(t,binding);return t.promise;
 }
 async prepareHost(t,binding){
  const c=this.c;
  try{
   for(const mode of ROOM_MODES){
    const p=await c.engines.command('next-plan',{mode},binding);
    if(!this.current(t)||!c.settlement.ready())throw Error('返回前的本局结算确认已失效');
    if(p.admission!==true||p.mode!==mode||!sameScope(p.scope,t.localScope)||!hash(p.configDigest)||!Number.isSafeInteger(p.capacity)||p.capacity<2||p.capacity>64)throw Error('当前模式配置或文件事务未确认');
    // The new document checks this digest again before any native admission.
    t.plans[mode]={mode,capacity:p.capacity,configDigest:p.configDigest,admission:true};
   }
   t.round.phase='returning';await c.engines.command('settlement-state',{phase:'preparing',ready:false},binding);
   if(!this.current(t))throw Error('旧返回操作已失效');
   for(const peer of t.peers)this.send(peer,'room-return-prepare',t,{hostScope:t.hostScope});
   this.arm(t,'等待原玩家返回插件房间超时');c.onEvent('plugin-room-return-preparing',{...this.envelope(t.round,{}),returnId:t.id});c.publishState();
  }catch(error){if(this.current(t))this.abort(error.message);}
 }
 arm(t,message){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;if(this.current(t))this.abort(message);},20000);}
 async control(owner,frame){
  if(this.validate(owner,frame)!==true)return;
  const c=this.c,d=frame.data,peer=c.sessions.peerForActualOwner(owner);
  if(frame.type==='room-return-proposal')return this.begin({requestId:d.proposalId});
  if(frame.type==='room-return-prepare'){
   if(this.receipt?.id===d.returnId){this.send(peer,'room-return-closed',this.receipt,{confirmed:true,guestScope:this.receipt.localScope});return;}
   if(this.pending){if(this.pending.prepared)this.sendReady(this.pending,peer);return;}
   const binding=c.engines.current,t={id:d.returnId,round:c.round,peers:[peer],hostScope:clone(d.hostScope),localScope:clone(binding.scope),barrierId:d.barrierId,revision:d.revision,rosterDigest:d.rosterDigest,plans:{},prepared:false,committed:false,localClosed:false,complete:false};this.pending=t;
   try{
    const a=await c.engines.command('next-admission',{},binding);if(!this.current(t))return;
    if(!c.settlement.ready()||a.admission!==true||!sameScope(a.scope,t.localScope))throw Error('本机结算或文件事务未确认，暂不能返回');
    t.prepared=true;t.round.phase='returning';await c.engines.command('settlement-state',{phase:'preparing',ready:false},binding);if(!this.current(t))return;
    this.sendReady(t,peer);this.arm(t,'等待房主确认返回插件房间超时');c.publishState();
   }catch(error){if(this.current(t))this.abort(error.message);}
   return;
  }
  const t=this.pending||this.receipt;
  if(frame.type==='room-return-cancel'){this.abort(d.reason,false);return;}
  if(frame.type==='room-return-ready'){
   if(t.ready.has(peer))return;t.ready.add(peer);t.guestScopes[peer]=clone(d.guestScope);
   if(t.peers.every(p=>t.ready.has(p)))await this.commitHost(t);return;
  }
  if(frame.type==='room-return-commit'){
   if(t.localClosed){this.send(peer,'room-return-closed',t,{confirmed:true,guestScope:t.localScope});return;}
   if(t.committed)return;t.committed=true;
   try{await this.closeLocal(t);if(this.current(t))this.send(peer,'room-return-closed',t,{confirmed:true,guestScope:t.localScope});}catch(error){if(this.current(t))this.abort(error.message);}
   return;
  }
  if(frame.type==='room-return-closed'){
   if(t.complete){this.send(peer,'room-return-complete',t,{confirmed:true});return;}
   t.closedPeers.add(peer);await this.completeHost(t);return;
  }
  this.finish(t);
 }
 sendReady(t,peer){this.send(peer,'room-return-ready',t,{admission:true,guestScope:t.localScope,hostGeneration:t.hostScope.documentGeneration});}
 async commitHost(t){
  const c=this.c;if(!this.current(t)||t.committed)return;
  const h=c.settlement.host;if(!h||h.barrierId!==t.barrierId||h.revision!==t.revision||!h.peers.every(p=>h.acks.has(p))||t.peers.some(p=>!c.sessions.isLive(p))){this.abort('返回准备期间本局结算或原连接发生变化');return;}
  t.committed=true;
  try{for(const peer of t.peers)this.send(peer,'room-return-commit',t);await this.closeLocal(t);await this.completeHost(t);}catch(error){if(this.current(t))this.abort(error.message);}
 }
 async closeLocal(t){
  if(!this.current(t))throw Error('返回操作已退休');
  t.round.continuationPeers=t.peers.slice();
  const result=await this.c.retire('return to NONAME-KIT plugin room');
  if(!this.current(t))return;
  if(this.c.engines.current!==null||!result?.confirmation?.confirmed||result.errors?.length)throw Error('旧游戏窗口或端点尚未完整回收');
  t.localClosed=true;t.localClosure=clone(result);this.c.onEvent('plugin-room-engine-closed',{...this.envelope(t.round,{}),returnId:t.id,closure:clone(result)});this.c.publishState();
 }
 async completeHost(t){
  if(!this.current(t)||!t.localClosed||!t.peers.every(p=>t.closedPeers.has(p)))return;
  try{for(const peer of t.peers)this.send(peer,'room-return-complete',t,{confirmed:true});this.finish(t);}catch(error){this.abort(error.message);}
 }
 finish(t){
  if(!this.current(t)||!t.localClosed)return;
  clearTimeout(this.timer);this.timer=null;t.complete=true;t.round.phase='plugin-room';t.round.settlementReady=false;
  // Discard promise closures and transient sets; receipt contains scalar data only.
  const receipt={id:t.id,round:t.round,peers:t.peers.slice(),hostScope:clone(t.hostScope),localScope:clone(t.localScope),guestScopes:clone(t.guestScopes||{}),barrierId:t.barrierId,revision:t.revision,rosterDigest:t.rosterDigest,plans:clone(t.plans),committed:true,prepared:true,localClosed:true,complete:true};
  this.pending=null;this.receipt=receipt;t.resolve?.({returned:true,returnId:t.id});
  this.c.onEvent('plugin-room-ready',{...this.envelope(t.round,{}),returnId:t.id,mode:t.round.mode,peers:t.peers.slice()});this.c.publishState();
 }
 restoreRetainedSettlement(t){
  const c=this.c,r=t.round,b=c.engines.current,s=c.role==='guest'?c.settlement.guest:c.settlement.host,fence=s?.data;
  const acknowledged=()=>c.role==='guest'?
   c.settlement.guest===s&&s?.round===r&&s.acked===true&&s.data===fence&&fence.barrierId===t.barrierId&&fence.revision===t.revision&&fence.rosterDigest===t.rosterDigest:
   c.settlement.host===s&&s?.round===r&&s.barrierId===t.barrierId&&s.revision===t.revision&&s.rosterDigest===t.rosterDigest&&s.peers.every(peer=>s.acks.has(peer));
  const revision=c.role==='guest'?fence?.revision:s?.revision;
  const sameSettlement=()=>c.role==='guest'?c.settlement.guest===s&&s?.data===fence&&fence?.revision===revision:c.settlement.host===s&&s?.revision===revision;
  const restoreReady=r.settlementReady===true&&acknowledged();
  const args={phase:restoreReady?'settled':'settling',ready:restoreReady,...(restoreReady&&c.role==='guest'?{terminalSeq:fence.terminalSeq,finalSeq:fence.finalSeq}:{})};
  // Reopen only after the same native document confirms the still-current fence.
  r.phase='settling';r.settlementReady=false;c.publishState();
  if(!b||this.closed)return;
  const current=()=>!this.closed&&c.live(r)&&c.engines.current===b&&r.phase==='settling'&&r.settlementReady===false&&!this.pending&&!this.receipt&&sameSettlement()&&(!restoreReady||acknowledged());
  c.engines.command('settlement-state',args,b).then(reply=>{
   if(!current())return;
   if(reply?.staleSettlementFence){r.settlementError='原生结算末帧已变化，等待重新确认';c.onEvent('error',{roundId:r.roundId,message:r.settlementError});c.publishState();return;}
   if(reply?.phase!==args.phase||reply.ready!==restoreReady)throw Error('取消回房后的原生结算状态未确认');
   r.phase=args.phase;r.settlementReady=restoreReady;r.settlementError=null;c.publishState();
  }).catch(error=>{if(current())c.fail(r,error);});
 }
 abort(reason,notify=true){
  const t=this.pending;if(!t)return false;clearTimeout(this.timer);this.timer=null;this.pending=null;
  if(notify)for(const peer of t.peers)if(this.c.sessions.isLive(peer))try{this.send(peer,'room-return-cancel',t,{reason:String(reason).slice(0,1000)});}catch(error){this.c.onEvent('room-return-cancel-notice-failed',{peerId:peer,message:error.message});}
  t.reject?.(Error(reason));
  if(this.c.live(t.round)){
   if(t.committed)this.c.fail(t.round,Error('返回插件房间未完成：'+reason));
   else this.restoreRetainedSettlement(t);
  }
  this.c.onEvent('plugin-room-return-failed',{roundId:t.round.roundId,message:String(reason)});
  if(!t.committed)this.c.onEvent('error',{roundId:t.round.roundId,message:'返回插件房间未完成：'+String(reason)});return true;
 }
 reset(){this.receipt=null;}
 snapshot(){const t=this.pending||this.receipt;return {ready:this.ready(),returnId:t?.id||null,localClosed:t?.localClosed===true,complete:t?.complete===true,resources:{timers:Number(this.timer!==null),receipts:Number(this.receipt!==null),pending:Number(this.pending!==null)}};}
 dispose(){this.closed=true;this.abort('插件房间控制器已退休');clearTimeout(this.timer);this.timer=null;this.receipt=null;}
}

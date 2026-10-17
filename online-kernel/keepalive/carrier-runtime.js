import {TransportOwner} from './transport-owner.js';
import {InitialConnector} from './initial-connector.js';
import {SessionRegistry} from './session-registry.js';
import {LobbyOwner} from './lobby-owner.js';
import {EngineBindingManager} from './engine-binding.js';
import {InitialPartyCoordinator} from './initial-party.js';
const clone=value=>JSON.parse(JSON.stringify(value));
function profileIdentity(profile){
  const identity=profile.identity||{},config=profile.config||{};
  return {name:String(identity.name??identity.connectNickname??config.onlineName??'').slice(0,12),
    avatar:String(identity.avatar??identity.connectAvatar??config.onlineAvatar??'').slice(0,24)};
}
export class CarrierRuntime {
  constructor({nnk,native,ipc,profile,onDisplay=()=>{}}){
    Object.assign(this,{nnk,native,ipc,profile,onDisplay});this.events=[];this.identities=new Map();this.stopped=false;this.nativeSnapshot=null;this.nativePollPending=false;
    this.profileOperations=new Map();this.profileOperationSequence=0;this.profileConfirmedSequence=0;
    const bridge=nnk.modules.bridge;
    const event=(name,data={})=>{const row={at:Date.now(),name,data:clone(data)};this.events.push(row);if(this.events.length>160)this.events.shift();if(name==='error')onDisplay(data.message,true);};
    this.sessions=new SessionRegistry({onStopped:record=>{
      this.identities.delete(record.peerId);
      const r=this.coordinator?.round;
      const enrolled=r&&record.lease&&['partySessionId','roundId','operationId'].every(key=>record.lease[key]===r[key]);
      const participant=this.coordinator?.role==='guest'?record.peerId===this.coordinator.guestPeer:this.coordinator?.members.has(record.peerId)||r?.continuationPeers?.includes(record.peerId);
      const inParty=enrolled||r?.continuationPeers?.includes(record.peerId);
      this.coordinator?.unregister(record.peerId);this.lobby?.onSessionChanged();
      if(r&&!r.failed&&inParty&&participant)this.coordinator.fail(r,Error('本局原连接已终止：'+record.reason));
      event('transport-stopped',record);bridge.emit(inParty&&participant?'error':'info',{message:inParty&&participant?'本局保活连接已终止：'+record.reason:'大厅连接已结束：'+record.reason});this.update();
    },onEvent:event});
    this.engines=new EngineBindingManager({native,ipc,onEvent:event,
      onSend:(binding,peerId,raw,terminal)=>{
        if(this.engines.current!==binding||binding.lease.roundId!==this.coordinator.round?.roundId)throw Error('旧端点不能发出游戏消息');
        const owner=this.sessions.getOwner(peerId);if(!owner)throw Error('未批准的实际连接');
        if(terminal&&require('node:crypto').createHash('sha256').update(raw).digest('hex')!==terminal.rawHash)throw Error('原生终端帧指纹未匹配实际发送内容');
        const seq=owner.sendGame({roundId:binding.scope.roundId,documentGeneration:binding.scope.documentGeneration},raw);
        this.coordinator.settlement.sent(binding,peerId,seq,terminal);
      },onStatus:(binding,status)=>{this.coordinator.status(binding,status);this.coordinator.settlement.status(binding,status);this.update();},
      onModuleEvent:(binding,name,data)=>{
        if(this.engines.current!==binding||binding.scope?.roundId!==this.coordinator.round?.roundId)return;
        // These notifications have no operation ID. Only the captured request's
        // successful result may commit a profile or announce identity success.
        if(['config_applied','identity_applied'].includes(name)){event('profile-notification-observed',{name,scope:binding.scope});return;}
        this.coordinator.settlement.engineEvent(binding,name,data);
        if(name==='round-return-request')this.coordinator.returnToPluginRoom({requestId:data.requestId}).catch(error=>bridge.emit('error',{message:error.message}));
        if(name==='round-return-waiting')bridge.emit('info',{message:data.message});
        bridge.emit(name,{...data,scope:binding.scope});event('engine-module-event',{name,scope:binding.scope});
      },onFailure:(binding,error)=>{if(binding.lease.roundId===this.coordinator.round?.roundId)this.coordinator.fail(this.coordinator.round,error);this.update();}});
    this.coordinator=new InitialPartyCoordinator({sessions:this.sessions,engines:this.engines,onEvent:(name,data)=>{event(name,data);bridge.emit(name,data);},onState:()=>{if(!this.stopped)this.lobby?._members();},getLobbyState:()=>({roomCode:this.lobby?.snapshot().roomCode??null,roomMode:this.lobby?.nextMode,memberState:this.lobby?.role==='host'?this.lobby.memberState():null}),
      getLocalIdentity:()=>profileIdentity(profile),onIdentity:()=>this.lobby?.onSessionChanged()});
    this.connector=new InitialConnector({rtc:nnk.modules.rtc,signaling:nnk.modules.signaling,onEvent:event,onFailure:error=>bridge.emit('error',{message:error.message}),
      allocationGuard:stats=>this.sessions.resourceSnapshot().liveOwners+stats.unadoptedAttempts+stats.retiredAttempts+stats.requestedOwners<=stats.maxTotalOwners,
      createOwner:({role,offerer})=>{
      this.coordinator.setRole(role);let owner;
      owner=new TransportOwner({role,offerer,contextFromOffer:true,sessionId:'uncommitted:'+crypto.randomUUID(),peerId:role,remotePeerId:role==='host'?'guest':'host',rtc:nnk.modules.rtc,
        validateControl:frame=>this.coordinator.validate(owner,frame),
        onControl:frame=>this.coordinator.control(owner,frame),onControlFailure:(error,frame)=>this.coordinator.failure(owner,error,frame),
        onGame:(raw,envelope)=>{
          const peerId=this.sessions.peerForActualOwner(owner),binding=this.engines.current;
          if(!peerId||!binding||binding.lease.roundId!==envelope.roundId)throw Error('当前游戏帧没有已批准的实际端点');
          this.engines.game(peerId,raw,envelope,binding);
        },onStopped:reason=>{if(owner){this.connector?.transportStopped(owner,reason);this.sessions.transportStopped(owner,reason);}},onEvent:detail=>event('transport-event',{role,...detail})});return owner;
    }});
    this.lobby=new LobbyOwner({boot:{...profile,identity:profileIdentity(profile)},connector:this.connector,sessions:this.sessions,bridge,
      coordinator:{restartRoom:mode=>this.restartRoom(mode),blocksNewPublicRoom:()=>!!this.coordinator.round&&!this.coordinator.round.failed,blocksReplacementJoin:()=>this.sessions.snapshot().length>0,
        lobbySnapshot:()=>({hostIdentity:this.coordinator.getLocalIdentity(),mode:this.coordinator.room.available()?this.lobby.nextMode:this.coordinator.round?.mode,capacity:this.coordinator.room.available()?this.coordinator.room.receipt.plans[this.lobby.nextMode]?.capacity:this.engines.current?.status?.capacity,hostEntered:(this.engines.current?.status?.seats||[]).some(seat=>seat.playerid==='1'&&!seat.unselectable),selectedPeers:this.coordinator.round?(this.coordinator.room.available()?this.coordinator.room.receipt.peers:[...this.coordinator.members.keys()]):null}),continuationSnapshot:()=>this.sessions.hasEnteredConnections()?this.coordinator.snapshot():null},
      onRegistered:async record=>{
        this.coordinator.setRole(record.role);const owner=this.sessions.getOwner(record.peerId),actual=owner.actualIdentity();
        this.identities.set(record.peerId,{pc:new WeakRef(actual.pc),link:new WeakRef(actual.link),ping:new WeakRef(actual.ping)});
        try{await this.coordinator.onRegistered(record);this.update();}catch(error){this.coordinator.fail(this.coordinator.round,error);bridge.emit('error',{message:error.message});throw error;}
      },onMembers:()=>{
        if(this.stopped)return;
        if(this.lobby?.role==='host')for(const peer of this.sessions.snapshot())if(this.sessions.isLive(peer.peerId))this.coordinator.publishLobby(peer.peerId);
        this.update();
      }});
    nnk.state.transferPaused=true;nnk.state.host={active:false,invites:[]};nnk.state.guest={session:null};
    this.nativePollTimer=setInterval(()=>{
      if(this.stopped||this.nativePollPending)return;this.nativePollPending=true;const binding=this.engines.current;
      native.snapshot().then(value=>{if(!this.stopped&&this.engines.current===binding){this.nativeSnapshot=value;this.update();}})
        .catch(error=>{if(!this.stopped&&this.engines.current===binding){event('native-observation-failed',{error:String(error)});bridge.emit('error',{message:'原生窗口状态读取失败：'+error.message});}})
        .finally(()=>{this.nativePollPending=false;});
    },1000);
  }
  confirmProfile(value,requestId=crypto.randomUUID(),forceIdentity=false){
    if(this.stopped)return false;const before=JSON.stringify(this.coordinator.getLocalIdentity());
    if(value.config)this.profile.config=clone(value.config);
    if(value.identity)this.profile.identity={...this.profile.identity,...clone(value.identity)};
    if(forceIdentity||JSON.stringify(this.coordinator.getLocalIdentity())!==before)this.coordinator.localIdentityChanged(requestId);
    return true;
  }
  update(){
    if(!this.lobby||this.stopped)return;const lobby=this.lobby.snapshot(),c=this.coordinator.snapshot(),r=c.round;
    const remote=lobby.role==='guest'&&this.sessions.isLive(this.coordinator.guestPeer)?c.remoteLobby:null;
    this.nnk.state.host={active:lobby.role==='host',invites:this.lobby.inviteMetadata()};this.nnk.state.guest={session:lobby.role==='guest'?{connected:this.sessions.snapshot().length>0}:null};
    const ownLobbyMember=remote?.members.find(m=>m.peerId===remote.selfPeerId);
    const phase=r?.failed?'error':lobby.role==='host'?(r?.phase==='loading'?'host_booting':lobby.lobbyOpen||this.sessions.hasEnteredConnections()?'room_open':'idle'):
      this.sessions.snapshot().length?(r?'connected':ownLobbyMember?.queued?'queued':'lobby_waiting'):this.lobby.joinAttempt?'joining':'idle';
    const roomCode=lobby.role==='guest'?remote?.roomCode??null:lobby.roomCode;
    this.nnk.modules.bridge.setPhase(phase,{roomCode,lobbyOpen:lobby.role==='guest'?roomCode!==null:lobby.lobbyOpen,stage:this.coordinator.room.ready()?'lobby':r?'loaded':'lobby',nextMode:lobby.role==='guest'?remote?.mode||lobby.nextMode:lobby.nextMode,roundPhase:r?.phase||null,round:r,continuation:this.sessions.hasEnteredConnections()?c:null,
      members:c.members,invites:this.lobby.inviteMetadata(),transferPaused:true,
      keepaliveDiagnostics:{scope:'actual current process observations; finite samples',carrierPid:process.pid,carrierMemoryBytes:process.memoryUsage(),native:this.nativeSnapshot,
        transportIdentity:this.transportIdentity(),engine:this.engines.snapshot(),registryResources:this.sessions.resourceSnapshot(),lobbyResources:this.lobby.resourceSnapshot(),initialResources:this.connector.resourceSnapshot?.()||null}});
    this.onDisplay(r?.failed?r.error:r?.phase==='returning'?'正在返回插件房间…':r?.phase==='plugin-room'?'已返回插件房间，等待房主选择模式并载入':r?.phase==='loading'?'正在载入新的游戏窗口…':r?.phase==='playing'?'对局进行中':r?.phase==='waiting'?'游戏等待房已就绪':this.sessions.snapshot().length?'已连接，等待本局入座':'网络窗口已就绪');
  }
  async createInternetRoom(mode,signaling){this.coordinator.setRole('host');return this.lobby.createInternetRoom(mode,signaling);}
  async restartRoom(mode){const c=this.coordinator;if(c.round?.failed&&c.next.lastPlan?.lease.roundId===c.round.roundId)throw Error('本次续局载入失败，须使用明确重试；不会自动重连');if(c.round&&['settled','settling','returning'].includes(c.round.phase))throw Error('请先在结算页点击“返回插件房间”');const result=await (c.round&&['plugin-room','preparing'].includes(c.round.phase)?c.prepareNext({mode:mode||this.lobby.nextMode}):c.start(mode||this.lobby.nextMode));this.update();return result;}
  async retryRound(){const result=await this.coordinator.next.retry();this.update();return result;}
  setRoomMode(mode){if(this.coordinator.role!=='host')throw Error('只有房主可以调整模式');return this.lobby.setRoomMode(mode);}
  refreshInvite(kind,id){return this.lobby.refreshInvite(kind,id);}
  acceptAnswer(id,code){return this.lobby.acceptAnswer(id,code);}
  joinByRoomCode(code){this.coordinator.setRole('guest');return this.lobby.joinByRoomCode(code);}
  joinByInvite(code){this.coordinator.setRole('guest');return this.lobby.joinByInvite(code);}
  cancelAll(){this.coordinator.cancelNextPreparation('大厅已解散，未提交的续局准备已停止');return this.lobby.cancelAll();}
  cancelJoin(){return this.lobby.cancelJoin();}
  async dispatch(cmd){
    const a=cmd.args||{};
    const actions={create_room:()=>this.createInternetRoom(a.mode,a.signaling),restart_room:()=>this.restartRoom(a.mode),return_plugin_room:()=>this.coordinator.returnToPluginRoom(a),next_round:()=>this.coordinator.prepareNext(a),retry_round:()=>this.retryRound(),set_mode:()=>this.setRoomMode(a.mode),join_room:()=>this.joinByRoomCode(a.code),join_invite:()=>this.joinByInvite(a.code),invite_refresh:()=>this.refreshInvite(a.kind,a.id),accept_answer:()=>this.acceptAnswer(a.id,a.code),cancel:()=>this.cancelAll()};
    if(actions[cmd.action])return await actions[cmd.action]();
    if(['transfer_pack','batch_decision','batch_cancel','batch_reload','batch_retry'].includes(cmd.action))throw Error('补传、重试及启用继续暂停。');
    if(['set_config','set_identity','clear_quarantine','manifest_recheck'].includes(cmd.action)){
      const binding=this.engines.current;if(this.stopped||!binding)throw Error('当前没有可操作的游戏文档；请先载入到游戏。');
      if(this.profileOperations.size>=8||this.profileOperationSequence>=1000000000)throw Error('当前配置操作已达上限，请等待现有操作完成。');
      const operation={sequence:++this.profileOperationSequence,requestId:crypto.randomUUID(),binding,scope:{...binding.scope}};this.profileOperations.set(operation.sequence,operation);
      try{
        const result=await this.engines.operation(cmd.action,a,binding);
        if(this.stopped||this.engines.current!==binding||binding.closed===true||Object.keys(operation.scope).some(k=>binding.scope?.[k]!==operation.scope[k]))throw Error('原配置操作的游戏文档已退休，未提交旧身份回调。');
        if(result?.profile&&operation.sequence>this.profileConfirmedSequence){
          this.profileConfirmedSequence=operation.sequence;this.confirmProfile(result.profile,operation.requestId,cmd.action==='set_identity');
          if(cmd.action==='set_identity'){const applied=this.coordinator.getLocalIdentity();this.nnk.modules.bridge.emit('identity_applied',{...applied,avatarLabel:applied.avatar,profile:result.profile,requestId:operation.requestId});}
          if(cmd.action==='set_config')this.nnk.modules.bridge.emit('config_applied',{key:a.key,value:result.profile.config?.[a.key],profile:result.profile,requestId:operation.requestId});
        }
        return result;
      }finally{this.profileOperations.delete(operation.sequence);}
    }
    throw Error('未知命令：'+cmd.action);
  }
  transportIdentity(){return this.sessions.snapshot().map(record=>{
    const now=this.sessions.getOwner(record.peerId).actualIdentity(),before=this.identities.get(record.peerId);
    return {peerId:record.peerId,sessionId:record.connectionSessionId,samePC:now.pc===before?.pc.deref(),sameLink:now.link===before?.link.deref(),samePing:now.ping===before?.ping.deref(),snapshot:this.sessions.getOwner(record.peerId).snapshot()};});}
  snapshot(){return {coordinator:this.coordinator.snapshot(),sessions:this.sessions.snapshot(),engine:this.engines.snapshot(),transportIdentity:this.transportIdentity(),resources:{registry:this.sessions.resourceSnapshot(),lobby:this.lobby.resourceSnapshot(),initial:this.connector.resourceSnapshot?.()||null},events:this.events.slice()};}
  dispose(){this.stopped=true;this.profileOperations.clear();clearInterval(this.nativePollTimer);this.nativePollTimer=null;this.coordinator.dispose();this.engines.dispose();this.nnk.modules.bridge.stop('carrier retired');this.identities.clear();}
}

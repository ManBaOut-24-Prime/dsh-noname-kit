// Own observation boundaries around the unchanged, original native game.over.
// These prove a known synchronous terminal dispatch, not global async quiescence.
export const NATIVE_OVER_SHA256='e0fa13a272b437afdbc460a678670726569cd8b01ad3611e756edba7bef36cda';
const clone=value=>JSON.parse(JSON.stringify(value));
const AVATAR_CALLBACK_SHA256='770f9771d8eb1e9f3eedd5c0a06cb71093a9839bc737dd2c5d6cabbd6a9f19da';
const AVATAR_METHOD_SHA256='187f9070fb83bd74c825e7fcd048559fd03256d740050969c24ccd6072e22cc4';
const IDENTITY_CALLBACK_SHA256=new Set(['2cd2d24173f420bc96c80018f61663c2634e1fc3157a8ab991d0983bd18189e3','8cf14522f3fe787d5defab68aba2e5fc63c5a0dc22bf9fede2caa863fbf9ea1a']);
const IDENTITY_METHODS={alive:'2b485433d630e27c52f8ba76b8099aaa263006c819a1b7a403d6460ed34c46d2',population:'bfc3a95415505b3a3ff5bf58be6143352f5fa19d8f99ec20c25ee164bff0cc0e',config:'bff2d5706dcb9f4b795d1effb93ac03225f8734ef37847f034213ee5ed5079f9',popup:'5be57ebafda196fc10de433b51d93cdd351cd061ea060f2803d5cae8935f7566',video:'229dfbb78d60e882f9ef141c4223b44de34fd14f977a544bf1f351e588cfb6e0',div:'1d11523d6ab8aa2a7fd080b3eb43cd11b0937301f2ab9bde7c0862a9a1ade828',refresh:'583361ff9c548907a6727839c86cb754ffc6f6a27c830ec3912c3c80a110b28b',remove:'50249d1a56164c886ba3c88716d02be40f5ff880a613f89a9b3f28fee7d2c03d'};
const IDENTITY_POPUP='<span style="font-family:xinwei"><span data-nature="fire">主公</span><span data-nature="soil"> vs </span><span data-nature="thunder">内奸</span></span>';
function nativeDigest(value){if(typeof require!=='function')throw Error('Native digest unavailable');return require('node:crypto').createHash('sha256').update(value).digest('hex');}
// Only the two reviewed native versions' identical, idempotent avatar restore.
// This inspects an already native-dispatched packet; it never executes a callback.
export function inspectNativeAvatarRestore(env,raw){
 try{
  const packet=JSON.parse(raw);
  if(!['1.11.5.2','1.11.6'].includes(env?.lib?.version)||env.game?.online!==true||!Array.isArray(packet)||packet.length!==5||packet[0]!=='exec'||typeof packet[1]!=='string'||nativeDigest(packet[1])!==AVATAR_CALLBACK_SHA256||typeof packet[2]!=='string'||!/^_noname_player:[A-Za-z0-9_-]{1,160}$/.test(packet[2]))return null;
  const playerId=packet[2].slice('_noname_player:'.length),name=packet[3];
  if(typeof name!=='string'||!/^[A-Za-z0-9_]{1,80}$/.test(name)||packet[4]!==name||!env.lib.character?.[name])return null;
  const players=[...new Set(['players','dead','additionaldead'].flatMap(key=>Array.isArray(env.game[key])?env.game[key]:[]).filter(player=>player?.playerid===playerId))];
  const player=players[0],method=player?.setAvatar;
  if(players.length!==1||env.lib.playerOL?.[playerId]!==player||![player.name,player.name2].includes(name)||typeof method!=='function'||nativeDigest(String(method))!==AVATAR_METHOD_SHA256)return null;
  return {player,method,playerId,name};
 }catch{return null;}
}
// Ordinary connect Guests do not install mode.game.showIdentity. Its absence is
// a branch condition, never a callable-method fingerprint. Inspect only this
// reviewed callback and its actual no-op / null-avatar, broadcast=false popup.
// Native dispatch remains the sole executor; retained references last one frame.
export function inspectNativeIdentityReveal(env,raw){
 try{
  const packet=JSON.parse(raw),game=env?.game,lib=env?.lib,get=env?.get,ui=env?.ui,status=env?._status;
  if(!['1.11.5.2','1.11.6'].includes(lib?.version)||game?.online!==true||status?.over!==true||lib.configOL?.mode!=='identity'||game.showIdentity!==undefined||!Array.isArray(packet)||packet.length!==2||packet[0]!=='exec'||typeof packet[1]!=='string'||!IDENTITY_CALLBACK_SHA256.has(nativeDigest(packet[1])))return null;
  if(typeof lib.element?.Player!=='function'||!Array.isArray(game.players)||!Array.isArray(game.dead)||game.additionaldead!==undefined&&!Array.isArray(game.additionaldead)||!lib.playerOL)return null;
  const collections=['players','dead','additionaldead'].map(key=>({array:game[key],players:[...(game[key]||[])]})),players=collections.flatMap(row=>row.players),ids=players.map(player=>player?.playerid);
  if(players.length<2||players.length>8||new Set(players).size!==players.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[_A-Za-z0-9-]{1,160}$/.test(id))||JSON.stringify(Object.keys(lib.playerOL).sort())!==JSON.stringify([...ids].sort())||players.some(player=>!(player instanceof lib.element.Player)||lib.playerOL[player.playerid]!==player||!['zhu','zhong','fan','nei','mingzhong','commoner'].includes(player.identity))||!players.includes(game.me)||!players.includes(game.zhu)||game.zhu.identity!=='zhu'||players.filter(player=>player.identity==='zhu').length!==1)return null;
  const methods=[],check=(method,hash)=>{if(typeof method!=='function'||nativeDigest(String(method))!==hash)throw Error('Unreviewed identity display method');methods.push(method);};
  check(game.zhu.isAlive,IDENTITY_METHODS.alive);
  const records=players.map(player=>{
   if(typeof player.classList?.contains!=='function')throw Error('Missing actual Player class list');
   return {player,node:player.node,classes:player.classList,aliveMethod:player.isAlive,identityNode:player.node?.identity,ai:player.ai,data:JSON.stringify([player.playerid,player.name,player.name1,player.name2,player.identity,player.special_identity,player.hp,player.maxHp,player.hujia,player.phaseNumber,player.identityShown,player.ai?.shown,player.isZhu,player.classList.contains('dead'),player.className,player.dataset?.position])};
  });
  const dead=game.zhu.classList.contains('dead');let popup=false,configMode=null,configValue=null;
  if(!dead){
   check(get?.population,IDENTITY_METHODS.population);
   if(game.players.filter(player=>player.identity==='nei').length===1){
    check(get.config,IDENTITY_METHODS.config);configMode=lib.config?.mode;
    if(typeof configMode!=='string')return null;
    configValue=lib.config?.mode_config?.[configMode]?.nei_fullscreenpop;
    if(configValue!==undefined&&typeof configValue!=='boolean')return null;
    popup=configValue===true;
   }
  }
  if(popup){check(game.me.$fullscreenpop,IDENTITY_METHODS.popup);check(game.addVideo,IDENTITY_METHODS.video);check(ui?.create?.div,IDENTITY_METHODS.div);check(ui?.refresh,IDENTITY_METHODS.refresh);if(!ui.window?.isConnected||!ui.window.ownerDocument||typeof ui.window.appendChild!=='function')return null;check(ui.window.delete,IDENTITY_METHODS.remove);}
  const window=ui?.window,children=popup?[...window.children]:[];
  return {kind:'native-identity-reveal',popup,game,lib,status,get,ui,window,document:window?.ownerDocument,me:game.me,zhu:game.zhu,playerMap:lib.playerOL,Player:lib.element.Player,collections,records,methods,children,playerIds:[...ids].sort(),zhuId:game.zhu.playerid,state:JSON.stringify([lib.version,lib.configOL.mode,lib.configOL.number,lib.configOL.identity_mode,game.online,status.over,status.connectMode,game.phaseNumber,game.roundNumber,game.currentPhase?.playerid,configMode,configValue])};
 }catch{return null;}
}
export function sameNativeIdentityReveal(before,after){
 if(!before||!after||before.kind!==after.kind||before.popup!==after.popup||before.state!==after.state||['game','lib','status','get','ui','window','document','me','zhu','playerMap','Player'].some(key=>before[key]!==after[key])||before.methods.length!==after.methods.length||before.methods.some((method,index)=>method!==after.methods[index])||before.collections.some((row,index)=>row.array!==after.collections[index]?.array||row.players.length!==after.collections[index]?.players.length||row.players.some((player,i)=>player!==after.collections[index].players[i]))||before.records.some((row,index)=>{const next=after.records[index];return !next||row.data!==next.data||['player','node','classes','aliveMethod','identityNode','ai'].some(key=>row[key]!==next[key]);}))return false;
 if(!before.popup)return true;
 // The reviewed popup adds one transient display node, not a settlement dialog.
 const added=after.children.filter(node=>!before.children.includes(node));
 return added.length===1&&after.children.length===before.children.length+1&&before.children.every((node,index)=>after.children.filter(child=>child!==added[0])[index]===node)&&added[0].parentNode===before.window&&added[0].ownerDocument===before.document&&added[0].delete===before.window.delete&&added[0].classList?.contains('damage')===true&&added[0].classList?.contains('damageadded')===true&&added[0].innerHTML===IDENTITY_POPUP&&added[0].dataset?.nature==='soil';
}
// These controls belong to this native document. Keep their native references
// intact for late official UI callbacks; closing only removes the visible action.
export function closeNativeSettlementActions(env,retainedControl){
 if(env?._status?.over!==true||!env.ui)return 0;
 let closed=0;
 for(const action of new Set(['restart','exit','continue_game'].map(key=>env.ui[key]))){
  if(!action||action===retainedControl||action.isConnected===false||action.classList?.contains('removing'))continue;
  if(typeof action.close==='function')action.close();
  else if(typeof action.remove==='function')action.remove();
  else continue;
  closed++;
 }
 return closed;
}
export function createNativeSettlement({env:initialEnv,role,scope,isCurrent,emit,actualRoster,expectedPeers}){
 let env=initialEnv,disposed=false,codec=null,overHook=null,reloadOriginal=null,reloadWrapper=null,control=null;
 let hostProof=null,guestProof=null,ready=false,requested=false,requestId=null,phase='loading',heldReloads=0;
 const sent=new Map();
 const current=()=>!disposed&&!!env&&isCurrent();
 function digest(value){return nativeDigest(value);}
 function signal(name,value){if(current())emit(name,clone(value));}
 function refreshCodec(){
  if(!current())return false;
  const over=env.game.over,get=env.get;
  if(typeof over!=='function'||typeof get?.funcInfoOL!=='function'||typeof require!=='function')return false;
  const hash=digest(String(over));if(hash!==NATIVE_OVER_SHA256){codec=null;return false;}
  codec={over,encoded:get.funcInfoOL(over),hash};return true;
 }
 function unchanged(){return !!codec&&current()&&env.game.over===codec.over&&digest(String(env.game.over))===codec.hash;}
 function terminal(raw){if(!unchanged())return null;let value;try{value=JSON.parse(raw);}catch{return null;}
  return Array.isArray(value)&&value[0]==='exec'&&value[1]===codec.encoded&&typeof value[2]==='string'?value:null;}
 function dialogs(){if(!current())return [];return (env.ui?.dialogs||[]).filter(node=>node.isConnected&&node.content).map(node=>({text:String(node.content.innerText||node.content.textContent||''),html:String(node.content.innerHTML||'')}));}
 function settlementDOM(){const visible=dialogs().filter(row=>/战斗胜利|战斗失败|平局/.test(row.text));return {present:visible.length>0,hash:visible.length?digest(visible.map(row=>row.html).join('\n')):null};}
 function showControl(){
  if(!current())return;
  closeNativeSettlementActions(env,control);
  if(control||typeof env.ui?.create?.control!=='function')return;
  control=env.ui.create.control('返回插件房间',()=>{
   if(!current())return;
   if(!ready){signal('round-return-waiting',{message:'等待本局所有玩家完成结算。'});return;}
   if(!requestId)requestId=crypto.randomUUID();requested=true;
   signal('round-return-request',{requestId,role});
  });
  control.classList?.toggle('disabled',!ready);
  if(control.dataset)control.dataset.nnkReturnRoom=scope.roundId;
 }
 function holdReload(){
  if(reloadWrapper||!current()||typeof env.game.reload!=='function')return;
  reloadOriginal=env.game.reload;
  reloadWrapper=function(...args){
   if(!current())return;
   if(env._status.over){heldReloads++;showControl();signal('native-settlement-reload-held',{heldReloads,message:'本局已结束，请点击“返回插件房间”，再选择模式并载入到游戏。'});return;}
   return reloadOriginal.apply(this,args);
  };
  env.game.reload=reloadWrapper;
 }
 function install(){
  if(!current())return {available:false};
  const available=refreshCodec();holdReload();
  if(role==='host'&&!overHook&&Array.isArray(env.lib.onover)){
   overHook=result=>queueMicrotask(()=>{
    if(!current())return;
    try{
     const dom=settlementDOM(),roster=actualRoster(),expected=[...expectedPeers()].sort(),actual=roster.map(row=>row.peerId).sort();
     const canonical=unchanged()&&env._status.over===true&&dom.present&&roster.length>0&&new Set(actual).size===actual.length&&JSON.stringify(actual)===JSON.stringify(expected)&&roster.every(row=>sent.has(row.peerId)&&row.receivedSeq===row.appliedSeq&&!row.sequenceGap&&row.pendingOfficialHandlers===0);
     hostProof={nativeEnded:env._status.over===true,nativeTailObserved:true,codec:codec?.hash||null,nativeOverUnchanged:unchanged(),dom,roster,terminalFrames:roster.map(row=>({peerId:row.peerId,...sent.get(row.peerId)})),result,canonical,at:Date.now()};
     phase='settling';showControl();signal('native-round-ended',hostProof);
    }catch(error){signal('native-settlement-unavailable',{message:error.message});}
   });
   env.lib.onover.push(overHook);
  }
  return {available,codec:codec?.hash||null,scope};
 }
 function outgoing(peerId,raw){
  if(!current())return null;const value=terminal(raw);if(!value)return null;
  if(role!=='host'||env._status.over!==true)throw Error('Native terminal send outside actual Host settlement');
  const proof={rawHash:digest(raw),codec:codec.hash,at:Date.now()};sent.set(peerId,proof);
  return proof;
 }
 function beforeFrame(raw){
  const before={terminal:!!terminal(raw),over:!!env?._status.over};
  if(role==='guest'&&guestProof?.canonical===true&&before.over&&!before.terminal&&unchanged()){
   const dom=settlementDOM(),restore=inspectNativeAvatarRestore(env,raw),identity=inspectNativeIdentityReveal(env,raw);
   if(restore&&dom.present&&dom.hash===guestProof.dom.hash)before.avatarRestore={...restore,domHash:dom.hash};
   if(identity&&dom.present&&dom.hash===guestProof.dom.hash)before.identityReveal={...identity,domHash:dom.hash};
  }
  return before;
 }
 function afterFrame(peerId,raw,seq,before){
  if(!current())return;
  const ended=role==='host'?hostProof:guestProof;
  if(ended&&!before.terminal){let packet;try{packet=JSON.parse(raw);}catch{}const metadata=Array.isArray(packet)&&['nnk_manifest','nnk_manifest_diff'].includes(packet[0])||packet?.nnk_batch===2;
   if(!metadata){
    const candidate=before.avatarRestore||before.identityReveal,after=before.avatarRestore?inspectNativeAvatarRestore(env,raw):before.identityReveal&&inspectNativeIdentityReveal(env,raw),dom=after&&settlementDOM();
    const matching=before.avatarRestore?after?.player===candidate.player&&after.method===candidate.method&&after.playerId===candidate.playerId&&after.name===candidate.name:sameNativeIdentityReveal(candidate,after);
    const verified=role==='guest'&&ended.canonical===true&&before.over&&env._status.over===true&&unchanged()&&candidate&&matching&&dom.present&&dom.hash===candidate.domHash&&dom.hash===ended.dom.hash&&Number.isSafeInteger(seq)&&seq>Math.max(ended.terminalSeq,ended.tail?.seq||0)&&(ended.verifiedAvatarRestores||0)+(ended.verifiedIdentityReveals||0)<15;
    if(verified){
     if(before.avatarRestore){ended.verifiedAvatarRestores=(ended.verifiedAvatarRestores||0)+1;ended.tail={kind:'native-avatar-restore',seq,rawHash:digest(raw),playerId:after.playerId,name:after.name};}
     else{ended.verifiedIdentityReveals=(ended.verifiedIdentityReveals||0)+1;ended.tail={kind:'native-identity-reveal',seq,rawHash:digest(raw),playerIds:after.playerIds,zhuId:after.zhuId,popup:after.popup};}
     ready=false;phase='settling';control?.classList?.add('disabled');signal('native-settlement-tail-applied',ended);return;
    }
    ended.canonical=false;ready=false;phase='settling';control?.classList?.add('disabled');signal('native-settlement-unavailable',{message:'结算后出现尚未可靠核验的原生输出，本次续局准备已停止。'});return;
   }
  }
  if(role!=='guest'||!before.terminal)return;
  const dom=settlementDOM(),canonical=!before.over&&env._status.over===true&&unchanged()&&dom.present;
  if(guestProof){signal('native-terminal-duplicate',{peerId,seq});return;}
  guestProof={peerId,terminalSeq:seq,rawHash:digest(raw),codec:codec?.hash||null,nativeEnded:env._status.over===true,nativeOverUnchanged:unchanged(),overBefore:before.over,overAfter:!!env._status.over,dom,canonical,at:Date.now()};
  phase='settling';showControl();signal('native-terminal-applied',guestProof);
 }
 function state(value){
  if(!current()||!value||!['playing','settling','settled','preparing','loading','seating','failed'].includes(value.phase))throw Error('Invalid current round settlement state');
  if(value.phase==='settled'&&(!env._status.over||!unchanged()||!(role==='host'?hostProof:guestProof)?.canonical))throw Error('Actual current native settlement has not been verified');
  // A delayed old group-completion command cannot re-enable a newer tail.
  if(role==='guest'&&value.phase==='settled'&&(!Number.isSafeInteger(value.terminalSeq)||value.terminalSeq!==guestProof.terminalSeq||!Number.isSafeInteger(value.finalSeq)||value.finalSeq<Math.max(guestProof.terminalSeq,guestProof.tail?.seq||0)))return {...snapshot(),staleSettlementFence:true};
  phase=value.phase;ready=value.phase==='settled'&&value.ready===true;
  if(control)control.classList?.toggle('disabled',!ready);
  return snapshot();
 }
 function snapshot(){return {phase,ready,requested,requestId,host:hostProof&&clone(hostProof),guest:guestProof&&clone(guestProof),codec:codec?.hash||null,nativeOverUnchanged:unchanged(),currentDOM:settlementDOM(),heldReloads};}
 function resources(){return {environmentReferences:Number(env!==null),nativeOverReferences:Number(codec!==null),onoverHooks:Number(overHook!==null),reloadWrappers:Number(reloadWrapper!==null),controls:Number(control!==null),terminalMetadata:sent.size};}
 function dispose(){
  if(disposed)return;disposed=true;
  if(overHook&&env){const index=env.lib.onover.indexOf(overHook);if(index>=0)env.lib.onover.splice(index,1);}
  if(env&&env.game.reload===reloadWrapper)env.game.reload=reloadOriginal;
  control?.close?.();control=null;overHook=null;reloadOriginal=null;reloadWrapper=null;codec=null;
  sent.clear();hostProof=null;guestProof=null;env=null;
 }
 return {install,outgoing,beforeFrame,afterFrame,state,snapshot,resources,dispose};
}

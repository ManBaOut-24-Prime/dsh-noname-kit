const validPeer=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const peersOf=value=>Array.isArray(value)&&value.length>0&&value.length<=64&&value.every(validPeer)&&new Set(value).size===value.length?value.slice():null;

// Recovery discards an ended enrollment; it never reconnects or transfers identity.
export class SettledPartyRecovery {
 constructor({getCoordinator,getSessions,retire,emit=()=>{}}){
  if([getCoordinator,getSessions,retire,emit].some(fn=>typeof fn!=='function'))throw TypeError('Recovery callbacks required');
  Object.assign(this,{getCoordinator,getSessions,retire,emit});this.captured=null;this.pending=null;this.error=null;this.generation=0;this.closed=false;
 }
 current(t){return !this.closed&&this.captured===t&&t.generation===this.generation&&this.getCoordinator()===t.coordinator&&t.coordinator.round===t.round&&!t.coordinator.closed;}
 oldLive(t){const sessions=this.getSessions();return t.peers.filter(peer=>sessions.isLive(peer));}
 captureBeforeDisconnect(peer){
  if(this.closed||!validPeer(peer))return false;
  if(this.captured&&this.current(this.captured))return this.captured.peers.includes(peer);
  const c=this.getCoordinator(),r=c?.round;
  if(!c||!r||c.closed||r.failed||c.room?.pending||c.next?.pending||c.next?.committed)return false;
  let peers=null,source=null;
  if(r.phase==='settled'&&r.settlementReady===true&&c.settlement?.ready()===true){
   if(c.role==='host'&&c.settlement.host?.round===r)peers=peersOf(c.settlement.host.peers);
   else if(c.role==='guest'&&c.settlement.guest?.round===r&&c.settlement.guest.acked===true)peers=peersOf([c.guestPeer]);
   source='settlement';
  }else{
   const receipt=c.room?.receipt;
   if(r.phase==='plugin-room'&&receipt?.round===r&&receipt.complete===true&&receipt.localClosed===true&&c.engines?.current===null){peers=peersOf(receipt.peers);source='plugin-room';}
  }
  if(!peers||!peers.includes(peer))return false;
  this.captured={coordinator:c,round:r,peers:Object.freeze(peers),source,generation:++this.generation};this.error=null;return true;
 }
 maybeRecover(){
  if(this.pending)return this.pending.promise;
  const t=this.captured;
  if(!t||!this.current(t))return Promise.resolve({recovered:false,reason:this.closed?'disposed':'no-current-ended-party'});
  if(this.oldLive(t).length)return Promise.resolve({recovered:false,reason:'old-participants-still-connected'});
  const operation={candidate:t,promise:null};this.pending=operation;
  operation.promise=this.recover(t).finally(()=>{if(this.pending===operation)this.pending=null;});return operation.promise;
 }
 async recover(t){
  const current=()=>this.current(t);
  try{
   if(t.coordinator.cleanupPromise)await t.coordinator.cleanupPromise;
   if(!current())return {recovered:false,reason:'retired-recovery'};
   if(this.oldLive(t).length)return {recovered:false,reason:'old-participants-still-connected'};
   if(t.coordinator.room?.pending||t.coordinator.next?.pending||t.coordinator.next?.committed)return {recovered:false,reason:'round-transition-in-progress'};
   const result=await this.retire(t.coordinator,t.round,current);
   if(this.closed||this.captured!==t||t.generation!==this.generation||this.getCoordinator()!==t.coordinator)return {recovered:false,reason:'retired-recovery'};
   if(result!==true&&result?.retired!==true)return {recovered:false,reason:'retirement-not-committed'};
   if(t.coordinator.round===t.round||t.coordinator.engines?.current!==null)throw Error('旧局或原生引擎尚未完整退休');
   this.captured=null;this.error=null;this.emit('settled-party-recovered',{source:t.source,oldPeerCount:t.peers.length});return {recovered:true};
  }catch(error){
   if(this.current(t)){this.error=String(error?.message||error);this.emit('settled-party-recovery-failed',{message:this.error});}
   throw error;
  }
 }
 status(){
  const t=this.captured,current=!!t&&this.current(t),live=current?this.oldLive(t):[];
  return {captured:current,pending:this.pending!==null,blocked:current,canRecover:current&&!this.pending&&live.length===0,oldPeerCount:current?t.peers.length:0,liveOldPeers:live,error:current?this.error:null};
 }
 reset(){this.generation++;this.captured=null;this.pending=null;this.error=null;}
 dispose(){this.closed=true;this.reset();}
}

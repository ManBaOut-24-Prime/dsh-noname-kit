import {inspectReadyConnection,adoptReadyConnection} from './initial-connector.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const leaseKeys=['partySessionId','roundId','operationId'];
function lease(value){if(!value||leaseKeys.some(k=>typeof value[k]!=='string'||!value[k]||value[k].length>160))throw TypeError('Current party/round/operation lease required');return Object.freeze(Object.fromEntries(leaseKeys.map(k=>[k,value[k]])));}
const matches=(a,b)=>!!a&&!!b&&leaseKeys.every(k=>a[k]===b[k]);
export class SessionRegistry {
 constructor({onStopped=()=>{},onEvent=()=>{},maxHistory=32,maxLive=32,newPeerId=()=>crypto.randomUUID()}={}){
  if(!Number.isSafeInteger(maxLive)||maxLive<1||maxLive>32)throw TypeError('Registered live peer limit may only be lowered from 32');this.maxLive=maxLive;
  this.onStopped=onStopped;this.onEvent=onEvent;this.maxHistory=maxHistory;this.newPeerId=newPeerId;
  this.records=new Map();this.byOwner=new WeakMap();this.byConnection=new WeakMap();this.bySession=new Map();this.adoptionToken=Symbol('local registry adoption');this.ordinal=0;this.history=[];
 }
 _view(r){return {peerId:r.peerId,logicalPeerId:r.peerId,connectionSessionId:r.connectionSessionId,identity:clone(r.identity),
  joinOrdinal:r.joinOrdinal,entered:r.entered,wasEverEntered:r.wasEverEntered,lease:r.lease&&{...r.lease},live:!r.owner.stopped};}
 registerReady(connection){
  const known=this.byConnection.get(connection);if(known&&this.records.has(known))return this._view(this.records.get(known));
  const native=inspectReadyConnection(connection);if(!native)throw Error('Not a locally created unadopted ready connection');
  const {owner,connectionSessionId}=native,s=owner.snapshot();
  if(!owner.ready||owner.stopped||s.sessionId!==connectionSessionId||!s.initialContextBound||s.negotiations!==1||s.linkState!=='open'||s.pingState!=='open')throw Error('Actual keepalive readiness is incomplete');
  if(this.records.size>=this.maxLive){connection.closeUnentered('Registered live peer capacity limit reached');throw Error('Registered live peer capacity limit reached');}
  if(this.byOwner.has(owner)||this.bySession.has(connectionSessionId))throw Error('Actual owner/pair context already registered');
  const peerId=this.newPeerId();if(typeof peerId!=='string'||!peerId||this.records.has(peerId))throw Error('Fresh local logical peer required');
  const actual=adoptReadyConnection(connection,this.adoptionToken);if(actual!==owner)throw Error('Native adoption identity mismatch');
  const r={peerId,connectionSessionId,owner,identity:native.identity,joinOrdinal:++this.ordinal,entered:false,wasEverEntered:false,lease:null};
  this.records.set(peerId,r);this.byOwner.set(owner,peerId);this.byConnection.set(connection,peerId);this.bySession.set(connectionSessionId,peerId);
  return this._view(r);
 }
 getOwner(peerId){return this.records.get(peerId)?.owner??null;}
 peerForActualOwner(owner){return this.byOwner.get(owner)??null;}
 get(peerId){const r=this.records.get(peerId);return r?this._view(r):null;}
 snapshot(){return [...this.records.values()].map(r=>this._view(r));}
 list(){return this.snapshot();}
 getRecord(id){return this.get(id);}
 isLive(id){const r=this.records.get(id);return !!r&&!r.owner.stopped&&r.owner.ready;}
 isEntered(id){return this.isLive(id)&&this.records.get(id).entered;}
 wasEverEntered(id){return this.records.get(id)?.wasEverEntered===true;}
 hasEnteredConnections(){return [...this.records.values()].some(r=>r.wasEverEntered&&this.isLive(r.peerId));}
 bindEnrollment(id,value){const r=this.records.get(id);if(!r||!this.isLive(id))throw Error('Actual peer is unavailable');const next=lease(value);
  if(r.lease&&!matches(r.lease,next))throw Error('Retire the current enrollment before replacing it');r.lease=next;r.entered=false;return this._view(r);}
 markEntered(id,value,proof){
  const r=this.records.get(id);if(!r||!this.isLive(id)||!matches(r.lease,lease(value)))throw Error('Current enrollment lease mismatch');
  if(proof){
   if(proof.guestInited!==undefined&&proof.guestInitComplete!==undefined&&proof.guestInited!==proof.guestInitComplete||
    proof.hostSeats!==undefined&&proof.hostSeatIds!==undefined&&JSON.stringify(proof.hostSeats)!==JSON.stringify(proof.hostSeatIds)||
    proof.guestSeats!==undefined&&proof.guestSeatIds!==undefined&&JSON.stringify(proof.guestSeats)!==JSON.stringify(proof.guestSeatIds))throw Error('Conflicting native proof aliases');
   proof={...proof,guestInited:proof.guestInited??proof.guestInitComplete,hostSeats:proof.hostSeats??proof.hostSeatIds,guestSeats:proof.guestSeats??proof.guestSeatIds};
  }
  const state=r.owner.snapshot(),localGen=r.owner.role==='host'?proof?.hostDocumentGeneration:proof?.guestDocumentGeneration,
    remoteGen=r.owner.role==='host'?proof?.guestDocumentGeneration:proof?.hostDocumentGeneration;
  if(!proof||proof.hostClientInited!==true||proof.guestInited!==true||proof.ordered!==true||proof.seated!==true||proof.roundId!==r.lease.roundId||
    !Number.isSafeInteger(proof.hostDocumentGeneration)||proof.hostDocumentGeneration<1||!Number.isSafeInteger(proof.guestDocumentGeneration)||proof.guestDocumentGeneration<1||
    state.roundId!==r.lease.roundId||state.documentGeneration!==localGen||state.remoteDocumentGeneration!==remoteGen||
    typeof proof.hostClientId!=='string'||!proof.hostClientId||proof.guestOnlineID!==proof.hostClientId||!Array.isArray(proof.hostSeats)||!Array.isArray(proof.guestSeats)||
    !proof.hostSeats.every(id=>typeof id==='string'&&id)||!proof.guestSeats.every(id=>typeof id==='string'&&id)||
    new Set(proof.hostSeats).size!==proof.hostSeats.length||!proof.hostSeats.includes(proof.hostClientId)||
    JSON.stringify([...proof.hostSeats].sort())!==JSON.stringify([...proof.guestSeats].sort()))throw Error('Both current native init and matching actual seats are required');
  r.entered=true;r.wasEverEntered=true;return this._view(r);
 }
 retireEnrollment(id,value){const r=this.records.get(id);if(!r||!matches(r.lease,value))return false;r.entered=false;r.lease=null;return true;}
 setIdentity(id,actualOwner,identity){const r=this.records.get(id);if(!r||r.owner!==actualOwner)throw Error('Identity source must be the registered actual Owner');
  r.identity={name:String(identity?.name||'').slice(0,12),avatar:String(identity?.avatar||'').slice(0,24)};return this._view(r);}
 transportStopped(actualOwner,reason){const id=this.byOwner.get(actualOwner),r=id&&this.records.get(id);if(!r||r.owner!==actualOwner)return false;
  const summary={...this._view(r),live:false,reason:String(reason),at:Date.now()};this.records.delete(id);this.byOwner.delete(actualOwner);this.bySession.delete(r.connectionSessionId);
  this.history.push(summary);if(this.history.length>this.maxHistory)this.history.shift();
  try{const result=this.onStopped(summary);if(result?.then)result.catch(e=>console.error('[NNK registry stopped]',e));}catch(e){console.error('[NNK registry stopped]',e);}return true;
 }
 closeOnlyNeverEntered(reason){const ids=[];for(const r of [...this.records.values()])if(!r.wasEverEntered){
  ids.push(r.peerId);r.owner.stopTransport(reason);this.transportStopped(r.owner,reason);}return ids;}
 sendControl(id,type,data){const r=this.records.get(id);if(!r||!this.isLive(id))throw Error('Actual registered peer is unavailable');return r.owner.sendControl(type,clone(data));}
 resourceSnapshot(){return {liveOwners:this.records.size,sessionMappings:this.bySession.size,history:this.history.length,
  entered:[...this.records.values()].filter(r=>r.entered).length,everEntered:[...this.records.values()].filter(r=>r.wasEverEntered).length,maxLive:this.maxLive};}
}


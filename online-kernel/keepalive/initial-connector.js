// Single-ended initial discovery. This module never imports a game document or builds a socket facade.
const clone=value=>JSON.parse(JSON.stringify(value));
const readyConnections=new WeakMap();
const ROOM=/^[A-HJ-NP-Z2-9]{6}$/;
const guestID=/^[0-9a-z]{4,12}$/;
const errorOf=value=>value instanceof Error?value:Error(String(value));
export function inspectReadyConnection(connection){const item=readyConnections.get(connection);return item&&!item.adopted?{owner:item.owner,identity:clone(item.identity),connectionSessionId:item.sessionId}:null;}
export function adoptReadyConnection(connection,registryToken){
 const item=readyConnections.get(connection);if(!item||item.adopted||typeof registryToken!=='symbol')throw Error('Ready connection is not available for adoption');
 const owner=item.owner;if(!owner.ready||owner.stopped||owner.sessionId!==item.sessionId)throw Error('Actual ready owner changed before adoption');
 item.adopted=true;item.owner=null;const adopt=item.adopt;item.adopt=null;adopt();return owner;
}
export class InitialConnector {
 constructor({rtc,signaling,createOwner,onEvent=()=>{},onFailure=()=>{},limits={},allocationGuard=null,maxInitialOwnerSlots=32,maxPendingInitialOperations=64}){
  if(!rtc||typeof rtc.encodeCode!=='function'||typeof rtc.decodeCode!=='function'||typeof createOwner!=='function')throw TypeError('Original RTC helpers and single-ended owner factory required');
  this.rtc=rtc;this.signaling=signaling;this.createOwner=createOwner;this.onEvent=onEvent;this.onFailure=onFailure;
  if(allocationGuard!==null&&typeof allocationGuard!=='function'||!Number.isSafeInteger(maxInitialOwnerSlots)||maxInitialOwnerSlots<1||maxInitialOwnerSlots>32||!Number.isSafeInteger(maxPendingInitialOperations)||maxPendingInitialOperations<1||maxPendingInitialOperations>64)throw TypeError('Initial resource bounds may only be lowered from 32 owners / 64 operations');
  this.allocationGuard=allocationGuard;this.maxInitialOwnerSlots=maxInitialOwnerSlots;this.maxPendingInitialOperations=maxPendingInitialOperations;
  this.limits={inviteUnusedMs:600000,inviteAnswerMs:45000,guestInviteMs:180000,roomReadyMs:90000,...limits};
  for(const value of Object.values(this.limits))if(!Number.isFinite(value)||value<1)throw TypeError('Initial timeouts must be positive');
  this.owners=new WeakSet();this.attempts=new Set();this.pendingByOwner=new WeakMap();this.publications=new Set();this.initialOperations=new Set();
 }
 _event(type,data){try{const result=this.onEvent(type,clone(data));if(result?.then)result.catch(error=>console.error('[NNK initial observer]',error));}catch(error){console.error('[NNK initial observer]',error);}}
 _new(role,offerer){const retiredAttempts=new Set([...this.initialOperations].filter(r=>r.retired).map(r=>r.attemptId)).size,
   allocation={unadoptedAttempts:this.attempts.size,retiredAttempts,requestedOwners:1,maxTotalOwners:this.maxInitialOwnerSlots};
  let admitted=allocation.unadoptedAttempts+retiredAttempts+1<=this.maxInitialOwnerSlots&&this.initialOperations.size<this.maxPendingInitialOperations;
  if(admitted&&this.allocationGuard!==null)admitted=this.allocationGuard(Object.freeze({...allocation}))===true;
  if(!admitted){this._event('initial-allocation-refused',{role,...allocation,pendingInitialOperations:this.initialOperations.size});throw Error('Initial connection resource capacity limit reached; existing connections remain in use');}
  const owner=this.createOwner({role,offerer,contextFromOffer:true});
  const s=owner?.snapshot?.();if(!s||s.role!==role||s.offerer!==offerer||s.signalingPhase!=='new'||s.negotiations!==0||!s.contextFromOffer||!s.controlValidation||this.owners.has(owner))throw Error('Fresh strictly routed single-ended Owner required');
  this.owners.add(owner);return owner;
 }
 _attempt(role,offerer,{signal,onReady,onFailure,onTerminal,identity={},remoteIdentity={}}={}){
  if(signal?.aborted)throw Error('Initial attempt cancelled before creation');
  let owner=this._new(role,offerer);const connector=this,controller=new AbortController(),sessions=new Set(),timers=new Set();
  let liveOwner=owner,status='pending',adopted=false,closed=false,readinessStarted=false,readyConnection=null,readyResolve,readyReject,failureReported=false,deadlineTimer=null,rejectRetired;
  const operationRecords=new Set(),retiredPromise=new Promise((_resolve,reject)=>rejectRetired=reject);retiredPromise.catch(()=>{});
  const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});readyPromise.catch(()=>{});
  const attemptId=crypto.randomUUID();
  const event=(type,data={})=>connector._event(type,{attemptId,role,status,...data});
  function cleanup(){for(const timer of timers){clearTimeout(timer);clearInterval(timer);}timers.clear();signal?.removeEventListener('abort',abort);
   if(owner)connector.pendingByOwner.delete(owner);
   for(const session of sessions){try{session.end();}catch(error){event('discovery-cleanup-failed',{error:String(error)});}}sessions.clear();controller.abort();}
  function terminal(reason){connector.attempts.delete(attempt);try{const task=onTerminal?.({attemptId,status,adopted,reason});if(task?.then)task.catch(error=>event('terminal-observer-failed',{error:String(error)}));}catch(error){event('terminal-observer-failed',{error:String(error)});}}
  function fail(value){const error=errorOf(value);if(failureReported)return error;failureReported=true;event('initial-operation-failed',{error:String(error),stack:error.stack||null,adopted});
   if(!adopted&&!closed){closeUnentered(error.message);readyReject(error);}
   const hook=onFailure||connector.onFailure;try{const result=hook(error,{attemptId,role,status,adopted});if(result?.then)result.catch(e=>console.error('[NNK initial failure reporter]',e));}catch(e){console.error('[NNK initial failure reporter]',e);}return error;}
  function closeUnentered(reason='Initial attempt retired'){
   if(adopted||closed)return false;closed=true;status='closed';for(const record of operationRecords)record.retired=true;rejectRetired(Error(reason));cleanup();const retiring=liveOwner;liveOwner=null;
   owner=null;retiring?.stopTransport(reason);readyReject(Error(reason));if(readyConnection){const item=readyConnections.get(readyConnection);if(item){item.owner=null;item.adopt=null;}}
   event('attempt-closed',{reason});terminal(reason);return true;
  }
  function abort(){closeUnentered('Initial attempt cancelled');}
  const attempt={attemptId,readyPromise,signal:controller.signal,closeUnentered,
   snapshot:()=>({attemptId,role,status,adopted,closed,ownTimers:timers.size,ownSessions:sessions.size,ownerReferences:Number(liveOwner!==null)})};
  function assertCurrent(){if(closed&&!adopted)throw Error('Initial attempt retired');}
  function startDeadline(timeout,stage){if(deadlineTimer!==null){clearTimeout(deadlineTimer);timers.delete(deadlineTimer);}deadlineTimer=setTimeout(()=>fail(Error(stage+' deadline exceeded')),timeout);timers.add(deadlineTimer);}
  function perform(stage,invoke,{onLate}={}){
   assertCurrent();if(connector.initialOperations.size>=connector.maxPendingInitialOperations){event('initial-operation-refused',{stage,maxPendingInitialOperations:connector.maxPendingInitialOperations});throw Error('Initial native operation capacity limit reached');}
   const operationOwner=owner,record={attemptId,stage,retired:false,ownerReference:operationOwner!==null};operationRecords.add(record);connector.initialOperations.add(record);
   // The external operation rejects on retirement; native SDP/crypto work is not
   // cancellable and stays honestly observed until this underlying task settles.
   const native=Promise.resolve().then(()=>{assertCurrent();return invoke(operationOwner);}).then(value=>{
    if(closed&&!adopted){onLate?.(value);throw Error('Late initial operation retired');}return value;
   }).finally(()=>{operationRecords.delete(record);connector.initialOperations.delete(record);});native.catch(()=>{});
   return Promise.race([native,retiredPromise]);
  }
  const internal={get owner(){return owner;},attempt,controller,sessions,timers,assertCurrent,startDeadline,perform,
   fail,startReady(timeout){
    if(readinessStarted)return readyPromise;readinessStarted=true;
    const operationOwner=owner;perform('capability-readiness',()=>operationOwner.waitReady(timeout)).then(()=>{
     if(closed)return;const s=operationOwner.snapshot();if(!operationOwner.ready||operationOwner.stopped||!s.initialContextBound||s.linkState!=='open'||s.pingState!=='open'||s.negotiations!==1)throw Error('Native keepalive readiness incomplete');
     status='ready';
     const pairSession=operationOwner.sessionId;
     const connection=Object.freeze({attemptId,connectionSessionId:pairSession,role,closeUnentered,snapshot:()=>({attemptId,role,adopted,status})});
     readyConnection=connection;readyConnections.set(connection,{owner:operationOwner,identity:clone(remoteIdentity),sessionId:pairSession,adopted:false,
      adopt(){adopted=true;closed=true;status='adopted';cleanup();liveOwner=null;owner=null;terminal('registry adopted');event('attempt-adopted',{connectionSessionId:pairSession});}});
     // A ready callback may adopt synchronously before the method's caller receives this Attempt.
     const returned=onReady?.(connection);if(returned?.then)returned.catch(fail);
     readyResolve(connection);event('connection-ready',{connectionSessionId:pairSession});
    }).catch(fail);return readyPromise;
   }};
  connector.attempts.add(attempt);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  if(owner)connector.pendingByOwner.set(owner,{closeUnentered,fail});
  return internal;
 }
 async makeInvite(options={}){
  const a=this._attempt('host',true,options);a.startDeadline(this.limits.inviteUnusedMs,'Unused invitation');
  try{a.attempt.offerText=await a.perform('create-offer',owner=>owner.createOffer());a.assertCurrent();let answering=false;
   a.attempt.acceptAnswer=async code=>{if(answering)throw Error('This invitation already selected an answer');a.assertCurrent();answering=true;
    a.startDeadline(this.limits.inviteAnswerMs,'Host invitation initial handshake');
    try{await a.perform('accept-answer',owner=>owner.acceptAnswer(code));a.assertCurrent();a.startReady(this.limits.inviteAnswerMs);return true;}catch(error){throw a.fail(error);}};
   return a.attempt;
  }catch(error){throw a.fail(error);}
 }
 async joinInvite({code,onAnswerCode,...options}){
  const a=this._attempt('guest',false,options);a.startDeadline(this.limits.guestInviteMs,'Guest invitation initial handshake');
  try{const answer=await a.perform('accept-offer',owner=>owner.acceptOffer(code));a.assertCurrent();a.attempt.answerText=answer;
   if(onAnswerCode)await a.perform('answer-delivery',()=>onAnswerCode(answer));a.assertCurrent();a.startReady(this.limits.guestInviteMs);return a.attempt;
  }catch(error){throw a.fail(error);}
 }
 async listenRoom({code,signal,onOffer,onFailure=()=>{},publicationEpoch=0}){
  code=String(code||'').trim().toUpperCase();if(!ROOM.test(code))throw Error('Invalid room code');
  if(!this.signaling?.openRoomSession)throw Error('Original encrypted room signaling unavailable');
  const connector=this,controller=new AbortController();let session=null,timer=null,closed=false,dispatchCount=0,dispatchBytes=0,publication;
  const resources={snapshot:()=>({closed,ready:!!publication,ownTimers:Number(timer!==null),ownSessions:Number(session!==null),pendingDispatch:dispatchCount,pendingDispatchBytes:dispatchBytes})};this.publications.add(resources);
  let releaseDispatch;const dispatchReady=new Promise(resolve=>releaseDispatch=resolve);
  const ownCode=code,topic=this.signaling.roomTopic(code,'host'),offerTopic=this.signaling.roomTopic(code,'offer');
  function fail(error){connector._event('room-publication-failed',{code:ownCode,publicationEpoch,error:String(error)});try{const p=onFailure(error);if(p?.then)p.catch(e=>console.error('[NNK room failure reporter]',e));}catch(e){console.error('[NNK room failure reporter]',e);}}
  function endAndClearRetained(reason='Room publication ended'){
   if(closed)return false;closed=true;if(dispatchCount===0)connector.publications.delete(resources);if(timer!==null)clearInterval(timer);timer=null;
   signal?.removeEventListener('abort',abort);
   if(session){try{session.publishRaw(topic,'',true);connector._event('retained-clear-submitted',{code:ownCode,publicationEpoch,brokerAcknowledged:false});}catch(error){fail(error);}
    session.end();session=null;}
   controller.abort(reason);releaseDispatch();return true;
  }
  const abort=()=>endAndClearRetained('Publication cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();throw Error('Room publication cancelled');}
  try{session=await this.signaling.openRoomSession(code,'host',[offerTopic,topic],(received,message)=>{
   if(closed||received!==offerTopic)return;const bytes=new TextEncoder().encode(JSON.stringify(message)).byteLength;
   if(dispatchCount>=32||dispatchBytes+bytes>1048576){fail(Error('Current room discovery dispatch bound exceeded'));return;}
   dispatchCount++;dispatchBytes+=bytes;
   Promise.resolve(dispatchReady).then(()=>{if(!closed)return onOffer?.(message,publication);}).catch(fail).finally(()=>{dispatchCount--;dispatchBytes-=bytes;if(closed&&dispatchCount===0)connector.publications.delete(resources);});
  },controller.signal);
   if(closed){session.end();session=null;throw Error('Late publication retired');}
   const presence=async()=>{if(closed)return;await session.publish(topic,{ts:Date.now()},true);};
   await presence();if(closed)throw Error('Publication retired');// Refresh within the unchanged 8s discovery window, including a stale retained timestamp.
   timer=setInterval(()=>presence().catch(fail),5000);
   publication=Object.freeze({code:ownCode,publicationEpoch,endAndClearRetained,
    async publishAnswer(id,answer){if(closed||!guestID.test(id))throw Error('Room publication retired or invalid guest');
     await session.publish(connector.signaling.roomTopic(ownCode,'answer/'+id),{k:'answer',sdp:answer.sdp,hosts:answer.hosts||[]},false);if(closed)throw Error('Late room answer retired');},
    snapshot:()=>({code:ownCode,publicationEpoch,closed,ownTimers:Number(timer!==null),ownSessions:Number(session!==null),pendingDispatch:dispatchCount,pendingDispatchBytes:dispatchBytes})});
   releaseDispatch();return publication;
  }catch(error){endAndClearRetained('Publication failed');throw error;}
 }
 openRoomPublication(options){return this.listenRoom(options);}
 async answerRoomOffer({publication,message,...options}){
  if(!publication||!guestID.test(message?.guestId)||message?.sdp?.type!=='offer'||typeof message.sdp.sdp!=='string')throw Error('Invalid original room offer');
  const a=this._attempt('host',false,options);a.startDeadline(this.limits.roomReadyMs,'Host room initial handshake');
  try{const answerCode=await a.perform('accept-room-offer',owner=>owner.acceptOffer(this.rtc.encodeCode('offer',message.sdp,message.hosts)));a.assertCurrent();
   await a.perform('room-answer-publication',()=>publication.publishAnswer(message.guestId,this.rtc.decodeCode(answerCode)));a.assertCurrent();a.startReady(this.limits.roomReadyMs);return a.attempt;
  }catch(error){throw a.fail(error);}
 }
 async joinRoom({code,...options}){
  code=String(code||'').trim().toUpperCase();if(!ROOM.test(code))throw Error('Invalid room code');
  if(!this.signaling||typeof this.signaling.randomId!=='function'||typeof this.signaling.roomTopic!=='function'||typeof this.signaling.openRoomSession!=='function')throw Error('Original encrypted room signaling unavailable');
  const a=this._attempt('guest',true,options),id=this.signaling.randomId(),started=Date.now(),hostTopic=this.signaling.roomTopic(code,'host'),answerTopic=this.signaling.roomTopic(code,'answer/'+id);
  a.startDeadline(this.limits.roomReadyMs,'Guest room initial handshake');
  let session=null,seen=false,answerChosen=false,offerCode;
  try{offerCode=await a.perform('create-room-offer',owner=>owner.createOffer());a.assertCurrent();
   session=await a.perform('room-discovery-open',()=>this.signaling.openRoomSession(code,'guest-'+id,[answerTopic,hostTopic],(topic,message)=>{
    if(a.controller.signal.aborted)return;
    if(topic===hostTopic&&Number.isFinite(message?.ts)&&message.ts>=started-1000&&Date.now()-message.ts<=30000){seen=true;return;}
    if(topic!==answerTopic||answerChosen||message?.sdp?.type!=='answer')return;answerChosen=true;
    Promise.resolve().then(async()=>{a.assertCurrent();await a.perform('accept-room-answer',owner=>owner.acceptAnswer(this.rtc.encodeCode('answer',message.sdp,message.hosts)));a.assertCurrent();a.startReady(this.limits.roomReadyMs);}).catch(a.fail);
   },a.controller.signal),{onLate:value=>value.end()});a.assertCurrent();a.sessions.add(session);
   // Retained presence alone can be stale. Require a fresh decrypted timestamp.
   await new Promise((resolve,reject)=>{let interval=null;
    const end=error=>{clearTimeout(timeout);clearInterval(interval);a.timers.delete(timeout);a.timers.delete(interval);a.controller.signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
    const aborted=()=>end(Error('Room join cancelled'));const timeout=setTimeout(()=>end(Error('Host presence did not refresh within 8 seconds')),8000);a.timers.add(timeout);
    interval=setInterval(()=>{if(seen)end();},40);a.timers.add(interval);a.controller.signal.addEventListener('abort',aborted,{once:true});if(a.controller.signal.aborted)aborted();
   });a.assertCurrent();const decoded=this.rtc.decodeCode(offerCode);
   await a.perform('room-offer-publication',()=>session.publish(this.signaling.roomTopic(code,'offer'),{guestId:id,sdp:decoded.sdp,hosts:decoded.hosts||[]},false));a.assertCurrent();return a.attempt;
  }catch(error){session?.end();throw a.fail(error);}
 }
 snapshot(){return {activeAttempts:this.attempts.size,attempts:[...this.attempts].map(x=>x.snapshot())};}
 resourceSnapshot(){const attempts=[...this.attempts].map(a=>a.snapshot()),publications=[...this.publications].map(p=>p.snapshot());
  const sum=(items,key)=>items.reduce((total,item)=>total+item[key],0);
  return {activeAttempts:attempts.length,ownOwnerReferences:sum(attempts,'ownerReferences'),attemptTimers:sum(attempts,'ownTimers'),attemptSessions:sum(attempts,'ownSessions'),
   activePublications:publications.length,pendingPublications:publications.filter(p=>!p.ready&&!p.closed).length,retiringPublications:publications.filter(p=>p.closed).length,publicationTimers:sum(publications,'ownTimers'),publicationSessions:sum(publications,'ownSessions'),
   pendingDispatch:sum(publications,'pendingDispatch'),pendingDispatchBytes:sum(publications,'pendingDispatchBytes'),
   pendingInitialOperations:this.initialOperations.size,retiredPending:[...this.initialOperations].filter(r=>r.retired).length,pendingOwnerReferences:[...this.initialOperations].filter(r=>r.ownerReference).length,
   initialOperationStages:[...this.initialOperations].map(r=>({attemptId:r.attemptId,stage:r.stage,retired:r.retired,ownerReference:r.ownerReference})),
   distinctRetiredAttempts:new Set([...this.initialOperations].filter(r=>r.retired).map(r=>r.attemptId)).size,maxInitialOwnerSlots:this.maxInitialOwnerSlots,maxPendingInitialOperations:this.maxPendingInitialOperations};}
 transportStopped(owner,reason){const entry=this.pendingByOwner.get(owner);if(!entry)return false;
  this.pendingByOwner.delete(owner);entry.fail(Error('Initial transport stopped: '+String(reason)));return true;}
}


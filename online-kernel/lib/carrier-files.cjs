'use strict';
const path=require('node:path'),fs=require('node:fs');
const core=require('./batch-files.cjs');
const {validGrantExpiry}=require('./transfer-policy.cjs');
const workerPath=path.join(__dirname,'carrier-files-worker.cjs');
const failure=(message,code)=>Object.assign(Error(message),{code});
const revived=x=>Object.assign(Error(x?.message||'补传文件操作失败'),{code:x?.code,outcome:x?.outcome});
const committed=r=>r?.status==='committed';
function createCarrierFiles({root,version,stockExtensions=[],acquireGate,verifyGate,releaseGate}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||!Array.isArray(stockExtensions)||stockExtensions.some(x=>typeof x!=='string'))throw Error('补传文件目录或内置扩展清单无效');
 if(![acquireGate,verifyGate,releaseGate].every(x=>typeof x==='function'))throw Error('缺少本机补传文件安全门');
 let active=null,collecting=null;
 function start(data){
  let Worker;try{Worker=require('node:worker_threads').Worker;}catch{throw failure('当前游戏运行环境不支持独立补传文件工作线程','BATCH_WORKER_UNAVAILABLE');}
  if(typeof Worker!=='function')throw failure('当前游戏运行环境不支持补传文件工作线程','BATCH_WORKER_UNAVAILABLE');
  let cancelBuffer;try{if(typeof SharedArrayBuffer!=='undefined')cancelBuffer=new SharedArrayBuffer(4);}catch{}
  const worker=new Worker(workerPath,{workerData:{root,version,stockExtensions,...data,cancelBuffer}});
  let seq=0,ended=false,readySeen=false,expectedEnd=false,uncertain=false,onFailure=null;const pending=new Map();let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const readyTimer=setTimeout(()=>{uncertain=true;cancel();const e=failure('补传文件初始化超时，必须退出进程后检查恢复','BATCH_RECOVERY_REQUIRED');rejectReady(e);onFailure?.(e);},180000);
  function crash(message){if(ended)return;ended=true;uncertain=true;clearTimeout(readyTimer);const e=failure(message,'BATCH_RECOVERY_REQUIRED');cancel();rejectReady(e);for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();onFailure?.(e);}
  worker.on('error',e=>crash('补传文件工作线程异常，需退出游戏进程后检查恢复：'+e.message));
  worker.on('exit',code=>{if(!readySeen||pending.size||code!==0||!expectedEnd)crash('补传文件工作线程提前结束，结果需恢复确认');else ended=true;});
  worker.on('message',m=>{
   if(Object.hasOwn(m,'ready')){readySeen=true;clearTimeout(readyTimer);if(m.ready){if(data.mode==='collect')expectedEnd=true;resolveReady(m.result);}else{expectedEnd=true;const e=revived(m.error);if(m.recoveryRequired)e.code='BATCH_RECOVERY_REQUIRED';e.cleanupConfirmed=!m.recoveryRequired;rejectReady(e);}return;}
   const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(revived(m.error));else{if(['close','abort','commit'].includes(p.op))expectedEnd=true;p.resolve(m.result);}
  });
  function cancel(){if(cancelBuffer)Atomics.store(new Int32Array(cancelBuffer),0,1);}
  function rpc(op,args=[],timeout=180000){
   if(ended||uncertain)return Promise.reject(failure('补传文件工作线程结果待确认，不能继续写入','BATCH_RECOVERY_REQUIRED'));
   const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);uncertain=true;cancel();reject(failure('补传文件操作超时，工作线程未被强制终止；请退出游戏进程后检查恢复','BATCH_RECOVERY_REQUIRED'));},timeout);pending.set(id,{resolve,reject,timer,op});worker.postMessage({id,op,args});});
  }
  return {ready,rpc,cancel,set onFailure(value){onFailure=value;},get uncertain(){return uncertain;}};
 }
 async function collect(names,{signal}={}){
  if(collecting)throw Error('正在生成另一份整批文件清单');
  if(!Array.isArray(names)||!names.length||names.length>64||names.some(x=>typeof x!=='string'))throw Error('请明确选择本次补传扩展');
  if(signal?.aborted)throw failure('文件体检已取消','BATCH_CANCELLED');
  const job=start({mode:'collect',names:[...names]});collecting=job;
  const cancel=()=>job.cancel();signal?.addEventListener('abort',cancel,{once:true});
  try{const result=await job.ready;if(signal?.aborted)throw failure('文件体检已取消','BATCH_CANCELLED');return result;}
  finally{signal?.removeEventListener('abort',cancel);if(collecting===job)collecting=null;}
 }
 async function open(mode,grant,context){
  if(active)throw Error('本机正在处理另一批文件');
  if(!context||typeof context.isAuthorized!=='function'||!context.peerId||!context.owner||!context.connectionSessionId||!context.scope)throw Error('缺少当前连接的逐请求授权上下文');
  const batch=core.normalize(grant?.batch),frozenGrant={session:grant.session,peerSession:grant.peerSession,proposal:grant.proposal,digest:grant.digest,expires:grant.expires,batch};
  if(!['session','peerSession','proposal'].every(k=>/^[a-f0-9]{32}$/.test(frozenGrant[k]))||core.manifestDigest(batch)!==grant.digest||!validGrantExpiry(grant.expires))throw Error('本次整批文件授权无效或已到期');
  const captured={peerId:context.peerId,owner:context.owner,connectionSessionId:context.connectionSessionId,scope:context.scope};
  const marker={};active=marker;let gate,job,flag=null,poll=null,polling=false,cancelled=false,terminal=false,recoveryPending=false,receipt=null,closing=null,commitStarted=false,commitWork=null;
  async function authorized(){if(cancelled||Date.now()>=frozenGrant.expires||context.signal?.aborted)return false;try{const result=await context.isAuthorized(frozenGrant,captured);return result===true&&!cancelled&&Date.now()<frozenGrant.expires&&!context.signal?.aborted;}catch{return false;}}
  function cancel(){cancelled=true;job?.cancel();if(flag!==null)try{fs.writeSync(flag,Buffer.from([1]),0,1,0);fs.fsyncSync(flag);}catch{}}
  async function live(extra){if(!await authorized()||(extra&&await extra()!==true)){cancel();throw failure('本次逐请求补传授权已取消或到期','BATCH_CANCELLED');}}
  async function verify(){const result=await verifyGate(gate.token);if(result?.valid!==true){cancel();throw failure('本机文件安全门已失效','BATCH_CANCELLED');}}
  async function release(recoveryRequired){
   if(terminal)return;terminal=true;recoveryPending=recoveryRequired;clearInterval(poll);context.signal?.removeEventListener('abort',cancel);
   if(flag!==null){fs.closeSync(flag);flag=null;}
   try{const result=await releaseGate(gate.token,{recoveryRequired});if(result?.released!==true){recoveryPending=true;throw failure('本机补传事务尚需恢复确认','BATCH_RECOVERY_REQUIRED');}}
   finally{if(!recoveryRequired&&active===marker)active=null;}
  }
  async function recover(error){
   const unsafe=error?.code==='BATCH_RECOVERY_REQUIRED'||job?.uncertain;
   if(unsafe){cancel();try{await release(true);}catch{}error.code='BATCH_RECOVERY_REQUIRED';throw error;}
   try{await cleanupOnce();}
   catch(cleanupError){cancel();try{await release(true);}catch{}throw failure(error.message+'；文件恢复结果未确认：'+cleanupError.message,'BATCH_RECOVERY_REQUIRED');}
   throw error;
  }
  function cleanupOnce(){
   if(!closing)closing=(async()=>{try{const result=await job.rpc(mode==='source'?'close':'abort',[],300000);if(committed(result))receipt=result;await release(false);return receipt?{...receipt,activated:false}:result;}
    catch(e){cancel();try{await release(true);}catch{}throw failure(e.message,'BATCH_RECOVERY_REQUIRED');}})();
   return closing;
  }
  try{
   await live();gate=await acquireGate({phase:mode});
   if(!gate||!/^[a-f0-9]{32}$/.test(gate.token)||!/^\d+$/.test(gate.cancelIno)||gate.cancelFile!==path.join(root,'nnk-batches','gates',gate.token+'.cancel'))throw Error('本机补传安全门返回不匹配');
   const before=fs.lstatSync(gate.cancelFile,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==1n||String(before.ino)!==gate.cancelIno)throw Error('本机补传许可文件身份变化');
   flag=fs.openSync(gate.cancelFile,'r+');const after=fs.fstatSync(flag,{bigint:true});if(!after.isFile()||after.nlink!==1n||after.ino!==before.ino)throw Error('本机补传许可文件身份变化');
   await live();await verify();job=start({mode,grant:frozenGrant,gate});job.onFailure=()=>{cancel();release(true).catch(()=>{});};
   poll=setInterval(async()=>{if(polling||terminal)return;polling=true;try{if(!await authorized())cancel();}finally{polling=false;}},100);poll.unref?.();context.signal?.addEventListener('abort',cancel,{once:true});
   await job.ready;await live();
  }catch(e){
   cancel();clearInterval(poll);if(job&&!e.cleanupConfirmed){try{return await recover(e);}catch(error){throw error;}}
   if(gate){try{await release(e.code==='BATCH_RECOVERY_REQUIRED');}catch(cleanupError){if(e.code!=='BATCH_RECOVERY_REQUIRED')e=failure(e.message+'；安全门未释放：'+cleanupError.message,'BATCH_RECOVERY_REQUIRED');}}
   else if(active===marker)active=null;throw e;
  }
  async function stop(){
   if(receipt)return {...receipt,activated:false};cancel();
   if(commitWork){try{await commitWork;}catch{}if(receipt)return {...receipt,activated:false};}
   if(closing)return closing;
   if(terminal){if(recoveryPending)throw failure('本批文件结果需退出进程后恢复确认','BATCH_RECOVERY_REQUIRED');return {status:'closed'};}
   return cleanupOnce();
  }
  if(mode==='source')return {async read(index,offset,length){try{await live();const result=await job.rpc('read',[index,offset,length]);await live();return Buffer.from(result);}catch(e){return recover(e);}},close:stop};
  return {async chunk(index,offset,bytes,end){try{await live();return await job.rpc('chunk',[index,offset,bytes,end]);}catch(e){return recover(e);}},
   commit(isLive,onCommitted){
    if(receipt)return {...receipt,activated:false};if(commitStarted)throw Error('本批文件提交已经开始，不能重复提交');commitStarted=true;
    commitWork=(async()=>{try{await live(isLive);await verify();await job.rpc('prepare',[],900000);await live(isLive);await verify();
     const result=await job.rpc('commit',[],900000);if(!committed(result))throw failure('整批文件提交结果待确认','BATCH_RECOVERY_REQUIRED');receipt=result;
     try{await onCommitted?.(result);}finally{await release(!!result.warning);}
     return {...result,activated:false,reason:result.warning||'整批文件已完整提交；请检查扩展启用状态并正常退出、重启游戏后重新体检。'};
    }catch(e){if(receipt){try{await release(!!receipt.warning);}catch{}return {...receipt,activated:false,warning:receipt.warning||'提交后收尾未确认：'+e.message,reason:'整批文件已提交，收尾需确认：'+e.message};}return recover(e);}})();return commitWork;
   },abort:stop};
 }
 return {collect,source:(grant,context)=>open('source',grant,context),receiver:(grant,context)=>open('receive',grant,context)};
}
module.exports={createCarrierFiles,normalize:core.normalize,manifestDigest:core.manifestDigest};

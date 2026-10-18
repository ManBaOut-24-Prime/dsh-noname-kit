'use strict';
const crypto=require('node:crypto');
const {normalize,manifestDigest}=require('./batch-files.cjs');
const fail=(message,code)=>Object.assign(Error(message),{code});
function createCarrierFilesProxy({native,ipc}={}){
 if(typeof native?.request!=='function'||typeof ipc?.on!=='function'||typeof ipc?.removeListener!=='function')throw Error('本机补传文件通道不可用');
 const jobs=new Map();let disposed=false;
 function request(action,value){if(disposed)return Promise.reject(fail('本机补传文件通道已关闭','BATCH_CANCELLED'));return native.request(action,[value]);}
 function observe(j,result){if(j.kind!=='receive'||result?.status!=='committed'||typeof result.id!=='string'||!/^[a-f0-9]{32}$/.test(result.id))return;if(!j.receipt)j.receipt=result;if(j.onCommitted&&!j.notified){j.notified=true;try{j.onCommitted(j.receipt);}catch{}}}
 function event(_event,detail){const j=jobs.get(detail?.jobId);if(j&&detail.type==='committed')observe(j,detail.result);}
 ipc.on('nnk-transfer-file-event',event);
 async function collect(names,{signal}={}){
  if(signal?.aborted)throw fail('文件体检已取消','BATCH_CANCELLED');const jobId=crypto.randomBytes(16).toString('hex');
  const cancel=()=>{request('file_cancel',{jobId}).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  try{const r=await request('file_collect',{jobId,names});if(signal?.aborted)throw fail('文件体检已取消','BATCH_CANCELLED');return r;}finally{signal?.removeEventListener('abort',cancel);}
 }
 async function open(kind,grant,context){
  if(!context||typeof context.isAuthorized!=='function'||!context.peerId||!context.owner||!context.connectionSessionId||!context.scope)throw Error('缺少当前连接的逐请求授权');
  const batch=normalize(grant?.batch),frozenGrant={session:grant.session,peerSession:grant.peerSession,proposal:grant.proposal,digest:grant.digest,expires:grant.expires,batch};
  const captured={peerId:context.peerId,owner:context.owner,connectionSessionId:context.connectionSessionId,scope:context.scope};
  const j={jobId:crypto.randomBytes(16).toString('hex'),kind,active:true,receipt:null,notified:false,onCommitted:null,polling:false,commitStarted:false};jobs.set(j.jobId,j);
  async function authorized(){if(!j.active||Date.now()>=frozenGrant.expires||context.signal?.aborted)return false;try{const result=await context.isAuthorized(frozenGrant,captured);return result===true&&j.active&&Date.now()<frozenGrant.expires&&!context.signal?.aborted;}catch{return false;}}
  function cleanup(){clearInterval(j.timer);context.signal?.removeEventListener('abort',cancel);jobs.delete(j.jobId);}
  function cancel(){j.active=false;if(!j.cancelling)j.cancelling=request('file_cancel',{jobId:j.jobId}).then(result=>{j.cancelResult=result;observe(j,result);return result;},e=>{j.cancelError=e;});return j.cancelling;}
  async function live(extra){if(!await authorized()||(extra&&await extra()!==true)){cancel();throw fail('本次逐请求补传授权已取消或到期','BATCH_CANCELLED');}}
  try{await live();
   const pending=request(kind==='source'?'file_source':'file_receiver',{jobId:j.jobId,grant:frozenGrant});
   context.signal?.addEventListener('abort',cancel,{once:true});
   j.timer=setInterval(async()=>{if(j.polling)return;j.polling=true;try{if(!await authorized())cancel();}finally{j.polling=false;}},100);j.timer.unref?.();
   await pending;await live();
  }catch(e){cancel();await j.cancelling;cleanup();throw j.cancelError?.code==='BATCH_RECOVERY_REQUIRED'?j.cancelError:e;}
  async function stop(){if(j.receipt){cleanup();return {...j.receipt,activated:false};}if(j.stopping)return j.stopping;j.active=false;
   j.stopping=(async()=>{try{if(j.cancelling){await j.cancelling;if(j.receipt)return {...j.receipt,activated:false};if(j.cancelError)throw j.cancelError;return j.cancelResult||{status:'closed'};}const result=await request(kind==='source'?'file_close':'file_abort',{jobId:j.jobId});observe(j,result);return j.receipt?{...j.receipt,activated:false}:result;}finally{cleanup();}})();return j.stopping;
  }
  if(kind==='source')return {async read(index,offset,length){await live();const r=await request('file_read',{jobId:j.jobId,index,offset,length});await live();if(typeof r?.bytes!=='string'||r.bytes.length>43692)throw Error('补传源分片返回无效');const bytes=Buffer.from(r.bytes,'base64');if(bytes.length!==length||bytes.toString('base64')!==r.bytes)throw Error('补传源分片编码无效');return bytes;},close:stop};
  return {async chunk(index,offset,bytes,end){await live();if(!(bytes instanceof Uint8Array)||bytes.length>32768)throw Error('补传分片超出限制');return request('file_chunk',{jobId:j.jobId,index,offset,bytes:Buffer.from(bytes).toString('base64'),end});},
   async commit(isLive,onCommitted){
    if(j.receipt)return {...j.receipt,activated:false};if(j.commitStarted)throw Error('本批文件提交已经开始');j.commitStarted=true;j.onCommitted=onCommitted;
    try{await live(isLive);const r=await request('file_commit',{jobId:j.jobId});observe(j,r);cleanup();return r;
    }catch(e){if(j.receipt){cleanup();return {...j.receipt,activated:false,warning:j.receipt.warning||'提交后收尾未确认：'+e.message,reason:'整批文件已提交，收尾结果需确认：'+e.message};}throw e;}
   },abort:stop};
 }
 async function dispose(){if(disposed)return;const pending=[...jobs.values()].map(j=>request('file_cancel',{jobId:j.jobId}).then(r=>{observe(j,r);return r;}));for(const j of jobs.values())clearInterval(j.timer);jobs.clear();ipc.removeListener('nnk-transfer-file-event',event);await Promise.allSettled(pending);disposed=true;}
 return {collect,source:(g,c)=>open('source',g,c),receiver:(g,c)=>open('receive',g,c),dispose};
}
module.exports={createCarrierFilesProxy,normalize,manifestDigest};

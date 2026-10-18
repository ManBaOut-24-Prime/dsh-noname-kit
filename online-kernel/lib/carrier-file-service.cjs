'use strict';
const {normalize,manifestDigest}=require('./carrier-files.cjs');
const {validGrantExpiry}=require('./transfer-policy.cjs');
const JOB=/^[a-f0-9]{32}$/,MAX_JOBS=32,MAX_ACTOR_JOBS=8;
const fail=(message,code)=>Object.assign(Error(message),{code});
function exact(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw Error('补传本机接口参数无效');}
function grantOf(value){
 exact(value,['session','peerSession','proposal','digest','expires','batch']);
 if(!['session','peerSession','proposal'].every(k=>typeof value[k]==='string'&&JOB.test(value[k]))||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||!validGrantExpiry(value.expires))throw Error('本次逐请求文件授权已失效');
 const batch=normalize(value.batch);if(manifestDigest(batch)!==value.digest)throw Error('整批文件授权摘要不匹配');
 return {session:value.session,peerSession:value.peerSession,proposal:value.proposal,digest:value.digest,expires:value.expires,batch};
}
function canonicalBytes(value){if(typeof value!=='string'||value.length>43692||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('补传文件分片编码无效');const b=Buffer.from(value,'base64');if(b.length>32768||b.toString('base64')!==value)throw Error('补传文件分片超限或编码不规范');return b;}
class CarrierFileService{
 constructor({getDisk,emit=()=>{}}){if(typeof getDisk!=='function'||typeof emit!=='function')throw Error('缺少本机文件服务');Object.assign(this,{getDisk,emit});this.jobs=new Map();this.disks=new WeakMap();this.retired=new WeakMap();this.closed=false;this.calls=0;}
 disk(actor){let d=this.disks.get(actor);if(!d){d=this.getDisk(actor);this.disks.set(actor,d);}return d;}
 owned(actor,id){if(typeof id!=='string'||!JOB.test(id))throw Error('补传文件任务标识无效');const j=this.jobs.get(id);if(!j||j.actor!==actor)throw Error('不能访问其他窗口的补传文件任务');return j;}
 retire(j){if(j.finished)return;j.finished=true;j.active=false;j.abortController.abort();this.jobs.delete(j.id);let ids=this.retired.get(j.actor);if(!ids){ids=new Set();this.retired.set(j.actor,ids);}ids.add(j.id);}
 newJob(actor,id,kind,grant){
  if(this.closed||!actor||typeof actor!=='object'||actor.revoked===true||actor.wc?.isDestroyed?.()||typeof id!=='string'||!JOB.test(id)||this.jobs.has(id)||this.retired.get(actor)?.has(id))throw Error('补传文件任务已结束或标识无效');
  const own=[...this.jobs.values()].filter(j=>j.actor===actor);if(this.jobs.size>=MAX_JOBS||own.length>=MAX_ACTOR_JOBS||(this.retired.get(actor)?.size||0)>=256)throw Error('补传文件任务数量已达上限，请等待或重启房间');
  const j={id,actor,kind,grant,active:true,finished:false,handle:null,abortController:new AbortController(),pending:0,tail:Promise.resolve(),committed:null,commitStarted:false};
  this.jobs.set(id,j);return j;
 }
 async finish(j){
  j.active=false;j.abortController.abort();
  if(j.stopping)return j.stopping;
  j.stopping=(async()=>{try{await j.ready.catch(()=>{});if(j.handle){const result=await (j.kind==='source'?j.handle.close():j.handle.abort());if(result?.status==='committed')j.committed=result;return j.committed||result;}return {status:'closed'};}finally{this.retire(j);}})();return j.stopping;
 }
 async request(actor,action,args){
  const fields={file_collect:['jobId','names'],file_source:['jobId','grant'],file_receiver:['jobId','grant'],file_read:['jobId','index','offset','length'],file_chunk:['jobId','index','offset','bytes','end'],file_commit:['jobId'],file_abort:['jobId'],file_close:['jobId'],file_cancel:['jobId']};
  if(!Object.hasOwn(fields,action))throw Error('未知补传文件接口');exact(args,fields[action]);if(this.closed)throw Error('本机文件服务已关闭');
  if(action==='file_collect'){
   if(!Array.isArray(args.names)||!args.names.length||args.names.length>64||args.names.some(n=>typeof n!=='string'||n.length>120))throw Error('补传扩展选择无效');
   const j=this.newJob(actor,args.jobId,'collect');
   try{j.ready=Promise.resolve(this.disk(actor).collect(args.names,{signal:j.abortController.signal}));const r=await j.ready;if(!j.active)throw fail('文件清单读取已取消','BATCH_CANCELLED');return r;}finally{this.retire(j);}
  }
  if(action==='file_source'||action==='file_receiver'){
   const grant=grantOf(args.grant),j=this.newJob(actor,args.jobId,action==='file_source'?'source':'receive',grant);
   const context={peerId:grant.peerSession,owner:actor,connectionSessionId:grant.session,scope:grant.proposal,signal:j.abortController.signal,isAuthorized:()=>j.active&&!this.closed&&actor.revoked!==true&&!actor.wc?.isDestroyed?.()&&Date.now()<grant.expires};
   try{j.ready=Promise.resolve(this.disk(actor)[j.kind==='source'?'source':'receiver'](grant,context));j.handle=await j.ready;
    if(!j.active){await this.finish(j);throw fail('文件任务在启动前已取消','BATCH_CANCELLED');}return {ready:true,jobId:j.id};
   }catch(e){this.retire(j);throw e;}
  }
  const j=this.owned(actor,args.jobId);
  if(['file_abort','file_close','file_cancel'].includes(action))return this.finish(j);
  if(!j.active||j.finished||j.kind==='collect'||Date.now()>=j.grant.expires){this.finish(j).catch(()=>{});throw fail('文件任务已结束或授权到期','BATCH_CANCELLED');}
  if(j.pending>=16||this.calls>=64)throw Error('补传文件调用队列已满');
  let op;
  if(action==='file_read'||action==='file_chunk'){
   const flat=j.grant.batch.extensions.flatMap(e=>e.files),f=flat[args.index];
   if(!Number.isInteger(args.index)||!f||!Number.isSafeInteger(args.offset)||args.offset<0)throw Error('补传文件索引或偏移无效');
   if(action==='file_read'){
    if(j.kind!=='source'||!Number.isInteger(args.length)||args.length<0||args.length>32768||args.offset+args.length>f.size)throw Error('补传源读取范围无效');
    op=async()=>({bytes:(await j.handle.read(args.index,args.offset,args.length)).toString('base64')});
   }else{
    const bytes=canonicalBytes(args.bytes);if(j.kind!=='receive'||typeof args.end!=='boolean'||args.offset+bytes.length>f.size)throw Error('补传接收分片范围无效');
    op=()=>j.handle.chunk(args.index,args.offset,bytes,args.end);
   }
  }else{
   if(j.kind!=='receive'||j.commitStarted)throw Error('本批文件不能重复提交');j.commitStarted=true;
   op=async()=>{
    try{const result=await j.handle.commit(()=>j.active&&Date.now()<j.grant.expires,r=>{if(!j.committed){j.committed=r;this.emit(actor,{jobId:j.id,type:'committed',result:r});}});if(result?.status==='committed')j.committed=result;return result;}
    finally{if(j.committed)this.retire(j);}
   };
  }
  j.pending++;this.calls++;
  const run=j.tail.catch(()=>{}).then(async()=>{if(!j.active)throw fail('本次文件授权已取消','BATCH_CANCELLED');await j.ready;return op();});j.tail=run;
  try{return await run;}catch(e){if(e.code==='BATCH_RECOVERY_REQUIRED')this.retire(j);throw e;}finally{j.pending--;this.calls--;}
 }
 invalidateActor(actor){const jobs=[...this.jobs.values()].filter(j=>j.actor===actor);for(const j of jobs){j.active=false;j.abortController.abort();}return Promise.allSettled(jobs.map(j=>this.finish(j)));}
 close(){this.closed=true;const actors=new Set([...this.jobs.values()].map(j=>j.actor));return Promise.allSettled([...actors].map(a=>this.invalidateActor(a)));}
}
module.exports={CarrierFileService};

'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const core=require('./batch-files.cjs');
const {MAX_BYTES}=require('./transfer-policy.cjs');
const MAX_FILES=4096;
let root,flag=null,lease=null,tx=null,receipt=null,closed=false;
const sources=[];
const error=(message,code)=>Object.assign(Error(message),{code});
function serialize(e){return {message:e.message,code:e.code,outcome:e.outcome};}
function directory(full){const s=fs.lstatSync(full,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('补传目录包含链接或特殊文件');return s;}
function canonicalRoot(value){
 if(process.platform!=='win32')throw Error('补传仅支持已验证的 Windows 文件事务');
 const resolved=path.resolve(value),real=fs.realpathSync.native(resolved);
 if(resolved.toLowerCase()!==real.toLowerCase()||resolved===path.parse(resolved).root)throw Error('游戏目录不安全');
 let current=resolved;while(current!==path.dirname(current)){directory(current);current=path.dirname(current);}
 directory(path.join(resolved,'extension'));return resolved;
}
function part(s){return typeof s==='string'&&s.length>0&&s.length<=120&&s===s.normalize('NFC')&&!/[\x00-\x1f\x7f<>:"/\\|?*]/.test(s)&&!/[. ]$/.test(s)&&s!=='.'&&s!=='..'&&!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s);}
function relative(s){return s.length<=240&&s.split('/').every(part);}
function authorized(){
 if(workerData.cancelBuffer&&Atomics.load(new Int32Array(workerData.cancelBuffer),0)!==0)return false;
 if(workerData.mode!=='collect'){
  if(!Number.isSafeInteger(workerData.grant.expires)||Date.now()>=workerData.grant.expires||flag===null)return false;
  try{const s=fs.fstatSync(flag,{bigint:true}),b=Buffer.alloc(1);return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&String(s.ino)===workerData.gate.cancelIno&&fs.readSync(flag,b,0,1,0)===1&&b[0]===0;}catch{return false;}
 }return true;
}
function check(){if(!authorized())throw error('本次补传授权已取消或到期','BATCH_CANCELLED');}
function openFlag(){
 const g=workerData.gate;
 if(!g||!/^[a-f0-9]{32}$/.test(g.token)||!/^\d+$/.test(g.cancelIno)||g.cancelFile!==path.join(root,'nnk-batches','gates',g.token+'.cancel'))throw Error('补传许可文件位置不匹配');
 directory(path.join(root,'nnk-batches'));directory(path.join(root,'nnk-batches','gates'));
 const before=fs.lstatSync(g.cancelFile,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==1n||String(before.ino)!==g.cancelIno)throw Error('补传许可文件身份变化');
 flag=fs.openSync(g.cancelFile,'r');const after=fs.fstatSync(flag,{bigint:true});if(!after.isFile()||after.nlink!==1n||after.ino!==before.ino||after.size!==1n)throw Error('补传许可文件身份变化');check();
}
function stockCheck(batch){const stock=new Set(['boss','coin','cardpile','联机助手',...(workerData.stockExtensions||[])].map(s=>s.toLowerCase()));for(const e of batch.extensions)if(stock.has(e.name.toLowerCase()))throw Error('禁止补传官方内置扩展或联机内核');}
function stamp(s){return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');}
function openFile(full){
 const before=fs.lstatSync(full,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw Error('补传不接受链接或特殊文件');
 const fd=fs.openSync(full,'r');try{const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile()||s.nlink!==1n||stamp(s)!==stamp(before))throw Error('补传源文件在打开时发生变化');return {fd,stamp:stamp(s),size:Number(s.size)};}catch(e){fs.closeSync(fd);throw e;}
}
function hashFd(row){
 const h=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
 while(offset<row.size){check();const n=fs.readSync(row.fd,buffer,0,Math.min(buffer.length,row.size-offset),offset);if(!n)throw Error('补传源文件已截断');h.update(buffer.subarray(0,n));offset+=n;}
 if(stamp(fs.fstatSync(row.fd,{bigint:true}))!==row.stamp)throw Error('补传源文件在体检时发生变化');return h.digest('hex');
}
function collect(names){
 const batch=core.normalize({extensions:names.map(name=>({name,files:[{path:'extension.js',size:0,sha256:'0'.repeat(64)}]}))});stockCheck(batch);
 let total=0,count=0,entries=0;const extensions=[];
 for(const entry of batch.extensions){check();const base=path.join(root,'extension',entry.name);directory(base);const files=[],seen=new Set();
  function walk(full,rel){check();if(++entries>8192)throw Error('补传目录条目数量超出安全上限');const s=fs.lstatSync(full,{bigint:true});if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())throw Error('补传不接受链接或特殊文件');
   if(rel){if(!relative(rel)||seen.has(rel.toLowerCase()))throw Error('补传路径不安全或存在大小写别名');seen.add(rel.toLowerCase());}
   if(s.isDirectory()){for(const name of fs.readdirSync(full).sort())walk(path.join(full,name),rel?rel+'/'+name:name);return;}
   const size=Number(s.size);if(s.nlink!==1n||!Number.isSafeInteger(size)||++count>MAX_FILES||(total+=size)>MAX_BYTES)throw Error('补传文件数量、大小或硬链接不符合整批限制');
   const row=openFile(full);try{files.push({path:rel,size,sha256:hashFd(row)});}finally{fs.closeSync(row.fd);}
  }walk(base,'');extensions.push({name:entry.name,files});
 }check();return core.normalize({extensions});
}
function setup(){
 root=canonicalRoot(workerData.root);
 if(!['1.11.5.2','1.11.6'].includes(workerData.version))throw Error('补传仅支持已验证的官方游戏版本');
 if(workerData.mode==='collect')return collect(workerData.names);
 openFlag();const grant=workerData.grant,batch=core.normalize(grant.batch);stockCheck(batch);
 if(!['session','peerSession','proposal'].every(k=>/^[a-f0-9]{32}$/.test(grant[k]))||core.manifestDigest(batch)!==grant.digest)throw Error('整批文件授权绑定不匹配');
 if(workerData.mode==='source'){
  lease=core.acquireWriteLease(root);check();
  for(const e of batch.extensions){
   const dir=path.join(root,'extension',e.name);directory(dir);
   for(const f of e.files){check();let parent=dir;for(const component of f.path.split('/').slice(0,-1)){parent=path.join(parent,component);directory(parent);}
    const row=openFile(path.join(dir,...f.path.split('/')));sources.push(row);if(row.size!==f.size||hashFd(row)!==f.sha256)throw Error('房主文件已变化，请重新体检并逐请求授权');
   }
  }return {ready:true};
 }
 if(workerData.mode!=='receive')throw Error('未知补传文件操作');
 check();tx=new core.Transaction(root,batch,{session:grant.session,peerSession:grant.peerSession,proposal:grant.proposal,digest:grant.digest});return {transactionId:tx.id};
}
function closeSource(){let failure;while(sources.length){try{fs.closeSync(sources.pop().fd);}catch(e){failure=failure||e;}}if(lease){try{lease.release();lease=null;}catch(e){failure=failure||e;}}if(failure)throw failure;}
function finish(){closed=true;if(flag!==null){fs.closeSync(flag);flag=null;}parentPort.close();}
function cleanup(){if(tx&&!receipt&&!tx.closed){const result=tx.abort();if(result?.status==='committed')receipt=result;}closeSource();return receipt||{status:tx?'rolled_back':'closed',id:tx?.id};}
function call(op,args){
 if(op==='abort'||op==='close'){const result=cleanup();return {result,done:true};}
 if(closed)throw Error('本次文件操作已结束');check();
 if(op==='read'){
  if(workerData.mode!=='source')throw Error('源读取状态无效');lease.check();const [index,offset,length]=args,row=sources[index];
  if(!Number.isInteger(index)||!row||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(length)||length<0||length>32768||offset+length>row.size)throw Error('补传源读取范围无效');
  if(stamp(fs.fstatSync(row.fd,{bigint:true}))!==row.stamp)throw Error('房主源文件已变化');const b=Buffer.alloc(length);if(fs.readSync(row.fd,b,0,length,offset)!==length||stamp(fs.fstatSync(row.fd,{bigint:true}))!==row.stamp)throw Error('房主源文件已变化');check();return {result:b};
 }
 if(workerData.mode!=='receive'||!tx)throw Error('文件接收状态无效');
 if(op==='chunk'){const [index,offset,bytes,end]=args;if(!(bytes instanceof Uint8Array)||bytes.length>32768||typeof end!=='boolean')throw Error('补传分片无效');return {result:tx.putChunk(index,offset,Buffer.from(bytes),end)};}
 if(op==='prepare'){tx.prepare();check();return {result:{prepared:true,id:tx.id}};}
 if(op==='commit'){const result=tx.commit(authorized);if(result?.status!=='committed')throw Error('整批文件提交结果未确认');receipt=result;return {result,done:true};}
 throw Error('未知补传文件操作');
}
try{const result=setup();parentPort.postMessage({ready:true,result});if(workerData.mode==='collect')finish();}
catch(e){let recoveryRequired=false;try{cleanup();}catch(cleanupError){recoveryRequired=true;e.message+='；事务恢复未完成：'+cleanupError.message;}parentPort.postMessage({ready:false,error:serialize(e),recoveryRequired});finish();}
parentPort.on('message',message=>{
 if(closed)return;try{const {result,done}=call(message.op,message.args||[]);parentPort.postMessage({id:message.id,result});if(done)finish();}
 catch(e){if(e.outcome?.status==='recovery_required')e.code='BATCH_RECOVERY_REQUIRED';parentPort.postMessage({id:message.id,error:serialize(e)});}
});

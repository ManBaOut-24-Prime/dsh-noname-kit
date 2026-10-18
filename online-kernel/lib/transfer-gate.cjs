'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const token=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
// Actual native ownership is required independently of the renderer's round phase.
class TransferGate {
 constructor({getWindows,getActor,getEngine,onInvalidated=()=>{}}){Object.assign(this,{getWindows,getActor,getEngine,onInvalidated});this.gates=new Map();}
 epoch(root){const file=path.join(root,'nnk-batches','generation.json');if(!fs.existsSync(file))return '';
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536)throw Error('扩展文件代次记录不可用');return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
 blockers(actor){
  for(const win of this.getWindows()){
   if(win.isDestroyed())continue;const wc=win.webContents;if(wc===actor.wc)continue;
   const other=this.getActor(wc);if(other&&!other.revoked&&other.committed&&wc.getURL()===other.carrierURL)continue;
   const engine=this.getEngine(wc);if(engine?.actor?.root.root===actor.root.root)return true;
   const url=wc.getURL();if(!url||url==='about:blank')return true;
   try{if(new URL(url).origin===actor.origin)return true;}catch{return true;}
  }return !!actor.engine;
 }
 readiness(actor){
  const gate=this.gates.get(actor.root.root);let reason='';try{
   if(gate)reason=gate.failed?'本机补传结果需恢复，请先退出游戏进程并检查事务记录':'本机正在处理另一批文件，请等待完成';
   else if(fs.existsSync(path.join(actor.root.root,'nnk-batches','active')))reason='本机有未完成的文件事务，恢复前不能补传或载入游戏';
   else if(actor.fileEpoch!==this.epoch(actor.root.root))reason='扩展文件已更新，请正常退出并重启游戏后重新体检';
   else if(this.blockers(actor))reason='请先关闭本游戏目录的游戏窗口，保留插件房间后再补传';
  }catch{reason='本机文件事务状态无法确认';}return {available:!reason,reason,owned:gate?.actor===actor,recoveryRequired:gate?.failed===true,cancelled:gate?.cancelled===true};
 }
 acquire(actor,input){
  if(!input||!['source','receive','receiver'].includes(input.phase)||Object.keys(input).some(k=>!['phase'].includes(k)))throw Error('补传文件操作类型无效');
  const ready=this.readiness(actor);if(!ready.available)throw Error(ready.reason);
  const root=actor.root.root,base=path.join(root,'nnk-batches'),folder=path.join(base,'gates');
  for(const dir of [base,folder]){if(!fs.existsSync(dir))fs.mkdirSync(dir);const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('补传控制目录不安全');}
  const id=crypto.randomBytes(16).toString('hex'),cancelFile=path.join(folder,id+'.cancel'),fd=fs.openSync(cancelFile,'wx+');
  try{fs.writeSync(fd,Buffer.from([0]));fs.fsyncSync(fd);const gate={token:id,actor,root,cancelFile,fd,ino:String(fs.fstatSync(fd,{bigint:true}).ino),cancelled:false,failed:false};this.gates.set(root,gate);
   return {token:id,cancelFile,cancelIno:gate.ino};
  }catch(error){fs.closeSync(fd);throw error;}
 }
 current(actor,value){const id=typeof value==='string'?value:value?.token,gate=this.gates.get(actor.root.root);if(!token(id)||!gate||gate.actor!==actor||gate.token!==id)throw Error('原补传文件许可已失效');return gate;}
 verify(actor,value){const gate=this.current(actor,value);if(gate.cancelled||gate.failed)throw Error('补传文件许可已取消或需要恢复');if(this.blockers(actor)){this.invalidate(gate,'游戏窗口状态发生变化');throw Error('游戏窗口已打开，本批补传停止');}return {valid:true,token:gate.token};}
 invalidate(gate,reason){if(gate.cancelled)return;gate.cancelled=true;fs.writeSync(gate.fd,Buffer.from([1]),0,1,0);fs.fsyncSync(gate.fd);this.onInvalidated(gate.actor,{token:gate.token,reason});}
 invalidateActor(actor,reason){for(const gate of this.gates.values())if(gate.actor===actor)this.invalidate(gate,reason);}
 invalidateAll(reason){for(const gate of this.gates.values())this.invalidate(gate,reason);}
 release(actor,value,result={}){
  const gate=this.current(actor,value);this.invalidate(gate,'本批文件操作结束');
  if(result?.recoveryRequired===true||fs.existsSync(path.join(gate.root,'nnk-batches','active'))){gate.failed=true;return {released:false,recoveryRequired:true};}
  fs.closeSync(gate.fd);gate.fd=null;
  const s=fs.lstatSync(gate.cancelFile,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||String(s.ino)!==gate.ino){gate.failed=true;throw Error('补传许可文件身份变化，请检查恢复');}
  fs.unlinkSync(gate.cancelFile);this.gates.delete(gate.root);return {released:true};
 }
 assertGameAllowed(actor){
  if(this.gates.has(actor.root.root)||fs.existsSync(path.join(actor.root.root,'nnk-batches','active')))throw Error('补传或文件恢复尚未结束，不能载入游戏');
  if(actor.fileEpoch!==this.epoch(actor.root.root))throw Error('扩展文件已更新，必须正常退出并重启游戏后重新载入');
 }
 close(){for(const gate of this.gates.values()){try{this.invalidate(gate,'游戏进程正在退出');if(gate.fd!==null)fs.closeSync(gate.fd);}catch{}}this.gates.clear();}
}
module.exports={TransferGate};

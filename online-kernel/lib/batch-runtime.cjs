'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const core=require('./batch-files.cjs'),{Channel}=require('./batch-wire.cjs');
const keys=['session','peerSession','proposal','digest'];
const matches=(a,b)=>a&&b&&keys.every(k=>a[k]===b[k]);
function hashFd(fd){const h=crypto.createHash('sha256'),b=Buffer.alloc(65536);let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex')}
function durable(file,value){const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,value);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function stage(nnk){const e=nnk.env,s=e._status||{},h=nnk.state.host,g=nnk.state.guest;
  if(s.reloading||s.loading)return 'loading';
  if(s.over)return 'ended';
  if(s.waitingForPlayer)return 'waiting';
  if(e.game.phaseNumber>0||e.game.players?.length)return 'playing';
  if(g?.session?.entered||h?.engineOwner)return 'engine';
  return g?.session?.wasIn?'lobby':'idle';
}
function idle(nnk){return ['idle','lobby','waiting','ended'].includes(stage(nnk))}
function validRuntime(nnk){
  if(process.platform!=='win32'||!['1.11.5.2','1.11.6'].includes(nnk.env.lib.version))throw Error('补传事务仅支持已验证的官方 Windows 无名杀版本');
  if(!idle(nnk))throw Error('引擎正在运行对局或重载，本次文件事务停止');
}
/** One durable config operation for the full batch; never a saveConfig loop. */
async function activate(nnk,names,storage){
  const {lib,_status}=nnk.env;if(_status.reloading)throw Error('配置写入前已开始重载');
  if(lib.db){
    await new Promise((resolve,reject)=>{
      const tx=lib.db.transaction(['config'],'readwrite',{durability:'strict'});
      if(tx.durability!=='strict'){tx.abort();reject(Error('无法确认整批启用配置的 strict 持久性'));return}
      const store=tx.objectStore('config');
      const get=store.get('extensions');get.onsuccess=()=>{
        const previous=get.result;if(previous!==undefined&&!Array.isArray(previous)){tx.abort();return}
        store.put([...new Set([...(previous||lib.config.extensions||[]),...names])],'extensions');
        for(const name of names)store.put(true,'extension_'+name+'_enable');
      };
      tx.oncomplete=resolve;tx.onabort=()=>reject(Error('整批启用配置事务未提交'));tx.onerror=()=>{};
    });
  }else{
    const key=lib.configprefix+'config',raw=storage.getItem(key);let config=raw?JSON.parse(raw):{};
    if(!config||Array.isArray(config)||typeof config!=='object'||config.extensions!==undefined&&!Array.isArray(config.extensions))throw Error('本机启用配置格式无效');
    config.extensions=[...new Set([...(config.extensions||lib.config.extensions||[]),...names])];
    for(const name of names)config['extension_'+name+'_enable']=true;
    storage.setItem(key,JSON.stringify(config));
  }
  lib.config.extensions=[...new Set([...(lib.config.extensions||[]),...names])];for(const name of names)lib.config['extension_'+name+'_enable']=true;
}
/** Default remains paused. Only isolated programmatic probes inject enabled=true. */
function createRuntime(nnk,{enabled=false,storage,activateBatch=names=>activate(nnk,names,storage),coreOptions}={}){
  const channels=new WeakMap(),live=new Set(),sockets=new WeakMap(),history=new Map();
  let needsReload=false;
  function emit(type,data){nnk.modules.bridge?.emit(type,data)}
  function root(){const dir=nnk.modules.compat.gameRoot();if(!dir)throw Error('未找到官方游戏目录');return dir}
  const initialGeneration=core.generation(root());
  function observe(result){if(result?.status==='committed')needsReload=true;return result}
  function rootReady(){
    try{const dir=root();if(core.generation(dir)!==initialGeneration)needsReload=true;
      if(fs.existsSync(path.join(dir,'nnk-batches','active')))return false;
      const st=fs.lstatSync(path.join(dir,'extension'));return st.isDirectory()&&!st.isSymbolicLink();
    }catch(error){return false}
  }
  function checkBatch(batch){const names=nnk.env.lib.config?.all;const stock=new Set([...(names?.stockextension||[]),...(names?.plays||[]),'boss','coin','cardpile','联机助手']);
    for(const ext of batch.extensions)if(stock.has(ext.name))throw Error('禁止覆盖官方内置扩展或联机内核');
  }
  function source(grant){validRuntime(nnk);checkBatch(grant.batch);const dir=root(),lease=core.acquireWriteLease(dir),fds=[];
    try{
      for(const ext of grant.batch.extensions){core._test.tree(path.join(dir,'extension',ext.name));
        for(const f of ext.files){const full=path.join(dir,'extension',ext.name,...f.path.split('/')),fd=fs.openSync(full,'r');fds.push(fd);
          const st=fs.fstatSync(fd);if(!st.isFile()||st.size!==f.size||hashFd(fd)!==f.sha256||fs.fstatSync(fd).size!==f.size)throw Error('房主文件已变化，须重新提议并授权');
        }
      }
      let closed=false;return {read(index,offset,length){lease.check();if(closed||!idle(nnk))throw Error('房主源读取已结束或对局已开始');const b=Buffer.alloc(length);if(fs.readSync(fds[index],b,0,length,offset)!==length)throw Error('房主文件被截断');return b},close(){if(closed)return;closed=true;for(const fd of fds)fs.closeSync(fd);lease.release()}};
    }catch(error){for(const fd of fds)fs.closeSync(fd);lease.release();throw error}
  }
  function receiver(grant,socket){validRuntime(nnk);checkBatch(grant.batch);
    if(needsReload)throw Error('已有整批文件完成提交，须先重启并重新体检再补传');
    const tx=new core.Transaction(root(),grant.batch,Object.fromEntries(keys.map(k=>[k,grant[k]])),coreOptions);
    try{durable(path.join(tx.folder,'grant.json'),JSON.stringify(Object.fromEntries(keys.map(k=>[k,grant[k]]))));durable(path.join(tx.folder,'cancel.bin'),Buffer.from([0]))}
    catch(error){try{tx.abort()}catch(recoveryError){error.code='BATCH_RECOVERY_REQUIRED';error.message+='；恢复未完成：'+recoveryError.message}throw error}
    function authorized(){const a=nnk.modules.consent.authorization(socket);return matches(a,grant)&&Date.now()<grant.expires&&socket.channel.readyState==='open'&&idle(nnk)&&fs.readFileSync(path.join(tx.folder,'cancel.bin'))[0]===0}
    function classify(error){if(error.outcome?.status==='recovery_required')error.code='BATCH_RECOVERY_REQUIRED';else if(fs.readFileSync(path.join(tx.folder,'cancel.bin'))[0]===1)error.code='BATCH_CANCELLED';else if(Date.now()>=grant.expires)error.code='BATCH_EXPIRED';return error}
    return {chunk(index,offset,bytes,end){try{if(!authorized())throw Error('文件接收授权已经失效');return tx.putChunk(index,offset,bytes,end)}catch(error){throw classify(error)}},
      async commit(isLive){let result;try{if(!isLive()||!authorized())throw Error('整批提交授权已经失效');tx.prepare();result=observe(tx.commit(()=>isLive()&&authorized()))}catch(error){throw classify(error)}
        needsReload=true;
        if(result.warning)return {activated:false,reason:result.warning};
        if(!authorized())return {activated:false,reason:'整批文件已提交，随后授权结束；尚未自动启用。请检查完整批次并在对局结束后重启。'};
        try{await activateBatch(grant.batch.extensions.map(e=>e.name));return {activated:true,reason:'文件已整批提交并启用；重启游戏后重新体检，当前缺包提示不会提前清除。'}}
        catch(error){return {activated:false,reason:'整批文件已提交，启用配置未完成：'+error.message+'。请检查后启用并重启。'}}
      },abort(){return observe(tx.abort())}};
  }
  function remember(q){if(!q)return;history.set(q.session+':'+q.proposal,q);while(history.size>16)history.delete(history.keys().next().value)}
  function release(c){const done=c.close();live.delete(c);const save=()=>remember(c.snapshot());save();Promise.resolve(done).then(save,save)}
  function attach(socket,role){if(channels.has(socket))return;const c=new Channel({role,authorize:()=>nnk.modules.consent.authorization(socket),
    send:raw=>{if(socket.channel.readyState!=='open')throw Error('文件通道已关闭');if(socket.channel.bufferedAmount>2*1048576)throw Error('文件通道积压超过上限');socket.send(raw)},
    source,receiver:g=>receiver(g,socket),report:s=>{emit('batch_files',s);if(!live.has(c))remember(s);setTimeout(()=>nnk.modules.guest?.resumeEntry?.(socket),0)}});channels.set(socket,c);sockets.set(c,socket);live.add(c);socket.onDown(()=>release(c))}
  function changed(socket){const c=channels.get(socket);if(!c)return;
    const grant=nnk.modules.consent.authorization(socket);
    if(!grant){c.stop('cancelled','提议授权已终止');setTimeout(()=>nnk.modules.guest?.resumeEntry?.(socket),0);return}
    if(!enabled)return;
    if(!nnk.modules.consent.fileCapable(socket)){emit('batch_upgrade',{message:'对端未协商整批文件协议，补传停止且不降级。'});return}
    c.granted();
  }
  function reload(binding){for(const c of live){const q=c.snapshot();if(matches(q,binding)&&c.role==='guest'&&q.status==='committed'){
      if(!rootReady()||!idle(nnk)){emit('error',{message:'对局或文件恢复正在进行，不能重启游戏。'});return false}
      // Activation has completed before this button becomes available.
      nnk.env.game.reload();return true;
    }}return false}
  function retry(binding){for(const c of live){const q=c.snapshot();if(c.role==='host'&&matches(q,binding)&&['failed','cancelled','expired'].includes(q.status))return nnk.modules.consent.retry(sockets.get(c),binding)}return nnk.modules.consent.retryPending(binding)}
  function canEnter(socket){const file=channels.get(socket)?.snapshot(),status=file?.status;
    const pending=enabled&&nnk.modules.consent.waiting?.(socket)&&!(matches(file,nnk.modules.consent.current(socket))&&['failed','cancelled','expired','disconnected'].includes(status));
    return rootReady()&&!needsReload&&!['starting','receiving','committing'].includes(status)&&!pending;
  }
  function canStart(){return rootReady()&&!needsReload&&![...live].some(c=>['starting','waiting_receiver','sending','receiving','committing'].includes(c.snapshot()?.status))}
  return {capability:enabled?1:0,paused:!enabled,attach,changed,retry,detach:socket=>{const c=channels.get(socket);if(c)release(c)},
    canEnter,canStart,
    recover:()=>observe(core.recover(root())),
    handle:(socket,raw)=>{const c=channels.get(socket);if(c)return c.handle(raw);return typeof raw==='string'&&raw.includes('"nnk_files"')},
    snapshot:()=>[...history.values(),...Array.from(live).map(c=>c.snapshot()).filter(Boolean)],reload};
}
module.exports={createRuntime,activate,idle,stage,matches};

const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const validName=value=>typeof value==='string'&&value.length>0&&value.length<=120&&value===value.normalize('NFC')&&!/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value)&&!/[. ]$/.test(value)&&value!=='.'&&value!=='..'&&!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)&&!['联机助手','boss','coin','cardpile'].includes(value.toLowerCase());
function batchNames(names){
 if(!Array.isArray(names)||!names.length||names.length>64||names.some(name=>!validName(name))||new Set(names.map(name=>name.toLowerCase())).size!==names.length)throw Error('本批扩展启用名单无效');
 return names.slice();
}
function mergeNames(existing,names){
 if(existing===undefined)existing=[];
 if(!Array.isArray(existing)||existing.some(name=>typeof name!=='string'))throw Error('原扩展配置格式无效，请手动检查扩展设置');
 const merged=existing.slice();for(const name of names){if(merged.some(current=>current!==name&&current.toLowerCase()===name.toLowerCase()))throw Error('原扩展名单存在大小写冲突，请手动检查扩展设置');if(!merged.includes(name))merged.push(name);}return merged;
}
function sameNames(actual,expected){return Array.isArray(actual)&&actual.length===expected.length&&actual.every((name,index)=>name===expected[index]);}
const errorText=error=>String(error?.message||error||'保存失败').slice(0,160);

function enableInDB(indexedDB,prefix,names,timeoutMs){
 return new Promise((resolve,reject)=>{
  let ended=false,database=null,transaction=null,request=null,expected=null;
  const timer=setTimeout(()=>{try{transaction?.abort();}catch{}finish(Error('扩展启用配置保存超时，请手动检查扩展设置'));},timeoutMs);
  function finish(error){if(ended)return;ended=true;clearTimeout(timer);try{database?.close();}catch{}if(error)reject(error);else resolve({enabled:true,names:names.slice(),storage:'indexeddb'});}
  function failure(message){finish(Error(message));}
  function readBack(){
   if(ended)return;
   try{
    transaction=database.transaction(['config'],'readonly');const store=transaction.objectStore('config');let actualNames,correct=true;
    const list=store.get('extensions');list.onsuccess=()=>{actualNames=list.result;};
    for(const name of names){const read=store.get(`extension_${name}_enable`);read.onsuccess=()=>{if(read.result!==true)correct=false;};}
    transaction.onabort=()=>failure('扩展启用配置读回失败，请手动检查扩展设置');
    transaction.onerror=()=>{};
    transaction.oncomplete=()=>sameNames(actualNames,expected)&&correct?finish():failure('扩展启用配置读回不一致，请手动检查扩展设置');
   }catch(error){failure('无法核对扩展启用配置：'+errorText(error));}
  }
  try{
   if(!indexedDB||typeof indexedDB.open!=='function')throw Error('当前环境无法访问游戏配置数据库');
   request=indexedDB.open(prefix+'data');
   // This is the existing game's database. Never create or upgrade another one.
   request.onupgradeneeded=()=>{try{request.transaction?.abort();}catch{}failure('未找到当前游戏的配置数据库，请手动启用扩展');};
   request.onblocked=()=>failure('游戏配置数据库被占用，请手动检查扩展设置');
   request.onerror=()=>failure('无法打开游戏配置数据库，请手动检查扩展设置');
   request.onsuccess=()=>{
    database=request.result;if(ended){try{database.close();}catch{}return;}
    try{
     if(!database.objectStoreNames.contains('config'))throw Error('游戏配置数据库缺少 config 存储区');
     transaction=database.transaction(['config'],'readwrite');const store=transaction.objectStore('config');
     if(store.keyPath!==null||store.autoIncrement)throw Error('游戏配置存储格式与当前版本不一致');
     const current=store.get('extensions');
     current.onsuccess=()=>{
      try{expected=mergeNames(current.result,names);store.put(expected,'extensions');for(const name of names)store.put(true,`extension_${name}_enable`);}
      catch(error){try{transaction.abort();}catch{}failure(errorText(error));}
     };
     transaction.onabort=()=>failure('扩展启用配置未保存，请手动检查扩展设置');
     transaction.onerror=()=>{};
     transaction.oncomplete=readBack;
    }catch(error){try{transaction?.abort();}catch{}failure('无法保存扩展启用配置：'+errorText(error));}
   };
  }catch(error){finish(error);}
 });
}
function enableInStorage(storage,prefix,names){
 if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw Error('当前环境无法访问游戏配置');
 const key=prefix+'config',raw=storage.getItem(key);let config;
 try{config=JSON.parse(raw);}catch{throw Error('原游戏配置无法读取，请手动检查扩展设置');}
 if(!plain(config))throw Error('原游戏配置格式无效，请手动检查扩展设置');
 const expected=mergeNames(config.extensions,names);config.extensions=expected;
 for(const name of names)config[`extension_${name}_enable`]=true;
 // Read the live configuration immediately before this one synchronous write.
 storage.setItem(key,JSON.stringify(config));
 let actual;try{actual=JSON.parse(storage.getItem(key));}catch{}
 if(!plain(actual)||!sameNames(actual.extensions,expected)||names.some(name=>actual[`extension_${name}_enable`]!==true))throw Error('扩展启用配置读回不一致，请手动检查扩展设置');
 return {enabled:true,names:names.slice(),storage:'localstorage'};
}

export async function enableBatchExtensions({profile,names,indexedDB,storage,timeoutMs=10000}={}){
 const selected=batchNames(names),config=profile?.configStorage;
 if(!plain(config)||typeof config.prefix!=='string'||!config.prefix.length||config.prefix.length>160||/[\x00-\x1f\x7f]/.test(config.prefix)||typeof config.useDB!=='boolean')throw Error('缺少当前游戏的配置存储信息，请手动启用扩展');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>60000)throw Error('扩展配置保存时限无效');
 if(config.useDB)return enableInDB(indexedDB===undefined?globalThis.indexedDB:indexedDB,config.prefix,selected,timeoutMs);
 return enableInStorage(storage===undefined?globalThis.localStorage:storage,config.prefix,selected);
}

export function withBatchActivation(receiver,{batch,activate,onResult=()=>{}}={}){
 if(!receiver||typeof receiver.commit!=='function'||typeof activate!=='function'||typeof onResult!=='function')throw TypeError('缺少补传提交与扩展启用接口');
 const names=batchNames(batch?.extensions?.map(extension=>extension.name));let committing=null;
 function report(result){try{const pending=onResult(result);pending?.catch?.(()=>{});}catch{}return result;}
 return {...receiver,
  ...(typeof receiver.chunk==='function'?{chunk:receiver.chunk.bind(receiver)}:{}),
  ...(typeof receiver.abort==='function'?{abort:receiver.abort.bind(receiver)}:{}),
  commit(isLive,onCommitted){
   if(committing)return committing;
   committing=(async()=>{
    let durable=null,notified=false,notificationError=null,notificationWork=null,result;
    const committed=receipt=>{
     durable=receipt;notified=true;
     try{
      const pending=onCommitted?.(receipt);
      if(pending&&typeof pending.then==='function'){
       notificationWork=Promise.resolve(pending).catch(error=>{notificationError=error;throw error;});
       // The IPC receipt observer cannot await callbacks; the wrapper still does.
       notificationWork.catch(()=>{});return notificationWork;
      }
      return pending;
     }catch(error){notificationError=error;throw error;}
    };
    try{result=await receiver.commit(isLive,committed);}
    catch(error){
     if(!durable)throw error;
     return report({...durable,activated:false,restartRequired:true,reason:'整批文件已同步，收尾结果需确认：'+errorText(error)+'。请手动检查扩展并完全退出、重启无名杀。'});
    }
    if(result?.status!=='committed')return result;
    if(!notified)try{await committed(result);}catch(error){return report({...result,activated:false,restartRequired:true,reason:'整批文件已同步，状态通知需确认：'+errorText(error)+'。请手动检查扩展并完全退出、重启无名杀。'});}
    if(notificationWork)try{await notificationWork;}catch{}
    if(notificationError)return report({...result,activated:false,restartRequired:true,reason:'整批文件已同步，状态通知需确认：'+errorText(notificationError)+'。请手动检查扩展并完全退出、重启无名杀。'});
    if(result.warning)return report({...result,activated:false,restartRequired:true,reason:'整批文件已同步，但收尾尚需确认：'+errorText(result.warning)+'。请手动检查扩展并完全退出、重启无名杀。'});
    try{
     const saved=await activate(names.slice());if(saved?.enabled!==true)throw Error('扩展启用配置尚未确认');
     return report({...result,activated:true,restartRequired:true,reason:'整批文件已同步，已自动开启本批扩展。请完全退出并重启无名杀后重新体检；Ctrl+R 不能代替完整重启。'});
    }catch(error){return report({...result,activated:false,restartRequired:true,reason:'整批文件已同步，但自动开启未确认：'+errorText(error)+'。请手动检查扩展启用状态，并完全退出、重启无名杀。'});}
   })();return committing;
  }
 };
}

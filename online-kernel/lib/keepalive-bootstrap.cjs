'use strict';
// All operational data uses normal IPC; remote is used only for installation.
const path=require('node:path'),{randomUUID}=require('node:crypto');
const {ipcRenderer}=require('electron');
const REQUEST='nnk-keepalive-native-request',REPLY='nnk-keepalive-native-reply';
// A cached CommonJS export may be called by a later renderer Document.
// The caller supplies its DOM; a retired client is never reused for a new one.
const connections=new WeakMap();
function connect(options={}){
  const sourceWindow=options.window,sourceDocument=options.document;
  if(!sourceWindow||!sourceDocument||sourceWindow.document!==sourceDocument)throw Error('Actual caller Document required');
  const connected=connections.get(sourceDocument);if(connected)return connected;
  const root=options.root||path.join(process.resourcesPath,'app');
  const remote=require(path.join(root,'node_modules','@electron','remote'));
  const mainProcess=remote.getGlobal('process');
  const install=mainProcess.getBuiltinModule('node:module').createRequire(mainProcess.execPath)(
    path.join(root,'extension','联机助手','lib','keepalive-main.cjs'));
  if(install.ensureInstalled()!==true)throw Error('NNK native service installation failed');
  const pending=new Map(),subscriptions=new Set();let disposed=false;
  function unpack(message){
    if(!message||typeof message.ok!=='boolean')throw Error('Malformed native reply');
    if(!message.ok)throw Object.assign(Error(message.error?.message||'Native request failed'),{name:message.error?.name||'Error',code:message.error?.code,outcome:message.error?.outcome});
    return message.value;
  }
  function onReply(_event,message){
    const row=pending.get(message?.requestId);if(!row)return;
    pending.delete(message.requestId);clearTimeout(row.timer);
    try{row.resolve(unpack(message));}catch(error){row.reject(error);}
  }
  ipcRenderer.on(REPLY,onReply);
  function request(action,args=[]){
    if(disposed)return Promise.reject(Error('Document native client retired'));
    if(pending.size>=32)return Promise.reject(Error('Native pending request bound exceeded'));
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const row={resolve,reject,timer:setTimeout(()=>{pending.delete(requestId);reject(Object.assign(Error('Native operation deadline exceeded: '+action),/^file_/.test(action)?{code:'BATCH_RECOVERY_REQUIRED',outcome:{status:'unknown'}}:{}));},/^file_(?:collect|source|receiver|commit|abort|close|cancel)$/.test(action)?180000:10000)};
      pending.set(requestId,row);
      try{ipcRenderer.send(REQUEST,{requestId,action,args});}catch(error){pending.delete(requestId);clearTimeout(row.timer);reject(error);}
    });
  }
  function classifySync(){
    if(disposed)throw Error('Document native client retired');
    return unpack(ipcRenderer.sendSync(REQUEST,{requestId:randomUUID(),action:'classify',args:[],sync:true}));
  }
  function subscribe(channel,fn){
    if(disposed)throw Error('Document native client retired');
    const listener=(_event,value)=>fn(value);ipcRenderer.on(channel,listener);
    const off=()=>{ipcRenderer.removeListener(channel,listener);subscriptions.delete(off);};
    subscriptions.add(off);return off;
  }
  function dispose(){
    if(disposed)return;disposed=true;ipcRenderer.removeListener(REPLY,onReply);
    for(const off of [...subscriptions])off();
    for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error('Document native client retired'));}
    pending.clear();sourceWindow.removeEventListener('pagehide',dispose);
  }
  const client=Object.freeze({root,request,classifySync,
    validate(captured){if(disposed)return false;return unpack(ipcRenderer.sendSync(REQUEST,{requestId:randomUUID(),action:'validate',args:[captured],sync:true}));},
    bind(scope,requestId,port){if(disposed)throw Error('Retired document cannot bind');ipcRenderer.postMessage('nnk-keepalive-bind',{scope,requestId},[port]);},
    onInvalidated:fn=>subscribe('nnk-keepalive-invalidated',fn),
    onBindRejected:fn=>subscribe('nnk-keepalive-bind-rejected',fn),
    carrierStarted:token=>request('carrierStarted',[token]),createGame:input=>request('createGame',[input]),
    retireGameCreation:input=>request('retireGameCreation',[input]),
    closeGame:(id,cap)=>request('closeGame',[id,cap]),confirmClosed:id=>request('confirmClosed',[id]),
    snapshot:()=>request('snapshot'),report:(scope,value)=>request('report',[scope,value]),dispose});
  connections.set(sourceDocument,client);
  sourceWindow.addEventListener('pagehide',dispose,{once:true});return client;
}
function capture(nnk,options){
  const sourceWindow=options?.window,sourceDocument=options?.document;
  const native=connect({...options,root:sourceWindow?.__dirname}),info=native.classifySync(),documentToken=randomUUID();let retired=false;
  const onPagehide=()=>{retired=true;};sourceWindow.addEventListener('pagehide',onPagehide,{once:true});
  return {native,info,documentToken,isDocumentAlive(){return !retired&&sourceWindow.document===sourceDocument;},isCurrent(){
    if(retired||sourceWindow.document!==sourceDocument||['preliminary','retired'].includes(info.role))return false;
    try{return native.validate(info)===true;}catch(_){return false;}
  },retire(){retired=true;sourceWindow.removeEventListener('pagehide',onPagehide);native.dispose();}};
}
module.exports=Object.freeze({connect,capture});

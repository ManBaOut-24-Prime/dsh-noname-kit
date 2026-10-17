'use strict';
// NNK-owned service. Its only remote export installs listeners and returns true.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const KEY=Symbol.for('nnk.keepalive.native.service.v1');
const REQUEST='nnk-keepalive-native-request',REPLY='nnk-keepalive-native-reply';
const BIND='nnk-keepalive-bind',PORT='nnk-keepalive-port',INVALID='nnk-keepalive-invalidated',REJECT='nnk-keepalive-bind-rejected';
const FIELDS=['sessionId','roundId','documentGeneration','bindingId','bindingNonce','expectedOrigin'];
const same=(a,b)=>!!a&&!!b&&FIELDS.every(key=>a[key]===b[key]);
const json=value=>JSON.parse(JSON.stringify(value));
function scopeScalars(value){
  if(!value||typeof value!=='object')return null;
  const result={};for(const key of FIELDS){const item=value[key];result[key]=typeof item==='string'?item.slice(0,2048):
    typeof item==='number'&&Number.isFinite(item)?item:typeof item==='boolean'?item:null;}
  return result;
}
function actualRoot(filename){
  const root=path.resolve(path.dirname(filename),'../../..');
  if(path.resolve(filename)!==path.join(root,'extension','联机助手','lib','keepalive-main.cjs'))throw Error('Native helper is outside its installed NNK root');
  let cursor=path.parse(root).root;
  for(const part of root.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Linked NNK root refused');}
  for(const file of ['index.html','package.json'])if(!fs.statSync(path.join(root,file)).isFile())throw Error('Actual official root is incomplete');
  return root;
}
function createService(){
  const roots=new Map(),ordinary=new Map(),actors=new Map(),engines=new Map(),history=[],events=[];
  let beforeQuitInstalled=false;
  function note(type,data={}){events.push({at:Date.now(),type,...json(data)});if(events.length>160)events.shift();}
  function registerRoot(root){
    if(roots.has(root))return;
    if(roots.size>=8)throw Error('NNK native root registry is full');
    const primary=path.resolve(app.getAppPath()),entry=path.join(root,'extension','联机助手');
    let provision=null;
    const file=path.join(entry,'nnk-local-provision.json');
    if(fs.existsSync(file)){
      if(fs.lstatSync(file).isSymbolicLink())throw Error('Linked local provisioning file refused');
      provision=JSON.parse(fs.readFileSync(file,'utf8'));
      if(provision.sameMachineOneShell!==true||typeof provision.origin!=='string')throw Error('Local provisioning must be explicitly labelled');
      const url=new URL(provision.origin);
      if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.origin!==provision.origin)throw Error('Provisioning origin must be exact loopback');
      if([...roots.values()].some(value=>value.origin===provision.origin&&value.root!==root))throw Error('A provisioned origin is already assigned to another root');
    }
    if(root!==primary&&!provision)throw Error('A foreign actual root requires external local provisioning');
    roots.set(root,{root,entry,origin:provision?.origin||null,primary:root===primary,provisioned:!!provision});
    note('root-registered',{root,provisioned:!!provision});
  }
  function source(event){
    const wc=event.sender,frame=event.senderFrame;
    if(!wc||wc.isDestroyed()||!frame||frame!==wc.mainFrame||frame.parent!==null)throw Error('Actual main-frame source required');
    const win=BrowserWindow.fromWebContents(wc);
    if(!win||win.isDestroyed())throw Error('Actual native source window required');
    return {wc,win,url:frame.url};
  }
  function rootFor(url){
    const parsed=new URL(url);
    if(parsed.pathname!=='/index.html')throw Error('Ordinary source must be a normal official index document');
    for(const root of roots.values())if(root.origin===parsed.origin)return root;
    for(const root of roots.values()){
      if(root.primary&&!root.origin&&['http:','https:'].includes(parsed.protocol)&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)){
        root.origin=parsed.origin;return root;
      }
    }
    throw Error('Actual document origin is not registered for an NNK root');
  }
  function navArgs(event,url,inPlace,isMain){
    return url&&typeof url==='object'?{url:url.url,inPlace:!!url.isSameDocument,main:!!url.isMainFrame}:
      {url,inPlace:!!inPlace,main:!!isMain};
  }
  function ownListener(wc,name,fn,owned){wc.on(name,fn);owned.push([name,fn]);}
  function row(win,role){return {windowId:win.id,webContentsId:win.webContents.id,role,createdAt:Date.now(),closed:false,destroyed:false};}
  function track(win,record,owned,changed=()=>{}){
    // BrowserWindow.webContents is a native getter and throws once the owner
    // has been destroyed. Capture the actual EventEmitter while it is alive.
    const wc=win.webContents;
    const closed=()=>{record.closed=true;record.closedAt=Date.now();changed();};
    const destroyed=()=>{
      record.destroyed=true;record.destroyedAt=Date.now();
      for(const [name,fn] of owned)wc.removeListener(name,fn);
      owned.length=0;changed();
    };
    win.once('closed',closed);wc.once('destroyed',destroyed);
    return ()=>{win.removeListener('closed',closed);wc.removeListener('destroyed',destroyed);};
  }
  function ordinaryFor(src){
    let state=ordinary.get(src.wc);
    if(state)return state;
    if(ordinary.size>=32)throw Error('Ordinary document registry is full');
    const root=rootFor(src.url),owned=[];
    state={wc:src.wc,win:src.win,root,url:src.url,pending:false,bootCapability:randomUUID(),owned};
    ordinary.set(src.wc,state);
    ownListener(src.wc,'did-start-navigation',(event,url,inPlace,isMain)=>{
      const nav=navArgs(event,url,inPlace,isMain);if(nav.main&&!nav.inPlace){state.pending=true;state.bootCapability=null;}
    },owned);
    ownListener(src.wc,'did-frame-navigate',(event,url,code,text,isMain)=>{
      const nav=navArgs(event,url,false,isMain);if(nav.main){state.url=nav.url;state.pending=false;state.bootCapability=randomUUID();}
    },owned);
    const destroyed=()=>state.dispose();
    state.dispose=()=>{
      if(ordinary.get(src.wc)===state)ordinary.delete(src.wc);
      src.wc.removeListener('destroyed',destroyed);
      for(const [name,fn] of owned)src.wc.removeListener(name,fn);owned.length=0;
    };
    src.wc.once('destroyed',destroyed);
    return state;
  }
  function releaseClosedActor(actor){
    if(actor.row.closed&&actor.engine){
      const engine=actor.engine;invalidate(engine,'carrier-native-owner-closed');
      try{if(!engine.win.isDestroyed())engine.win.destroy();}catch(error){note('carrier-engine-close-failed',{actorId:actor.id,windowId:engine.row.windowId,error:String(error)});}
    }
    if(actor.row.closed&&actor.row.destroyed&&actor.engine&&actor.engine.row.closed&&actor.engine.row.destroyed&&
      !BrowserWindow.fromId(actor.engine.row.windowId))releaseEngine(actor.engine);
    if(actor.row.closed&&actor.row.destroyed&&!actor.engine&&!BrowserWindow.fromId(actor.row.windowId)){
      actors.delete(actor.wc);actor.wc=null;actor.win=null;actor.profile=null;actor.pendingCommands=[];actor.sourceState=null;
      note('carrier-native-owner-released',{actorId:actor.id,windowId:actor.row.windowId});
    }
  }
  function releaseEngine(engine){
    const actor=engine.actor,record=engine.row;
    history.push({windowId:record.windowId,webContentsId:record.webContentsId,role:record.role,
      createdAt:record.createdAt,closed:record.closed,destroyed:record.destroyed,
      closedAt:record.closedAt,destroyedAt:record.destroyedAt,actorId:actor.id});
    if(history.length>96)history.shift();
    clearTimeout(engine.timer);engine.timer=null;
    for(const port of engine.pendingPorts)try{port.close();}catch(_){}engine.pendingPorts.clear();
    engines.delete(engine.wc);engine.win=null;engine.wc=null;engine.scope=null;engine.closeCapability=null;
    delete record.lastReport;actor.engine=null;
  }
  function actorFor(src,started=true){
    const actor=actors.get(src.wc);
    if(!actor||actor.revoked||actor.row.closed||actor.row.destroyed||src.url!==actor.carrierURL||
      !actor.committed||(started&&actor.starts!==1))throw Error('Actual live carrier document required');
    return actor;
  }
  function engineInfo(engine){
    return {role:'engine',engineRole:engine.role,actorId:engine.actor.id,windowId:engine.row.windowId,
      root:engine.actor.root.root,engineRoot:engine.actor.root.root,origin:engine.actor.origin,
      scope:engine.scope?{...engine.scope}:null,pendingStartupNavigation:engine.pending,
      startupNavigationCount:engine.starts,documentCommitCount:engine.commits,requestedURL:engine.requestedURL};
  }
  function classify(src){
    const engine=engines.get(src.wc);
    if(engine){
      if(engine.revoked||engine.row.closed||engine.row.destroyed)return {...engineInfo(engine),role:'retired',scope:null};
      if(engine.pending||!engine.scope||src.url!==engine.requestedURL)return {...engineInfo(engine),role:'preliminary',scope:null};
      return engineInfo(engine);
    }
    const actor=actors.get(src.wc);
    if(actor)return {role:actor.revoked?'retired':actor.committed&&src.url===actor.carrierURL?'carrier':'preliminary',
      actorId:actor.id,windowId:actor.row.windowId,root:actor.root.root,origin:actor.origin,scope:null};
    const state=ordinaryFor(src);
    if(state.pending||state.url!==src.url)return {role:'preliminary',windowId:src.win.id,scope:null};
    return {role:'ordinary',windowId:src.win.id,root:state.root.root,origin:new URL(src.url).origin,
      bootCapability:state.bootCapability,scope:null};
  }
  function invalidate(engine,reason,navigation=null){
    if(engine.revoked)return;
    engine.revoked=true;clearTimeout(engine.timer);engine.timer=null;
    for(const port of engine.pendingPorts)try{port.close();}catch(_){}engine.pendingPorts.clear();
    const detail={sourceWindowId:engine.row.windowId,actorId:engine.actor.id,scope:engine.scope&&{...engine.scope},reason,navigation};
    note('engine-invalidated',detail);
    for(const wc of [engine.wc,engine.actor.wc])try{if(!wc.isDestroyed())wc.send(INVALID,detail);}catch(_){}
  }
  function native(state){
    if(!state||!state.win||state.win.isDestroyed()||!state.wc||state.wc.isDestroyed())return null;
    return {...state.row,url:state.wc.getURL(),rendererPid:state.wc.getOSProcessId(),
      leaveListeners:state.win.listenerCount('leave-full-screen'),renderListeners:state.wc.listenerCount('render-view-deleted'),
      windowMax:state.win.getMaxListeners(),webContentsMax:state.wc.getMaxListeners()};
  }
  function snapshot(actor){
    return {at:Date.now(),actorId:actor.id,root:actor.root.root,origin:actor.origin,
      carrierStarts:actor.starts,carrierNavigationCount:actor.navigationCount,unexpectedCarrierNavigations:actor.unexpected,
      carrier:native(actor),currentEngine:actor.engine?{...engineInfo(actor.engine),native:native(actor.engine),
        closeCapability:{...actor.engine.closeCapability},revoked:actor.engine.revoked,bindingTransferred:actor.engine.bound}:null,
      mainMemoryBytes:process.memoryUsage(),history:history.filter(value=>value.actorId===actor.id),
      events:events.slice(),registryObservation:'not-observed-by-product-service'};
  }
  function beginCarrier(src,args){
    const [cap,profile,command]=args,state=ordinary.get(src.wc);
    if(engines.has(src.wc)||actors.has(src.wc)||!state||state.pending||!cap||cap!==state.bootCapability||state.url!==src.url)throw Error('Current ordinary boot capability required');
    if(actors.size>=8)throw Error('Carrier actor registry is full');
    if(!profile||profile.root!==state.root.root||profile.origin!==new URL(src.url).origin)throw Error('Actual boot root/origin mismatch');
    if(!command||!['create_room','join_room','join_invite'].includes(command.action))throw Error('An initial online command is required');
    const actor={id:randomUUID(),wc:src.wc,win:src.win,root:state.root,origin:new URL(src.url).origin,
      profile:json(profile),pendingCommands:[json(command)],transitionTicket:randomUUID(),row:row(src.win,'carrier'),
      starts:0,runToken:null,committed:false,revoked:false,navigationCount:0,unexpected:0,engine:null,generation:0,operationGeneration:0,owned:[],sourceState:state};
    const target=new URL('/extension/'+encodeURIComponent('联机助手')+'/keepalive/carrier.html',actor.origin);
    target.searchParams.set('nnkTransition',actor.transitionTicket);actor.carrierURL=target.href;
    state.dispose();
    actors.set(src.wc,actor);actor.disposeTrack=track(src.win,actor.row,actor.owned,()=>queueMicrotask(()=>releaseClosedActor(actor)));
    ownListener(src.wc,'did-start-navigation',(event,url,inPlace,isMain)=>{
      const nav=navArgs(event,url,inPlace,isMain);if(!nav.main||nav.inPlace)return;
      actor.navigationCount++;
      if(actor.navigationCount!==1||nav.url!==actor.carrierURL){actor.revoked=true;actor.unexpected++;if(actor.engine)invalidate(actor.engine,'carrier-document-replaced',nav);}
      note('carrier-navigation',{actorId:actor.id,...nav,count:actor.navigationCount,unexpected:actor.unexpected});
    },actor.owned);
    ownListener(src.wc,'did-frame-navigate',(event,url,code,text,isMain)=>{
      const nav=navArgs(event,url,false,isMain);if(nav.main&&nav.url===actor.carrierURL&&!actor.revoked&&actor.navigationCount===1){actor.committed=true;actor.sourceState=null;}
    },actor.owned);
    return {accepted:true,actorId:actor.id,windowId:actor.row.windowId,carrierURL:actor.carrierURL,
      transitionTicket:actor.transitionTicket,commandRequestId:command.requestId??command.id??null};
  }
  const creationFields=['role','partySessionId','roundId','operationId','operationGeneration'];
  function creationOperation(input){
    if(!input||!['host','guest'].includes(input.role)||!['partySessionId','roundId','operationId'].every(k=>typeof input[k]==='string'&&input[k].length>0&&input[k].length<=160)||!Number.isSafeInteger(input.operationGeneration)||input.operationGeneration<=0)throw Error('Exact bounded game operation required');
    return Object.fromEntries(creationFields.map(k=>[k,input[k]]));
  }
  const sameCreation=(a,b)=>!!a&&!!b&&creationFields.every(k=>a[k]===b[k]);
  function createGame(actor,input){
    if(actor.engine)throw Error('Previous native owner must be confirmed destroyed');
    const operation=creationOperation(input);if(operation.operationGeneration<=actor.operationGeneration)throw Error('Fresh game operation required');
    const before=new Set(BrowserWindow.getAllWindows());
    const emitted=app.emit('second-instance',{},[],process.cwd()),created=BrowserWindow.getAllWindows().filter(win=>!before.has(win));
    if(!emitted||created.length!==1)throw Error('Original official factory did not create exactly one native window');
    const win=created[0],ticket=randomUUID(),target=new URL('/index.html',actor.origin);
    target.searchParams.set('nnkEntryTicket',ticket);
    const primaryRoot=[...roots.values()].find(value=>value.primary);
    const factoryIndexURL=primaryRoot?.origin?new URL('/index.html',primaryRoot.origin).href:win.webContents.getURL();
    const engine={actor,win,wc:win.webContents,role:input.role,input:json(input),requestedURL:target.href,ticket,factoryIndexURL,
      row:row(win,'engine'),scope:null,starts:0,commits:0,pending:false,bound:false,revoked:false,owned:[],pendingPorts:new Set(),
      deadline:Date.now()+10000,timer:null,closeCapability:{actorId:actor.id,operationId:input.operationId,
        operationGeneration:input.operationGeneration,nativeOwnerNonce:randomUUID()}};
    actor.engine=engine;actor.operationGeneration=input.operationGeneration;actor.lastCreation=operation;engines.set(engine.wc,engine);
    track(win,engine.row,engine.owned,()=>queueMicrotask(()=>releaseClosedActor(actor)));
    ownListener(engine.wc,'did-start-navigation',(event,url,inPlace,isMain)=>{
      const nav=navArgs(event,url,inPlace,isMain);if(!nav.main||nav.inPlace)return;
      if(!engine.starts&&!engine.bound&&nav.url===engine.factoryIndexURL){note('factory-preliminary-navigation',{windowId:win.id,...nav});return;}
      if(engine.revoked)return;
      if(engine.bound||nav.url!==engine.requestedURL||engine.starts>=4||Date.now()>engine.deadline){invalidate(engine,'unapproved-engine-navigation',nav);return;}
      engine.starts++;engine.pending=true;
      note('engine-navigation-start',{windowId:win.id,starts:engine.starts,...nav});
    },engine.owned);
    ownListener(engine.wc,'did-frame-navigate',(event,url,code,text,isMain)=>{
      const nav=navArgs(event,url,false,isMain);if(!nav.main)return;
      if(nav.url!==engine.requestedURL){note('factory-preliminary-commit',{windowId:win.id,...nav});return;}
      if(engine.revoked||engine.bound||!engine.pending){invalidate(engine,'unapproved-engine-commit',nav);return;}
      engine.pending=false;engine.commits++;actor.generation++;
      engine.scope={sessionId:input.partySessionId,roundId:input.roundId,documentGeneration:actor.generation,
        bindingId:randomUUID(),bindingNonce:randomUUID(),expectedOrigin:actor.origin};
      note('engine-document-commit',{windowId:win.id,scope:engine.scope,starts:engine.starts,commits:engine.commits});
    },engine.owned);
    for(const eventName of ['did-fail-provisional-load','did-fail-load'])ownListener(engine.wc,eventName,(event,code,description,url,isMain)=>{
      note('engine-load-failed',{windowId:win.id,eventName,code,description,url,isMain});
    },engine.owned);
    engine.timer=setTimeout(()=>invalidate(engine,'engine-startup-deadline'),10000);
    win.loadURL(engine.requestedURL).catch(error=>{note('engine-loadURL-rejected',{windowId:win.id,error:String(error)});});
    return {windowId:win.id,closeCapability:{...engine.closeCapability},requestedURL:engine.requestedURL,scope:null,bootstrapping:true};
  }
  function closeGame(actor,id,cap){
    const engine=actor.engine,fields=['actorId','operationId','operationGeneration','nativeOwnerNonce'];
    if(!engine)return {windowId:id,already:true};
    if(id!==engine.row.windowId||!cap||fields.some(field=>cap[field]!==engine.closeCapability[field]))return {rejected:true,reason:'stale-native-close',windowId:id};
    clearTimeout(engine.timer);engine.timer=null;
    for(const port of engine.pendingPorts)try{port.close();}catch(_){}engine.pendingPorts.clear();
    if(!engine.win.isDestroyed())engine.win.destroy();
    return {windowId:id,requested:true,closed:engine.row.closed,destroyed:engine.row.destroyed};
  }
  function confirmClosed(actor,id){
    const engine=actor.engine?.row.windowId===id?actor.engine:null;
    const record=engine?.row||history.find(value=>value.actorId===actor.id&&value.windowId===id);
    const confirmed=!!record&&record.closed&&record.destroyed&&!BrowserWindow.fromId(id);
    if(confirmed&&engine){
      releaseEngine(engine);
    }
    return {windowId:id,closed:!!record?.closed,destroyed:!!record?.destroyed,confirmed};
  }
  function retireGameCreation(actor,input){
    const operation=creationOperation(input),engine=actor.engine;
    if(operation.operationGeneration<actor.operationGeneration||operation.operationGeneration===actor.operationGeneration&&!sameCreation(actor.lastCreation,operation)||engine&&!sameCreation(engine.input,operation))throw Error('Retired creation does not match the current native operation');
    // This main-process barrier also rejects a create request delivered after cancellation.
    actor.operationGeneration=operation.operationGeneration;actor.lastCreation=operation;
    if(!engine){note('engine-creation-retired-empty',{actorId:actor.id,operation});return {operation,cancelled:true,windowId:null,confirmed:true,ownerAbsent:true};}
    const windowId=engine.row.windowId,capability={...engine.closeCapability};
    const close=closeGame(actor,windowId,capability);if(close.rejected)throw Error('Exact creation retirement was refused');
    const proof=confirmClosed(actor,windowId);note('engine-creation-retired',{actorId:actor.id,operation,windowId,confirmed:proof.confirmed});
    return {operation,cancelled:true,windowId,closeCapability:capability,...proof,ownerAbsent:proof.confirmed&&actor.engine===null};
  }
  function action(src,name,args){
    if(name==='classify')return classify(src);
    if(name==='validate'){
      const info=classify(src),captured=args[0];
      return info.role==='ordinary'?info.bootCapability===captured?.bootCapability&&info.windowId===captured.windowId:
        info.role==='engine'?same(info.scope,captured?.scope)&&info.windowId===captured.windowId:
        info.role==='carrier'&&info.actorId===captured?.actorId;
    }
    if(name==='beginCarrier')return beginCarrier(src,args);
    if(name==='cancelCarrierTransition'){
      const actor=actors.get(src.wc);
      if(!actor||actor.starts||actor.committed||actor.transitionTicket!==args[0]||!actor.sourceState||
        src.url!==actor.sourceState.url)throw Error('Current uncommitted source transition required');
      for(const [eventName,fn] of actor.owned)actor.wc.removeListener(eventName,fn);
      actor.owned.length=0;actor.disposeTrack();actor.pendingCommands=[];actors.delete(src.wc);
      // Reinstall the ordinary navigation guard with its original Document lease.
      const previous=actor.sourceState,fresh=ordinaryFor(src);fresh.bootCapability=previous.bootCapability;
      note('carrier-transition-cancelled',{actorId:actor.id});return {cancelled:true};
    }
    if(name==='report'){
      const engine=engines.get(src.wc);
      if(engine){if(engine.revoked||engine.pending||src.url!==engine.requestedURL||!same(engine.scope,args[0]))throw Error('Retired engine report refused');
        const value=json(args[1]);delete value.wire;engine.row.lastReport=value;return true;}
      const actor=actorFor(src);actor.lastReport=json(args[1]);return true;
    }
    const actor=actorFor(src,name!=='carrierStarted');
    if(name==='carrierStarted'){
      if(actor.starts!==0){note('carrier-start-repeated',{actorId:actor.id});throw Error('Carrier starts only once');}
      if(typeof args[0]!=='string'||!args[0])throw Error('Carrier run token required');
      actor.starts=1;actor.runToken=args[0];const pendingCommands=actor.pendingCommands;actor.pendingCommands=[];
      return {actorId:actor.id,windowId:actor.row.windowId,profile:json(actor.profile),pendingCommands:json(pendingCommands),
        root:actor.root.root,origin:actor.origin,transitionTicket:actor.transitionTicket};
    }
    if(name==='createGame')return createGame(actor,args[0]);
    if(name==='retireGameCreation')return retireGameCreation(actor,args[0]);
    if(name==='closeGame')return closeGame(actor,args[0],args[1]);
    if(name==='confirmClosed')return confirmClosed(actor,args[0]);
    if(name==='snapshot')return snapshot(actor);
    throw Error('Unknown native operation');
  }
  function request(event,message){
    let response;
    try{
      if(!message||typeof message.requestId!=='string'||message.requestId.length>160||typeof message.action!=='string'||
        !Array.isArray(message.args)||message.args.length>8||Buffer.byteLength(JSON.stringify(message))>1048576)throw Error('Malformed bounded native request');
      const src=source(event);response={requestId:message.requestId,ok:true,value:json(action(src,message.action,message.args)??null)};
    }catch(error){response={requestId:typeof message?.requestId==='string'?message.requestId.slice(0,160):null,ok:false,error:{message:String(error.message||error),name:error.name||'Error'}};}
    if(message?.sync===true)event.returnValue=response;else event.reply(REPLY,response);
  }
  function bind(event,message){
    const ports=Array.from(event.ports||[]);let src=null,engine=engines.get(event.sender)||null;
    try{
      src=source(event);engine=engines.get(src.wc);
      if(!engine||engine.revoked||engine.row.closed||engine.row.destroyed||engine.pending||!engine.scope||
        src.url!==engine.requestedURL||new URL(src.url).origin!==engine.scope.expectedOrigin)throw Error('Unknown/retired actual engine source');
      if(ports.length!==1)throw Error('Exactly one actual port required');
      if(!same(message?.scope,engine.scope))throw Error('Binding scope mismatch');
      if(engine.bound)throw Error('Engine port already transferred');
      actorFor({wc:engine.actor.wc,win:engine.actor.win,url:engine.actor.wc.getURL()});
      engine.pendingPorts.add(ports[0]);
      engine.actor.wc.postMessage(PORT,{actorId:engine.actor.id,sourceWindowId:engine.row.windowId,role:engine.role,scope:{...engine.scope}},[ports[0]]);
      engine.pendingPorts.delete(ports[0]);engine.bound=true;clearTimeout(engine.timer);engine.timer=null;
      note('engine-port-transferred',{windowId:engine.row.windowId,scope:engine.scope});
    }catch(error){
      for(const port of ports)try{port.close();}catch(_){}
      if(engine)engine.pendingPorts.clear();
      const detail={requestId:typeof message?.requestId==='string'?message.requestId.slice(0,160):null,reason:String(error.message||error),
        candidateScope:scopeScalars(message?.scope),trustedCurrentScope:engine?.scope?{...engine.scope}:null,
        actual:{sourceWebContentsId:event.sender?.id,sourceFrameURL:event.senderFrame?.url||null,
          sourceFrameIsMain:!!event.senderFrame&&event.senderFrame===event.sender?.mainFrame&&event.senderFrame.parent===null,candidatePortCount:ports.length}};
      note('engine-binding-rejected',detail);try{if(!event.sender.isDestroyed())event.sender.send(REJECT,detail);}catch(_){}
    }
  }
  function beforeQuit(){
    ipcMain.removeListener(REQUEST,request);ipcMain.removeListener(BIND,bind);
    for(const engine of engines.values()){clearTimeout(engine.timer);for(const port of engine.pendingPorts)try{port.close();}catch(_){}}
    beforeQuitInstalled=false;
  }
  ipcMain.on(REQUEST,request);ipcMain.on(BIND,bind);app.once('before-quit',beforeQuit);beforeQuitInstalled=true;
  return {version:1,registerRoot};
}
function ensureInstalled(){
  const root=actualRoot(__filename);
  let service=globalThis[KEY];
  if(service&&service.version!==1)throw Error('An incompatible NNK native service already exists');
  if(!service){service=createService();Object.defineProperty(globalThis,KEY,{value:service,configurable:false});}
  service.registerRoot(root);return true;
}
module.exports=Object.freeze({ensureInstalled});

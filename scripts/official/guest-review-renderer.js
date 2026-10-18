(async function() {
  const {lib,game,ui,get,_status,ai}=await import('/noname.js');
  const fs=require('node:fs'), process=require('node:process');
  const ActualPC=window.RTCPeerConnection;
  const checks=[]; const check=(name,fn)=>{try{if(!fn())throw new Error('assertion failed');checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:e.message})}};
  const timers=new Map();let id=0,closes=0;const pcs=[];
  window.setTimeout=window.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id};window.clearTimeout=window.clearInterval=n=>timers.delete(n);
  const nativeClose=lib.element.ws.onclose;
  lib.element.ws.onclose=function(){closes++;return nativeClose.apply(this,arguments)};
  lib.configprefix='b4-review-';lib.config={connect_nickname:'probe',mode:'connect',mode_config:{}};
  lib.status.reload=1;lib.db=undefined;_status.connectMode=true;
  let saves=[];const nativeSave=game.saveConfig;
  game.saveConfig=function(key,...rest){saves.push({key,reloading:!!_status.reloading});return nativeSave.call(this,key,...rest)};
  class PC {
    constructor(){this.connectionState='new';this.channels=[];this.closed=0;this.localDescription={type:'offer',sdp:'fixture'};pcs.push(this)}
    createDataChannel(label){const c={label,readyState:'connecting',bufferedAmount:0,send(){},close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.()}};this.channels.push(c);return c}
    createOffer(){return new Promise(()=>{})}
    close(){if(this.closed)return;this.closed++;this.connectionState='closed';this.channels.forEach(c=>c.close())}
  }
  window.RTCPeerConnection=PC;
  window.__nnk__={env:{lib,game,ui,get,_status,ai},state:{},modules:{bridge:{emit(){},setPhase(){}},config:{get:()=>[]},signaling:{randomId:()=> 'probe',roomTopic:(a,b)=>a+'/'+b}}};
  const nnk=window.__nnk__,root=process.env.NNK_SOURCE_ROOT;
  (0,eval)(fs.readFileSync(root+'/online-kernel/src/rtc.js','utf8'));
  nnk.modules.rtc.trackPc=()=>{};
  (0,eval)(fs.readFileSync(process.env.NNK_GUEST_PATH || root+'/online-kernel/src/guest.js','utf8'));nnk.modules.guest.init();
  function enter(stage){_status.reloading=false;game.online=false;game.ws=null;game.sandbox=null;nnk.modules.guest.joinByRoomCode('ABC234');const s=nnk.state.guest.session;const [main,ping]=s.pc.channels;main.readyState=ping.readyState='open';main.onopen();ping.onopen();main.onmessage({data:JSON.stringify({nnk_stage:stage})});return s}
  const s=enter('loaded');game.online=true;
  lib.config.reconnect_info=['host','id','room'];lib.config.tmp_user_roomId='before';game.roomId='room';ui.exit=undefined;
  localStorage.setItem(lib.configprefix+'config',JSON.stringify({reconnect_info:['host','id','room'],tmp_user_roomId:'before'}));
  saves=[];ui.click.exit();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const stored=JSON.parse(localStorage.getItem(lib.configprefix+'config'));
  check('actual native exit reconnect_info persists',()=>stored.reconnect_info.length===1);
  check('actual native exit tmp_user_roomId removed',()=>!('tmp_user_roomId' in stored));
  check('actual saveConfig calls run before reloading',()=>saves.length===2&&saves.every(v=>!v.reloading));
  check('actual native reload waits behind config saves',()=>_status.reloading&&_status.waitingToReload);
  check('explicit exit releases owner without native close reload',()=>closes===0&&s.disposed&&s.pc.closed===1&&timers.size===0);
  check('explicit exit registers no autorejoin',()=>!localStorage.getItem(lib.configprefix+'nnk_guest_pending'));
  nnk.modules.guest.cancelJoin();
  const orders=[['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']];
  for(const stage of ['lobby','loaded'])for(const order of orders){
    const s=enter(stage),[main,ping]=s.pc.channels,ice=s.pc.onconnectionstatechange,before=pcs.length,oldCloses=closes;
    if(stage==='loaded')game.online=true;
    for(const e of order){if(e==='ice'){s.pc.connectionState='failed';ice()}else(e==='main'?main:ping).close()}
    check(stage+' '+order.join('/')+' recovers once',()=>pcs.length===before+1&&nnk.state.guest.rejoinCode==='ABC234'&&s.disposed&&s.pc.closed===1);
    if(stage==='loaded'){
      check('actual native close once '+order.join('/'),()=>closes===oldCloses+1&&!game.online&&game.ws===null&&game.sandbox===null&&_status.reloading);
      check('actual native reload persists autorejoin '+order.join('/'),()=>JSON.parse(localStorage.getItem(lib.configprefix+'nnk_guest_pending')).code==='ABC234');
    }
    nnk.modules.guest.cancelJoin();check(stage+' '+order.join('/')+' cancel cleans timers',()=>timers.size===0);
  }
  window.RTCPeerConnection=ActualPC;_status.reloading=false;game.online=false;game.ws=null;
  nnk.modules.rtc.waitGather=()=>Promise.resolve();
  let received,ended=0;
  nnk.modules.signaling.openRoomSession=(code,role,topics,cb)=>{received=cb;Promise.resolve().then(()=>cb(code+'/host',{ts:1}));return Promise.resolve({publish:async()=>{},end(){ended++}})};
  const tick=()=>require('node:timers/promises').setImmediate();
  nnk.modules.guest.joinByRoomCode('ABC234');const realSession=nnk.state.guest.session;
  const deadline=Date.now()+6000;while(!received&&Date.now()<deadline)await tick();
  check('actual Chromium offer reaches controlled signaling',()=>!!received);
  if(received){received('ABC234/answer/probe',{sdp:{type:'answer',sdp:'invalid SDP fixture'}});const until=Date.now()+6000;while(!realSession.disposed&&Date.now()<until)await tick();}
  check('actual Chromium invalid SDP releases PC and MQTT',()=>realSession.disposed&&realSession.pc.connectionState==='closed'&&ended===1&&timers.size===0);
  nnk.modules.guest.cancelJoin();
  const engineVersion=/version:\s*"([^"]+)"/.exec(fs.readFileSync(process.env.NNK_ENGINE_ROOT+'/game/update.js','utf8'))?.[1];
  return {ok:checks.every(c=>c.passed),checks,saves,storage:stored,sourceRoot:root,guestPath:process.env.NNK_GUEST_PATH||null,engineVersion,shellPackageVersion:JSON.parse(fs.readFileSync(process.env.NNK_ENGINE_ROOT+'/package.json','utf8')).version,note:'Actual official ESM ui.click.exit, ws.onclose, game.saveConfig, game.reload and localStorage path; lib.status.reload prevents navigation; controlled close order plus actual Chromium invalid-SDP operation, no live peers/GUI acceptance.'};
})()

(async function() {
  const {lib,game,ui,get,_status,ai}=await import('/noname.js');
  await import('/noname/init/polyfill.js');
  const {security}=await import('/noname/util/sandbox/security.js');
  lib.node={};await security.initSecurity({lib,game,ui,get,_status,ai});
  const fs=require('node:fs'),process=require('node:process');
  const checks=[],events=[],pcs=[],timers=new Map();let timerId=0,closed=0,waitingUpdates=0,broadcasts=0,overResults=0;
  const check=(name,fn)=>{try{if(!fn())throw new Error('assertion failed');checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:e.stack})}};
  window.setTimeout=window.setInterval=(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId};window.clearTimeout=window.clearInterval=id=>timers.delete(id);
  const nativeClose=lib.element.Client.prototype.close;
  lib.element.Client.prototype.close=function(){closed++;return nativeClose.apply(this,arguments)};
  lib.configprefix='b5-host-probe-';lib.config={mode:'connect',mode_config:{},connect_nickname:'Host probe'};lib.configOL={mode:'single',number:2};lib.status.reload=1;lib.db=undefined;
  // Rendering consumers and remote sends are controlled; native connection/Client.close/exit/save/reload/over stay real.
  ui.create.roomInfo=ui.create.chat=()=>{};ui.control={show(){}};ui.clear=()=>{};
  ui.create.dialog=()=>({content:document.createElement('div'),add(){}});ui.create.div=()=>document.createElement('div');
  game.stopCountChoose=()=>{};game.controlOver=()=>{overResults++};game.updateWaiting=()=>{waitingUpdates++};game.broadcast=()=>{broadcasts++};
  class PC {
    constructor(){this.channels=[];this.closed=0;this.connectionState='new';this.signalingState='have-local-offer';this.localDescription={type:'offer',sdp:'fixture'};pcs.push(this)}
    createDataChannel(label){const c={label,readyState:'connecting',bufferedAmount:0,sent:[],send(data){this.sent.push(data)},close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.()}};this.channels.push(c);return c}
    createOffer(){return new Promise(()=>{})}setRemoteDescription(){return Promise.resolve()}
    close(){if(this.closed)return;this.closed++;this.connectionState='closed';this.channels.forEach(c=>c.close())}
  }
  window.RTCPeerConnection=PC;
  window.__nnk__={env:{lib,game,ui,get,_status,ai},state:{},modules:{bridge:{emit:(type,data)=>events.push({type,data}),setPhase(){}},config:{get:()=>[]},signaling:{roomTopic:(a,b)=>a+'/'+b,openRoomSession:()=>new Promise(()=>{})}}};
  const nnk=window.__nnk__,root=process.env.NNK_SOURCE_ROOT;
  (0,eval)(fs.readFileSync(root+'/online-kernel/src/rtc.js','utf8'));nnk.modules.rtc.trackPc=()=>{};
  (0,eval)(fs.readFileSync(root+'/online-kernel/src/host.js','utf8'));nnk.modules.host.init();const api=nnk.modules.host;
  function room(){
    _status.over=false;_status.waitingForPlayer=false;_status.reloading=false;_status.waitingToReload=false;_status.connectMode=true;
    game.players=[];game.dead=[];game.me={};game.online=false;game.roomId='probe-room';game.onlinezhu=null;lib.configOL={mode:'single',number:2};
    api.createInternetRoom('single');nnk.state.host.stage='loaded';game.createServer();_status.waitingForPlayer=true;
  }
  function open(){api.refreshInvite('invite');const pc=pcs.at(-1),c=pc.channels[0];c.readyState='open';c.onopen();const client=lib.node.clients.at(-1);if(!client)throw new Error(JSON.stringify(events.filter(e=>e.type==='error')));return {pc,conn:pc._nnkConn,client}}
  const orders=[['ice','main','ping'],['ice','ping','main'],['main','ice','ping'],['main','ping','ice'],['ping','ice','main'],['ping','main','ice']];
  for(const stage of ['waiting','ongoing'])for(const order of orders){
    room();const {pc,conn,client}=open();check(stage+' '+order.join('/')+' uses actual native Client',()=>client instanceof lib.element.Client&&conn._entered&&JSON.parse(pc.channels[0].sent.find(s=>s.startsWith('["opened"')))[0]==='opened');
    let uninit=0,unwait=0;const player={playerid:client.id,nickname:'guest',setNickname(value){this.nickname=value},unwait(value){if(value==='ai')unwait++}};
    game.connectPlayers=[{playerid:client.id,uninitOL(){uninit++}}];lib.node.observing.push(client);lib.playerOL[client.id]=player;game.onlinezhu=client.id;
    _status.waitingForPlayer=stage==='waiting';if(stage==='ongoing')game.players=[player];
    pc.channels[1].readyState='open';pc.channels[1].onopen();const ice=pc.onconnectionstatechange,beforeClose=closed,beforeWaiting=waitingUpdates,beforeBroadcast=broadcasts;
    api.cancelAll();check(stage+' '+order.join('/')+' dissolve retains native connection and engine owner',()=>pc.closed===0&&!client.closed&&lib.node.clients.includes(client)&&nnk.state.host.engineOwner.bridges.includes(conn));
    for(const event of order){if(event==='ice'){pc.connectionState='failed';ice()}else pc.channels[event==='main'?0:1].close()}
    check(stage+' '+order.join('/')+' real Client.close exactly once removes clients and observers',()=>closed===beforeClose+1&&client.closed&&!lib.node.clients.includes(client)&&!lib.node.observing.includes(client)&&pc.closed===1&&timers.size===0);
    if(stage==='waiting')check('native waiting seat/zhu/update '+order.join('/'),()=>uninit===1&&!game.connectPlayers[0].playerid&&game.onlinezhu===null&&waitingUpdates===beforeWaiting+1);
    else check('native offline nickname/AI/broadcast '+order.join('/'),()=>player.nickname==='guest - 离线'&&unwait===1&&broadcasts===beforeBroadcast+1);
    game.players=[];await game.over();
  }
  room();const retained=open();game.players=[{}];api.cancelAll();const before=overResults;game.players=[];await game.over();
  check('actual native game.over reaches result hook and releases detached PC',()=>_status.over&&overResults===before+1&&retained.pc.closed===1&&retained.client.closed&&nnk.state.host.engineOwner===null);
  room();const exited=open();api.cancelAll();_status.reloading=false;lib.config.reconnect_info=['host','guest','room'];lib.config.tmp_user_roomId='before';ui.exit=undefined;
  localStorage.setItem(lib.configprefix+'config',JSON.stringify({reconnect_info:['host','guest','room'],tmp_user_roomId:'before'}));ui.click.exit();for(let i=0;i<10;i++)await Promise.resolve();
  const stored=JSON.parse(localStorage.getItem(lib.configprefix+'config'));
  check('actual Host native exit preserves reconnect and tmp config saving',()=>stored.reconnect_info.length===1&&!('tmp_user_roomId' in stored));
  check('actual Host native exit reaches reload after cleanup',()=>_status.reloading&&_status.waitingToReload&&exited.pc.closed===1&&exited.client.closed&&nnk.state.host.engineOwner===null&&timers.size===0);
  const engineVersion=/version:\s*"([^"]+)"/.exec(fs.readFileSync(process.env.NNK_ENGINE_ROOT+'/game/update.js','utf8'))?.[1];
  const sourceHashes=Object.fromEntries(['extension.js','src/host.js','src/rtc.js','src/guest.js'].map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(root+'/online-kernel/'+file)).digest('hex')]));
  return {ok:checks.every(c=>c.passed),checks,engineVersion,sourceRoot:root,sourceHashes,overEvidence:{before,overResults,retainedClosed:retained.pc.closed,clientClosed:retained.client.closed},note:'Hidden programmatic official ESM lib.init.connection, Client.close, ui.click.exit, game.saveConfig/reload/over. Controlled transport/clock and rendering/remote consumers; game.over uses minimal players and real result hook. No live peers or GUI acceptance.'};
})()

/** Run an untouched official distribution, including its own shell/main/preload.
 * Requires an explicitly marked disposable fixture. No replacement boot or FS.
 * Debugging reads test counters; native dialogs are recorded and denied except
 * the official GPL notice for the isolated test installation.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const officialFiles=['package.json','app/main.js','app/preload.js','index.html','noname/entry.js','noname/init/index.js','noname/init/import.js','noname/init/node.js'];
export function fingerprint(root){return Object.fromEntries(['noname.exe',...officialFiles.map(f=>'resources/app/'+f)].map(f=>[f,digest(path.join(root,f))]))}
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];this.listener=null;
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else{this.events.push(m);this.listener?.(m)}};
    ws.onclose=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Debug target closed'))}this.pending.clear()};
  }
  static async open(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});return new CDP(ws)}
  call(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Debug deadline: '+method))},60000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
  async evaluate(expression,awaitPromise=false){const r=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  close(){this.ws.close()}
}
export class OfficialShell{
  constructor(root,out,label){
    this.root=path.resolve(root);this.out=path.resolve(out);this.label=label;this.id=randomUUID();this.dialogs=[];this.errors=[];
    const marker=JSON.parse(fs.readFileSync(path.join(this.root,'.nnk-full-fixture.json'),'utf8'));
    if(marker.kind!=='noname-kit-full-engine-fixture'||!['1.11.5.2','1.11.6'].includes(marker.version))throw Error('An explicitly prepared official test fixture is required');
    this.version=marker.version;this.before=fingerprint(this.root);fs.mkdirSync(this.out,{recursive:true});
  }
  async start(){
    let inspectorURL;const consoleFile=path.join(this.out,this.label+'-'+this.id+'.console.log');
    const log=bytes=>{fs.appendFileSync(consoleFile,bytes);const s=bytes.toString(),i=s.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/),r=s.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(i)inspectorURL=i[1];if(r)this.rendererPort=Number(r[1])};
    this.child=spawn(path.join(this.root,'noname.exe'),['--inspect-brk=127.0.0.1:0','--remote-debugging-port=0'],{cwd:this.root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.child.stdout.on('data',log);this.child.stderr.on('data',log);this.child.on('error',e=>this.errors.push(e.message));
    for(let i=0;i<100&&!inspectorURL;i++){this.alive();await sleep(100)}if(!inspectorURL)throw Error('Official main inspector did not start');
    this.main=await CDP.open(inspectorURL);await this.main.call('Runtime.enable');await this.main.call('Debugger.enable');
    const source=fs.readFileSync(path.join(this.root,'resources/app/app/main.js'),'utf8'),index=source.indexOf('remote.initialize();');if(index<0)throw Error('Unsupported official shell entry');
    const line=source.slice(0,index).split('\n').length-1,bp=await this.main.call('Debugger.setBreakpointByUrl',{lineNumber:line,urlRegex:'app/main\\.js$'});
    await this.main.call('Runtime.runIfWaitingForDebugger');let reached=false;
    for(let i=0;i<100&&!reached;i++){await sleep(100);for(const event of this.main.events.splice(0)){if(event.method!=='Debugger.paused')continue;if(event.params.callFrames[0].location.lineNumber===line){reached=true;break}await this.main.call('Debugger.resume')}}
    if(!reached)throw Error('The original official main entry was not reached');
    this.shell=await this.main.evaluate("globalThis.__nnkFullElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');({electron:process.versions.electron,node:process.versions.node,type:process.type})");
    // Before the original single-instance check, give this fixture its own lock.
    // Its original main then selects its own Home/UserData as shipped.
    const userData=path.join(this.out,'lock-'+this.id);
    await this.main.evaluate(`process.getBuiltinModule('fs').mkdirSync(${JSON.stringify(userData)},{recursive:true});__nnkFullElectron.app.setPath('userData',${JSON.stringify(userData)});__nnkFullElectron.app.on('browser-window-created',(_event,w)=>{w.hide();w.on('show',()=>w.hide())});true`);
    await this.main.call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await this.main.call('Debugger.resume');await this.main.call('Debugger.disable');this.main.close();this.main=null;
    await this.attachRenderer();return this;
  }
  alive(){if(this.child?.exitCode!==null&&this.child?.exitCode!==undefined)throw Error('Official shell exited: '+this.child.exitCode);if(this.errors.length)throw Error(this.errors.join('; '))}
  async attachRenderer(){
    let target;for(let i=0;i<160&&!target;i++){this.alive();await sleep(100);if(this.rendererPort){const targets=await(await fetch('http://127.0.0.1:'+this.rendererPort+'/json/list')).json();target=targets.find(t=>t.type==='page'&&t.url.includes('/index.html'))}}
    if(!target)throw Error('Original index.html renderer was not found');this.url=target.url;
    this.renderer=await CDP.open(target.webSocketDebuggerUrl);
    this.renderer.listener=event=>{if(event.method==='Page.javascriptDialogOpening'){
      const value={...event.params,accept:event.params.message.includes('基于GPLv3协议')};this.dialogs.push(value);
      this.renderer.call('Page.handleJavaScriptDialog',{accept:value.accept||value.type==='alert'}).catch(e=>this.errors.push('Native dialog handling failed: '+e.message));
    }};
    await this.renderer.call('Page.enable');await this.renderer.call('Runtime.enable');
  }
  async snapshot(){return this.renderer.evaluate(`(async()=>{const {lib,game,ui,_status}=await import('/noname.js');return {
    version:lib.version,url:location.href,node:!!lib.node,dirname:window.__dirname,ready:document.readyState,
    counts:Object.fromEntries(Array.from(document.documentElement.attributes).filter(a=>a.name.startsWith('data-g1-')).map(a=>[a.name,a.value])),
    extensions:lib.config?.extensions,enabled:lib.config&&[lib.config['extension_F3-A_enable'],lib.config['extension_F3-B_enable']],autoImport:lib.config?.extension_auto_import,
    disableFlag:localStorage.getItem(lib.configprefix+'disable_extension'),loaded:_status.extensionLoaded,bootComplete:lib.onload===undefined&&_status.extensionLoading===undefined,
    bootStage:window.__nnk__?.state.bootStage,kernelVersion:window.__nnk__?.version,paused:window.__nnk__?.modules.batch?.paused,legacyPaused:window.__nnk__?.modules.transfer?.paused,
    bridgeConfigured:!!window.__nnk__?.modules.bridge,phase:game.phaseNumber,waiting:!!_status.waitingForPlayer
  }})()`,true)}
  async observe({allowBootFailure=false}={}){
    let value;
    for(let i=0;i<120;i++){this.alive();await sleep(250);value=await this.snapshot();if(value.ready==='complete'&&Array.isArray(value.extensions)&&(value.bootComplete||allowBootFailure&&this.dialogs.some(d=>d.type==='alert'&&d.message.includes('加载内容失败'))))break}
    await sleep(500);value=await this.snapshot();return {label:this.label,ownShell:this.shell,...value,dialogs:this.dialogs.slice(),events:this.renderer.events.filter(e=>['Runtime.exceptionThrown','Runtime.consoleAPICalled'].includes(e.method))};
  }
  async reload(){
    const before=(await this.renderer.call('Page.getFrameTree')).frameTree.frame.loaderId;
    await this.renderer.evaluate("import('/noname.js').then(({game})=>game.reload())",false);
    let changed=false;for(let i=0;i<100;i++){await sleep(100);if((await this.renderer.call('Page.getFrameTree')).frameTree.frame.loaderId!==before){changed=true;break}}
    if(!changed)throw Error('The original game.reload did not navigate a new document');await sleep(500);return this.observe({allowBootFailure:true});
  }
  async configure(values){return this.renderer.evaluate(`(async()=>{const {lib,game}=await import('/noname.js');for(const [key,value]of Object.entries(${JSON.stringify(values)}))await game.promises.saveConfig(key,value);return true})()`,true)}
  async close(){if(this.closed)return;this.closed=true;this.main?.close();this.renderer?.close();if(this.child&&this.child.exitCode===null&&this.child.signalCode===null){const exited=new Promise(resolve=>this.child.once('exit',resolve));this.child.kill();await exited}this.after=fingerprint(this.root);if(JSON.stringify(this.after)!==JSON.stringify(this.before))throw Error('Original shell/entry/preload/boot source changed')}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,out,label='full-boot']=process.argv.slice(2);if(!root||!out)throw Error('Usage: full-boot-probe.mjs marked-official-root private-output-directory [label]');
  const shell=new OfficialShell(root,out,label);try{await shell.start();const result=await shell.observe({allowBootFailure:true});fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({version:result.version,bootComplete:result.bootComplete,counts:result.counts,kernel:result.bootStage}))}finally{await shell.close()}
}

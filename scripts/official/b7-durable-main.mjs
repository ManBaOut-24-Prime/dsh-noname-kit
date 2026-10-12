import testPaths from '../fixtures/test-paths.cjs';
import {app,BrowserWindow} from 'electron';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
const options=JSON.parse(process.env.NNK_GATE_OPTIONS);
testPaths.assertTestPath(options.fixture);testPaths.assertTestPath(options.engineRoot);
app.setPath('userData',testPaths.assertTestPath(options.userData));
app.whenReady().then(async()=>{
  try{
    let nativeServer;
    if(options.nativeHttp){
      const original=readFileSync(testPaths.testPath("official-1.11.5.2/resources/app/app/main.js.bak-nnk-port"),'utf8');
      const cut=original.indexOf('\nremote.initialize();');if(cut<0)throw Error('Official HTTP factory not found');
      const factory=options.fixture+'/native-http-factory.mjs';writeFileSync(factory,original.slice(0,cut)+'\nexport {createApp};\n');
      const {createApp}=await import(pathToFileURL(factory).href);nativeServer=createApp({dirname:options.fixture,server:true,port:0});
      if(!nativeServer.server.listening)await new Promise(r=>nativeServer.server.once('listening',r));
    }
    const httpTrace=[];
    const server=createServer(async(req,res)=>{
      try{
        const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(pathname==='/__probe.html'){
          res.setHeader('Content-Type','text/html');return res.end('<!doctype html><head>'+readFileSync(options.engineRoot+'/index.html','utf8').match(/<script type="importmap">[\s\S]*?<\/script>/)[0]+'</head><body>Durability probe</body>');
        }
        if(nativeServer&&pathname.startsWith('/extension/B7-')){
          const response=await fetch('http://localhost:'+nativeServer.server.address().port+pathname,{headers: req.headers});
          httpTrace.push({pathname,status:response.status,ifNoneMatch:req.headers['if-none-match']||null,etag:response.headers.get('etag')});
          res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(Buffer.from(await response.arrayBuffer()));
        }
        const base=pathname.startsWith('/extension/B7-')?options.fixture:options.engineRoot;
        const file=resolve(base,'.'+pathname);if(!file.startsWith(resolve(base)+'\\'))throw Error('Invalid path');
        res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':'application/octet-stream');res.end(readFileSync(file));
      }catch(e){res.statusCode=404;res.end(e.message)}
    });
    await new Promise((r,j)=>{server.once('error',j);server.listen(options.port||0,'127.0.0.1',r)});
    const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
    await win.loadURL(`http://127.0.0.1:${server.address().port}/__probe.html`);
    const script='window.__gateOptions='+JSON.stringify(options)+';'+readFileSync(new URL('./b7-durable-renderer.js',import.meta.url),'utf8');
    let value=await win.webContents.executeJavaScript(script);
    if(options.nativeReload){
      const loaded=new Promise(r=>win.webContents.once('did-finish-load',r));
      await win.webContents.executeJavaScript('import("/noname.js").then(({game})=>{game.reload();return true})').catch(()=>{});await loaded;
      value={...(await win.webContents.executeJavaScript(script)),beforeNativeReload:value,nativeReload:true};
    }
    writeFileSync(options.result,JSON.stringify({...value,httpTrace,port:server.address().port,runtime:process.versions.electron,pid:process.pid},null,2));
    if(options.phase!=='lock'&&!options.waitForKill)app.exit(value.ok?0:1);
  }catch(e){writeFileSync(options.result,JSON.stringify({ok:false,error:e.stack}));app.exit(1)}
});

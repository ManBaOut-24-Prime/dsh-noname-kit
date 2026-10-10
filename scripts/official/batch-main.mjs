import testPaths from '../fixtures/test-paths.cjs';
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const label=process.argv.at(-1),batch=process.env.NNK_BATCH_PROBE||'b6';
if(!['Old','Latest'].includes(label)||!['b6','b7'].includes(batch))throw new Error('Invalid probe selector');
const root=process.env.NNK_ENGINE_ROOT||testPaths.officialRoot(label);
process.env.NNK_ENGINE_ROOT=root;process.env.NNK_SOURCE_ROOT||=fileURLToPath(new URL('../../',import.meta.url));
const out=`${testPaths.logsDir()}/${batch}-official-${label}.json`;
app.setPath('userData',`${testPaths.tempDir()}/${batch}-electron-${label}`);
app.whenReady().then(async()=>{
  try {
    const server=createServer((req,res)=>{
      try {
        const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(pathname==='/__probe.html') {res.setHeader('Content-Type','text/html');const map=readFileSync(root+'/index.html','utf8').match(/<script type="importmap">[\s\S]*?<\/script>/)[0];return res.end('<!doctype html><html><head>'+map+'</head><body>Programmatic batch probe</body></html>')}
        const fixture=process.env.NNK_GATE_ROOT;
        const isFixture=batch==='b7'&&fixture&&pathname.startsWith('/extension/B7-');
        const base=isFixture?fixture:root;
        const path=resolve(base,'.'+pathname);if(!path.startsWith(resolve(base)+'\\'))throw new Error('Invalid path');
        res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(readFileSync(path));
      }catch(e){res.statusCode=404;res.end(e.message)}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
    await win.loadURL(`http://127.0.0.1:${server.address().port}/__probe.html`);
    let result;
    if(batch==='b7') {
      const renderer=readFileSync(new URL('./b7-renderer.js',import.meta.url),'utf8'),runs=[];
      const reload=async(crash)=>{
        if(crash){const gone=new Promise(r=>win.webContents.once('render-process-gone',(_,details)=>r(details)));win.webContents.forcefullyCrashRenderer();await gone}
        const loaded=new Promise(r=>win.webContents.once('did-finish-load',r));win.webContents.reload();await loaded;
      };
      for(const policy of ['disabled','stock-disabled','disabled-compat','disabled-guarded','late-recovery','global-disable','staging']) {
        for(const [index,launch]of ['cold','reload','crash-restart'].entries()) {
          if(runs.length)await reload(launch==='crash-restart');
          const value=await win.webContents.executeJavaScript('window.__gateOptions='+JSON.stringify({policy,launch,index})+';'+renderer);
          runs.push(value);
        }
      }
      result={ok:runs.every(r=>r.observed),gatePassed:false,runs,note:'Gate investigation: ordinary-disabled positive vs stock/compat/global/precontent negative controls; guarded config candidate requires strict DB whole-process durability and offline recovery proofs. Real official importExtension/game.import plus exact private getExtensionList body; fresh reload and crashed renderer restart. No file transaction or unpause.'};
    } else result=await win.webContents.executeJavaScript(readFileSync(new URL('./'+batch+'-renderer.js',import.meta.url),'utf8'));
    writeFileSync(out,JSON.stringify({label,root,runtime:process.versions.electron,...result},null,2)+'\n');console.log(JSON.stringify(result));app.exit(result.ok?0:1);
  }catch(e){writeFileSync(out,JSON.stringify({label,error:e.stack},null,2));console.error(e);app.exit(1)}
});

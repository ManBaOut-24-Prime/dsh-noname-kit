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
        const path=resolve(root,'.'+pathname);if(!path.startsWith(resolve(root)+'\\'))throw new Error('Invalid path');
        res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(readFileSync(path));
      }catch(e){res.statusCode=404;res.end(e.message)}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
    await win.loadURL(`http://127.0.0.1:${server.address().port}/__probe.html`);
    const result=await win.webContents.executeJavaScript(readFileSync(new URL('./'+batch+'-renderer.js',import.meta.url),'utf8'));
    writeFileSync(out,JSON.stringify({label,root,runtime:process.versions.electron,...result},null,2)+'\n');console.log(JSON.stringify(result));app.exit(result.ok?0:1);
  }catch(e){writeFileSync(out,JSON.stringify({label,error:e.stack},null,2));console.error(e);app.exit(1)}
});

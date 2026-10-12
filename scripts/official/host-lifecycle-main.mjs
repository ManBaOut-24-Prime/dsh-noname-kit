import testPaths from '../fixtures/test-paths.cjs';
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import {fileURLToPath} from 'node:url';
const label = process.argv.at(-1);
if (!['Old','Latest'].includes(label)) throw new Error('Expected Old or Latest argument');
const root = process.env.NNK_ENGINE_ROOT ? testPaths.requiredTestPath('NNK_ENGINE_ROOT') : testPaths.officialRoot(label);
process.env.NNK_ENGINE_ROOT=root;
process.env.NNK_SOURCE_ROOT ||= fileURLToPath(new URL('../../',import.meta.url));
const variant=process.env.NNK_PROBE_VARIANT || "fixed";
const out = `${testPaths.logsDir()}/b5-host-official-${label}-${variant}.json`;
app.setPath('userData', `${testPaths.tempDir()}/b5-host-electron-${label}`);
let server;
app.whenReady().then(async () => {
try {
  server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/__probe.html') { res.setHeader('Content-Type', 'text/html'); const map = readFileSync(root+'/index.html','utf8').match(/<script type="importmap">[\s\S]*?<\/script>/)[0]; return res.end('<!doctype html><html><head>'+map+'</head><body>Isolated programmatic engine probe</body></html>'); }
      const path = resolve(root, '.' + pathname);
      if (!path.startsWith(resolve(root) + '\\')) throw new Error('invalid path');
      res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream');
      res.end(readFileSync(path));
    } catch (e) { res.statusCode = 404; res.end(e.message); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/__probe.html`);
  const renderer = readFileSync(new URL('./host-lifecycle-renderer.js',import.meta.url), 'utf8');
  const result = await win.webContents.executeJavaScript(renderer);
  writeFileSync(out, JSON.stringify({ label, root, runtime: process.versions.electron, ...result }, null, 2) + '\n');
  console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
} catch (e) {
  writeFileSync(out, JSON.stringify({ label, error: e.stack }, null, 2)); console.error(e); app.exit(1);
}
});

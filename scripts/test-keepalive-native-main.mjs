// Regression for Electron's destroyed BrowserWindow.webContents getter.
// Synthetic native getter behavior; real native retirement is tested separately.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../online-kernel/lib/keepalive-main.cjs',import.meta.url),'utf8');
const start=source.indexOf('  function track('),end=source.indexOf('\n  function ordinaryFor',start);
assert.ok(start>=0&&end>start);
const track=runInNewContext(source.slice(start,end)+'\ntrack;',{Date});
let passed=0;
for(const order of [['destroyed','closed'],['closed','destroyed']]){
 const win=new EventEmitter(),wc=new EventEmitter(),record={closed:false,destroyed:false},owned=[];let dead=false,getters=0,changed=0,otherCalls=0;
 Object.defineProperty(win,'webContents',{get(){getters++;if(dead)throw TypeError('Object has been destroyed');return wc;}});
 const own=()=>{},other=()=>otherCalls++;wc.on('native-owned',own);wc.on('native-owned',other);owned.push(['native-owned',own]);
 const dispose=track(win,record,owned,()=>changed++);
 for(const event of order){if(event==='destroyed'){dead=true;assert.doesNotThrow(()=>wc.emit(event));}else assert.doesNotThrow(()=>win.emit(event));}
 assert.equal(record.closed,true);assert.equal(record.destroyed,true);assert.equal(owned.length,0);assert.equal(changed,2);assert.equal(getters,1);
 assert.doesNotThrow(dispose);assert.equal(getters,1);wc.emit('native-owned');assert.equal(otherCalls,1);assert.equal(wc.listenerCount('native-owned'),1);
 assert.equal(win.listenerCount('closed'),0);assert.equal(wc.listenerCount('destroyed'),0);passed++;console.log('  ✓ destroyed getter is never re-read; own listeners only; order '+order.join(' → '));
}
console.log(`\n全部通过: ${passed} 项（模拟原生 getter；不代替真实窗口回收）`);

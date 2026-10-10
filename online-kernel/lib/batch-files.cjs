'use strict';
// B7 file transactions. No transport, GUI, engine patch or implicit authorization.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync,spawn}=require('node:child_process');
const BASE='nnk-batches',SLOT=8192,MAX=300*1048576,MAX_LOCAL_FILES=32768;
// Recovery remains usable while the installed kernel directory is withdrawn.
const ACL_SCRIPT=fs.readFileSync(path.join(__dirname,'batch-acl.ps1'),'utf8'),LOCK_SCRIPT=fs.readFileSync(path.join(__dirname,'batch-lock.ps1'),'utf8');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const id=()=>crypto.randomBytes(16).toString('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
function fail(s){throw Error(s)}
function part(s){return typeof s==='string'&&s.length>0&&s.length<=120&&s===s.normalize('NFC')&&!/[\x00-\x1f\x7f<>:"/\\|?*]/.test(s)&&!/[. ]$/.test(s)&&s!=='.'&&s!=='..'&&!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s)}
function relative(s){return typeof s==='string'&&s.length<=240&&s.split('/').every(part)}
function normalize(batch){
  if(!batch||!Array.isArray(batch.extensions)||!batch.extensions.length||batch.extensions.length>64)fail('Invalid full batch');
  let total=0,count=0;const names=new Set();
  const extensions=batch.extensions.map(e=>{
    if(!e||!part(e.name)||['联机助手','boss','coin','cardpile'].includes(e.name.toLowerCase())||names.has(e.name.toLowerCase())||!Array.isArray(e.files)||!e.files.length)fail('Unsupported extension name');names.add(e.name.toLowerCase());
    const seen=new Set(),files=e.files.map(f=>{
      if(!f||!relative(f.path)||seen.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.sha256))fail('Invalid file manifest');seen.add(f.path.toLowerCase());total+=f.size;count++;
      if(total>MAX||count>4096)fail('Batch exceeds limit');return {path:f.path,size:f.size,sha256:f.sha256};
    }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    for(const f of files){const pieces=f.path.toLowerCase().split('/');pieces.pop();while(pieces.length){if(seen.has(pieces.join('/')))fail('File/directory conflict');pieces.pop()}}
    if(!seen.has('extension.js'))fail('Missing extension entry');return {name:e.name,files};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return {extensions,total,count};
}
function identity(file){if(!fs.existsSync(file))return null;const s=fs.lstatSync(file,{bigint:true});if(s.isSymbolicLink()||!s.isDirectory())fail('Unsafe directory');return String(s.ino)}
function rootOf(root){
  if(process.platform!=='win32')fail('Batch publication requires verified Windows filesystem isolation');
  const resolved=path.resolve(root),real=fs.realpathSync.native(resolved);
  if(resolved.toLowerCase()!==real.toLowerCase()||resolved===path.parse(resolved).root)fail('Unsafe game root');
  let walk=resolved;while(walk!==path.dirname(walk)){if(fs.lstatSync(walk).isSymbolicLink())fail('Linked ancestor');walk=path.dirname(walk)}
  if(fs.existsSync(path.join(resolved,'extension')))identity(path.join(resolved,'extension'));
  else if(!fs.existsSync(path.join(resolved,BASE,'active')))fail('Missing extension root without a recovery record');return resolved;
}
function durable(file,bytes,flags='wx'){const fd=fs.openSync(file,flags);try{let n=0;while(n<bytes.length)n+=fs.writeSync(fd,bytes,n,bytes.length-n);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function helperEnvironment(extra={}){const env={SystemRoot:process.env.SystemRoot,...extra};for(const key of ['TEMP','TMP','PATH','WINDIR','USERPROFILE'])if(process.env[key])env[key]=process.env[key];return env}
// Chromium renderer contexts may lack SharedArrayBuffer or forbid Atomics.wait.
// Keep synchronous publication/cancellation checks, using the existing platform
// runtime for its short readiness waits rather than changing engine/browser flags.
function pause(ms){
  if(process.type!=='renderer'&&typeof SharedArrayBuffer!=='undefined'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);return}
  const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','[Threading.Thread]::Sleep('+ms+')'],{env:helperEnvironment(),stdio:'ignore',windowsHide:true,timeout:5000});
  if(r.error||r.status!==0)fail('Native lease readiness wait failed');
}
function lease(root,ordinary=false){
  const base=path.join(root,BASE);if(!fs.existsSync(base))fs.mkdirSync(base);identity(base);
  const folder=path.join(base,'leases');if(!fs.existsSync(folder))fs.mkdirSync(folder);identity(folder);
  const token=id(),request=path.join(folder,token+'.json'),ready=path.join(folder,token+'.ready'),control=path.join(folder,token+'.control'),done=path.join(folder,token+'.done'),lock=path.join(base,'lease.lock');
  if(fs.existsSync(lock)&&(!fs.lstatSync(lock).isFile()||fs.lstatSync(lock).isSymbolicLink()))fail('Unsafe lease file');
  durable(control,Buffer.alloc(1));durable(request,Buffer.from(JSON.stringify({root,lock,ready,control,done,active:path.join(base,'active'),pid:process.pid,ordinary})));
  const script=LOCK_SCRIPT;
  const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','& { '+script+' } $env:NNK_BATCH_LOCK_REQUEST'],{env:helperEnvironment({NNK_BATCH_LOCK_REQUEST:request}),stdio:'ignore',windowsHide:true});child.unref();
  const deadline=Date.now()+6000;
  while(!fs.existsSync(ready)&&Date.now()<deadline)pause(25);
  if(!fs.existsSync(ready)){child.kill();fail('Filesystem lease did not start')}
  let response;try{response=readJSON(ready,4096)}catch(error){child.kill();throw error}if(response.ok!==true){child.kill();fail(response.error||'Filesystem lease rejected')}
  if(response.unsupported)return {release:()=>{},check:()=>{},pid:null};
  return {release:()=>{
    const fd=fs.openSync(control,'r+');try{fs.writeSync(fd,Buffer.from([1]),0,1,0)}finally{fs.closeSync(fd)}
    const until=Date.now()+3000;while(!fs.existsSync(done)&&Date.now()<until)pause(10);
    child.kill();while(alive(child.pid)&&Date.now()<until)pause(10);
    if(!fs.existsSync(done)||alive(child.pid))fail('Filesystem lease helper did not stop');
  },check:()=>{if(!alive(child.pid))fail('Filesystem lease ended')},pid:child.pid,born:response.started,ownerId:response.ownerId,ownerAlive:response.ownerAlive};
}
function hashFile(file){const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));return h.digest('hex')}finally{fs.closeSync(fd)}}
function tree(dir){
  const out=[],seen=new Set();let count=0,total=0;
  function walk(full,rel){const s=fs.lstatSync(full);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())fail('Links and special files are forbidden');
    if(s.isFile()&&s.nlink!==1)fail('Existing hardlinks are not safe transaction inputs');
    if(rel){if(!relative(rel)||seen.has(rel.toLowerCase()))fail('Unsafe local filename');seen.add(rel.toLowerCase())}
    const row={relative:rel,isDirectory:s.isDirectory(),ino:String(fs.lstatSync(full,{bigint:true}).ino)};
    if(s.isFile()){row.size=s.size;row.sha256=hashFile(full);row.mtimeMs=s.mtimeMs;row.atimeMs=s.atimeMs;if(++count>MAX_LOCAL_FILES||!Number.isSafeInteger(total+=s.size))fail('Local tree exceeds transaction limit')}
    out.push(row);if(s.isDirectory())for(const name of fs.readdirSync(full).sort())walk(path.join(full,name),rel?rel+'/'+name:name);
  }walk(dir,'');return out;
}
function structure(dir){const out=[];function walk(full,rel){const s=fs.lstatSync(full,{bigint:true});if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())fail('Unsafe frozen tree');out.push({relative:rel,isDirectory:s.isDirectory(),ino:String(s.ino)});if(s.isDirectory())for(const name of fs.readdirSync(full).sort())walk(path.join(full,name),rel?rel+'/'+name:name)}walk(dir,'');return out}
function rowsAt(dir,rows){return rows.map(e=>({...e,path:path.join(dir,...e.relative.split('/').filter(Boolean)),isRoot:e.relative===''}))}
function acl(root,request,mode,rows,options={}){
  durable(request,Buffer.from(JSON.stringify({mode,root,entries:rows,failAfter:options.failAfter||0})),'w');
  const env=helperEnvironment({NNK_BATCH_ACL_REQUEST:request});env.TEMP=env.TMP=path.dirname(request);
  const script=ACL_SCRIPT;
  const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& { '+script+' } $env:NNK_BATCH_ACL_REQUEST'],{env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:32*1048576});
  if(r.status!==0||r.error)fail('Filesystem isolation failed (exit '+r.status+', signal '+(r.signal||'none')+'): '+(r.error?.message||r.stderr.trim()));
  return mode==='capture'?JSON.parse(r.stdout.trim()):null;
}
function capture(root,dir,rows,request){const entries=acl(root,request,'capture',rowsAt(dir,rows));return rows.map((row,i)=>({...row,sddl:entries[i].sddl}))}
function stateRead(folder){
  const bytes=fs.readFileSync(path.join(folder,'state.bin'));const valid=[];
  for(let i=0;i<2;i++){const slot=bytes.subarray(i*SLOT,(i+1)*SLOT);if(slot.length!==SLOT)continue;const signature=slot.subarray(0,64).toString();if(signature!==slot.subarray(SLOT-64).toString())continue;
    const body=slot.subarray(65,SLOT-64);const end=body.indexOf(0),data=body.subarray(0,end<0?body.length:end);if(sha(data)!==signature)continue;
    try{const value=JSON.parse(data);if(value.v===1&&Number.isSafeInteger(value.seq)&&value.seq>0&&['receiving','prepared','armed','frozen','withdrawn','committed','complete','rolled_back'].includes(value.phase)&&(value.descriptorHash===null||/^[a-f0-9]{64}$/.test(value.descriptorHash)))valid.push(value)}catch{}}
  if(!valid.length)fail('Both durable state slots are invalid');return valid.sort((a,b)=>b.seq-a.seq)[0];
}
function stateWrite(folder,previous,phase,descriptorHash,hook){
  const state={v:1,seq:(previous?.seq||0)+1,phase,descriptorHash:descriptorHash||null},body=Buffer.from(JSON.stringify(state)),signature=sha(body),slot=Buffer.alloc(SLOT);
  if(body.length>SLOT-130)fail('State overflow');slot.write(signature);slot[64]=10;body.copy(slot,65);slot.write(signature,SLOT-64);
  const fd=fs.openSync(path.join(folder,'state.bin'),'r+');try{let written=0;while(written<SLOT)written+=fs.writeSync(fd,slot,written,SLOT-written,(state.seq%2)*SLOT+written);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  hook?.('state:'+phase);return state;
}
function readJSON(file,limit=32*1048576){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)fail('Unsafe journal');return JSON.parse(fs.readFileSync(file,'utf8'))}
function alive(pid){try{process.kill(pid,0);return true}catch(e){if(e.code==='EPERM')return true;if(e.code==='ESRCH')return false;throw e}}
function active(root){
  const base=path.join(root,BASE),file=path.join(base,'active');if(!fs.existsSync(file))return null;
  const owner=readJSON(file,4096);if(owner.v!==1||!/^[a-f0-9]{32}$/.test(owner.id)||!Number.isSafeInteger(owner.pid)||owner.pid<=0||owner.born!==undefined&&!/^\d{1,20}$/.test(owner.born))fail('Invalid transaction owner');
  const folder=path.join(base,owner.id);identity(base);identity(folder);const state=stateRead(folder);
  return {owner,folder,state};
}
function descriptorAt(a){
  const file=path.join(a.folder,'descriptor.json'),raw=fs.readFileSync(file);if(raw.length>32*1048576||sha(raw)!==a.state.descriptorHash)fail('Descriptor integrity failed');const d=JSON.parse(raw);
  if(d.v!==1||d.id!==a.owner.id||!/^\d+$/.test(d.extensionRootId)||!Array.isArray(d.entries)||!d.entries.length||d.entries.length>64)fail('Invalid descriptor');
  const batch=normalize(d.batch);if(JSON.stringify(batch)!==JSON.stringify(d.batch)||sha(Buffer.from(JSON.stringify(batch)))!==d.binding?.digest||!['session','peerSession','proposal'].every(k=>/^[a-f0-9]{32}$/.test(d.binding[k])))fail('Invalid recovery binding');
  if(d.entries.map(e=>e.name).join('\0')!==batch.extensions.map(e=>e.name).join('\0'))fail('Recovery batch changed');
  const names=new Set();for(const e of d.entries){if(!part(e.name)||['联机助手','boss','coin','cardpile'].includes(e.name.toLowerCase())||names.has(e.name.toLowerCase()))fail('Unsafe recovery extension');names.add(e.name.toLowerCase());
    for(const key of ['oldRows','nextRows']){if(!Array.isArray(e[key])||e[key].length>MAX_LOCAL_FILES*2)fail('Invalid recovery inventory');const seen=new Set();for(const row of e[key]){
      if(row.relative!==''&&!relative(row.relative)||typeof row.sddl!=='string'||row.sddl.length>65536||typeof row.isDirectory!=='boolean'||!/^\d+$/.test(row.ino)||seen.has(row.relative.toLowerCase()))fail('Invalid permission record');seen.add(row.relative.toLowerCase());
      if(!row.isDirectory&&(!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256)))fail('Invalid recovery file');
    }if(e[key].length&&(e[key][0].relative!==''||!e[key][0].isDirectory))fail('Missing inventory root')}
    if(!/^\d+$/.test(e.nextId)||e.oldId!==null&&!/^\d+$/.test(e.oldId))fail('Invalid directory identity');
  }return d;
}
function publicationRoot(root,folder,expected){
  const formal=path.join(root,'extension'),workspace=path.join(folder,'workspace'),f=identity(formal),w=identity(workspace);
  if(f!==null&&w!==null||f===null&&w===null||(w??f)!==expected)fail('Extension namespace identity changed; refuse to overwrite');return w!==null?workspace:formal;
}
function positions(root,folder,e,base=path.join(root,'extension')){return {target:path.join(base,e.name),old:path.join(folder,'old',e.name),next:path.join(folder,'next',e.name),discard:path.join(folder,'discard',e.name)}}
function releasePermissions(root,folder,e,generation,hook,base){
  const rows=generation==='old'?e.oldRows:e.nextRows;if(!rows.length)return;
  // Restore entry last: other files/permissions are ready before this extension can import.
  const sorted=rows.slice().sort((a,b)=>(a.relative.toLowerCase()==='extension.js')-(b.relative.toLowerCase()==='extension.js'));
  acl(root,path.join(folder,'restore-'+generation+'-'+e.name+'.json'),'restore',rowsAt(path.join(base,e.name),sorted));hook?.('permissions:'+generation+':'+e.name);
}
function detachActive(root,a){const now=active(root);if(!now||now.owner.id!==a.owner.id)fail('Transaction ownership changed');fs.unlinkSync(path.join(root,BASE,'active'))}
function recover(root,options={}){
  root=rootOf(root);if(options.owned)return recoverLocked(root,options);
  if(!active(root))return {status:'none'};
  const lock=lease(root);try{lock.check();return recoverLocked(root,{...options,lock})}catch(error){
    // Failed recovery remains retryable in the same DSH process. The original
    // immutable owner record is retained; only the active hardlink is replaced.
    const a=active(root);if(a&&a.owner.pid===process.pid){const temp=path.join(a.folder,'retry-owner-'+id()+'.json');fs.linkSync(path.join(a.folder,'owner.json'),temp);fs.renameSync(temp,path.join(root,BASE,'active'))}throw error;
  }finally{lock.release()}
}
function recoverLocked(root,options){
  const a=active(root);if(!a)return {status:'none'};
  if(options.expectedId&&a.owner.id!==options.expectedId)fail('Transaction ownership changed');
  if(options.owned){if(a.owner.pid!==process.pid||a.owner.born!==options.lock?.born)fail('Transaction process identity changed')}
  else {
    if(a.owner.id!==options.lock.ownerId)fail('Transaction ownership changed');
    if(options.lock.ownerAlive)return {status:'busy',id:a.owner.id};
  }
  if(!options.owned){
    // Claim recovery while holding the native lease. A live recovery process is
    // still protected if its lease helper unexpectedly terminates.
    const temp=path.join(a.folder,'recovery-owner-'+id()+'.json');durable(temp,Buffer.from(JSON.stringify({...a.owner,pid:process.pid,born:options.lock.born})));fs.renameSync(temp,path.join(root,BASE,'active'));a.owner.pid=process.pid;a.owner.born=options.lock.born;
  }
  options.lock?.check();
  if(['receiving','prepared'].includes(a.state.phase)){a.state=stateWrite(a.folder,a.state,'rolled_back',a.state.descriptorHash,options.hook);detachActive(root,a);return {status:'rolled_back',id:a.owner.id}}
  if(a.state.phase==='rolled_back'&&!a.state.descriptorHash){detachActive(root,a);return {status:'rolled_back',id:a.owner.id}}
  const d=descriptorAt(a),committed=['committed','complete'].includes(a.state.phase),base=publicationRoot(root,a.folder,d.extensionRootId),formal=path.join(root,'extension');
  if(committed){
    for(const e of d.entries){const p=positions(root,a.folder,e,base);if(identity(p.target)!==e.nextId)fail('Committed directory identity changed; manual recovery needed')}
    // A formal committed root was published only after all permission operations
    // succeeded. A withdrawn root must finish the entire batch before exposure.
    if(base!==formal)for(const e of d.entries)releasePermissions(root,a.folder,e,'new',options.hook,base);
    // Backups remain whole and regain their original permissions outside formal extension/.
    for(const e of d.entries)if(e.oldId&&identity(positions(root,a.folder,e).old)===e.oldId)acl(root,path.join(a.folder,'backup-'+e.name+'.json'),'restore',rowsAt(positions(root,a.folder,e).old,e.oldRows));
    if(base!==formal){fs.renameSync(base,formal);options.hook?.('publish:new')}
    a.state=stateWrite(a.folder,a.state,'complete',a.state.descriptorHash,options.hook);detachActive(root,a);return {status:'committed',id:a.owner.id,binding:d.binding,batch:d.batch};
  }
  // Remove every new generation first. Only known inode identities may be moved.
  for(const e of d.entries){const p=positions(root,a.folder,e,base),current=identity(p.target);
    if(current===e.nextId){if(identity(p.discard))fail('Recovery discard occupied');fs.renameSync(p.target,p.discard);options.hook?.('discard:'+e.name)}
    else if(current!==null&&current!==e.oldId)fail('Unrecognized formal directory; refuse to overwrite');
  }
  for(const e of d.entries){const p=positions(root,a.folder,e,base);if(e.oldId&&identity(p.target)===null){if(identity(p.old)!==e.oldId)fail('Whole old backup is missing');fs.renameSync(p.old,p.target);options.hook?.('restore-old:'+e.name)}
    if(identity(p.target)!==e.oldId)fail('Old generation is not whole');
  }
  // All old versions are together before any code is made readable. Frozen proof
  // and preserved inode identities, not kernel load order, establish provenance.
  a.state=stateWrite(a.folder,a.state,'rolled_back',a.state.descriptorHash,options.hook);
  for(const e of d.entries)releasePermissions(root,a.folder,e,'old',options.hook,base);
  if(base!==formal){fs.renameSync(base,formal);options.hook?.('publish:old')}
  detachActive(root,a);return {status:'rolled_back',id:a.owner.id};
}
class Transaction{
  constructor(root,batch,binding,options={}){
    this.root=rootOf(root);this.batch=normalize(batch);this.binding=copy(binding);this.hook=options.hook;this.options=options;this.files=[];this.closed=false;
    if(!binding||!['session','peerSession','proposal'].every(k=>/^[a-f0-9]{32}$/.test(binding[k]))||binding.digest!==sha(Buffer.from(JSON.stringify(this.batch))))fail('Authorization binding mismatch');
    this.lock=lease(this.root);try{
    const base=path.join(this.root,BASE);identity(base);
    if(active(this.root))fail('Another transaction or recovery is pending');
    this.id=id();this.folder=path.join(base,this.id);fs.mkdirSync(this.folder);for(const name of ['received','next','old','discard'])fs.mkdirSync(path.join(this.folder,name));
    durable(path.join(this.folder,'state.bin'),Buffer.alloc(SLOT*2));this.state=stateWrite(this.folder,null,'receiving',null,this.hook);
    durable(path.join(this.folder,'owner.json'),Buffer.from(JSON.stringify({v:1,id:this.id,pid:process.pid,born:this.lock.born})));
    fs.linkSync(path.join(this.folder,'owner.json'),path.join(base,'active'));
    for(const ext of this.batch.extensions)for(const file of ext.files)this.files.push({name:ext.name,...file});
    this.received=new Set();this.streams=new Map();this.descriptor=null;
    }catch(error){this.lock.release();throw error}
  }
  current(){this.lock.check();const a=active(this.root);if(!a||a.owner.id!==this.id||a.owner.pid!==process.pid||a.owner.born!==this.lock.born)fail('Transaction ownership changed')}
  putFile(index,bytes){
    this.current();
    if(this.closed||this.state.phase!=='receiving'||!Number.isInteger(index)||!this.files[index])fail('Attempt is not receiving');
    if(this.streams.has(index))fail('Cannot mix whole-file and streaming writes');
    const f=this.files[index];if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);if(bytes.length!==f.size||sha(bytes)!==f.sha256)fail('File SHA-256/size mismatch');
    const dest=path.join(this.folder,'received',f.name,...f.path.split('/'));if(this.received.has(index)){if(hashFile(dest)!==f.sha256)fail('Duplicate content changed');return}
    fs.mkdirSync(path.dirname(dest),{recursive:true});durable(dest,bytes);this.received.add(index);this.hook?.('received:'+index);
  }
  /** B8 chunks name only a manifest index. No incoming path is used for I/O. */
  putChunk(index,offset,bytes,end){
    this.current();if(this.closed||this.state.phase!=='receiving'||!Number.isInteger(index)||!this.files[index]||!Number.isSafeInteger(offset)||offset<0||typeof end!=='boolean'||!Buffer.isBuffer(bytes)||bytes.length>32768)fail('Invalid bounded chunk');
    const f=this.files[index],dest=path.join(this.folder,'received',f.name,...f.path.split('/'));
    if(offset+bytes.length>f.size||end&&offset+bytes.length!==f.size||!end&&(bytes.length===0||offset+bytes.length===f.size))fail('Chunk outside file');
    let stream=this.streams.get(index);
    if(this.received.has(index)||stream&&offset<stream.offset){
      if(!this.received.has(index)&&offset+bytes.length>stream.offset)fail('Overlapping chunk');
      const fd=this.received.has(index)?fs.openSync(dest,'r'):stream.fd,previous=Buffer.alloc(bytes.length);
      try{if(fs.readSync(fd,previous,0,bytes.length,offset)!==bytes.length||!previous.equals(bytes))fail('Conflicting duplicate chunk')}finally{if(this.received.has(index))fs.closeSync(fd)}
      return {offset:this.received.has(index)?f.size:stream.offset,complete:this.received.has(index)};
    }
    if(!stream){if(offset!==0||this.streams.size>=16)fail('Chunk starts out of order');fs.mkdirSync(path.dirname(dest),{recursive:true});stream={fd:fs.openSync(dest,'wx+'),offset:0};this.streams.set(index,stream)}
    if(offset!==stream.offset)fail('Chunk offset out of order');
    let written=0;while(written<bytes.length)written+=fs.writeSync(stream.fd,bytes,written,bytes.length-written,offset+written);stream.offset+=bytes.length;
    if(end){fs.fsyncSync(stream.fd);fs.closeSync(stream.fd);this.streams.delete(index);if(hashFile(dest)!==f.sha256)fail('File SHA-256 mismatch');this.received.add(index);this.hook?.('received:'+index)}
    return {offset:stream.offset,complete:this.received.has(index)};
  }
  prepare(){
    this.current();if(this.closed||this.state.phase!=='receiving'||this.received.size!==this.files.length)fail('Full authorized batch has not arrived');
    const existing=new Map(fs.readdirSync(path.join(this.root,'extension')).map(n=>[n.toLowerCase(),n])),entries=[];
    for(const ext of this.batch.extensions){
      if(existing.has(ext.name.toLowerCase())&&existing.get(ext.name.toLowerCase())!==ext.name)fail('Local extension case alias');
      const target=path.join(this.root,'extension',ext.name),next=path.join(this.folder,'next',ext.name),oldId=identity(target),oldRows=oldId?tree(target):[];
      const oldACL=oldId?capture(this.root,target,oldRows,path.join(this.folder,'capture-old-'+ext.name+'.json')):[];
      fs.mkdirSync(next);for(const row of oldRows){if(!row.relative)continue;const dest=path.join(next,...row.relative.split('/'));
        if(row.isDirectory)fs.mkdirSync(dest);else{fs.copyFileSync(path.join(target,...row.relative.split('/')),dest);fs.utimesSync(dest,row.atimeMs/1000,row.mtimeMs/1000);const fd=fs.openSync(dest,'r+');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}}
      const oldPaths=new Map(oldRows.map(r=>[r.relative.toLowerCase(),r]));
      for(const f of ext.files){const old=oldPaths.get(f.path.toLowerCase());if(old?.isDirectory)fail('Incoming file would replace a local directory');
        const dest=path.join(next,...f.path.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(this.folder,'received',ext.name,...f.path.split('/')),dest);
        const stamp=Math.max(Date.now(),(old?.mtimeMs||0)+2000)/1000;fs.utimesSync(dest,stamp,stamp);const fd=fs.openSync(dest,'r+');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
        if(hashFile(dest)!==f.sha256||fs.statSync(dest).size!==f.size)fail('Staged content changed');
      }
      const nextRows=tree(next),nextACL=capture(this.root,next,nextRows,path.join(this.folder,'capture-new-'+ext.name+'.json'));
      const permissions=new Map(oldACL.map(r=>[r.relative.toLowerCase(),r.sddl]));for(const row of nextACL)if(permissions.has(row.relative.toLowerCase()))row.sddl=permissions.get(row.relative.toLowerCase());
      // Preserve original local ownership, group, protected DACLs and extra files.
      acl(this.root,path.join(this.folder,'metadata-new-'+ext.name+'.json'),'restore',rowsAt(next,nextACL));
      const actualNext=capture(this.root,next,nextRows,path.join(this.folder,'capture-stage-'+ext.name+'.json'));
      entries.push({name:ext.name,oldId,nextId:identity(next),oldRows:oldACL,nextRows:nextACL,freezeNext:actualNext});
    }
    const d={v:1,id:this.id,extensionRootId:identity(path.join(this.root,'extension')),binding:this.binding,batch:this.batch,entries},bytes=Buffer.from(JSON.stringify(d));if(bytes.length>32*1048576)fail('Transaction descriptor too large');
    durable(path.join(this.folder,'descriptor.json'),bytes);this.descriptor=d;this.hash=sha(bytes);this.state=stateWrite(this.folder,this.state,'prepared',this.hash,this.hook);return copy(this.batch);
  }
  commit(stillAuthorized){
    this.current();
    if(this.closed||this.state.phase!=='prepared'||typeof stillAuthorized!=='function'||!stillAuthorized())fail('Authorization is no longer current');
    let published=null;
    try{
      const d=this.descriptor,freeze=[];
      for(const e of d.entries){const p=positions(this.root,this.folder,e);if(identity(p.target)!==e.oldId||identity(p.next)!==e.nextId)fail('Directory changed before commit')}
      this.state=stateWrite(this.folder,this.state,'armed',this.hash,this.hook);
      if(!stillAuthorized())fail('Authorization ended before withdrawing the namespace');
      // Withdraw first: even a crash partway through freezing/restoring ACLs has
      // no extension entry path. No engine/config/module order is involved.
      const workspace=path.join(this.folder,'workspace');fs.renameSync(path.join(this.root,'extension'),workspace);this.hook?.('withdraw');
      this.state=stateWrite(this.folder,this.state,'withdrawn',this.hash,this.hook);
      for(const e of d.entries){const p=positions(this.root,this.folder,e,workspace);if(e.oldId)freeze.push(...rowsAt(p.target,e.oldRows));freeze.push(...rowsAt(p.next,e.freezeNext))}
      acl(this.root,path.join(this.folder,'freeze.json'),'freeze',freeze,{failAfter:this.options.aclFailAfter});this.hook?.('freeze');
      for(const e of d.entries){const p=positions(this.root,this.folder,e,workspace);for(const [dir,rows]of [[p.target,e.oldRows],[p.next,e.freezeNext]])if(rows.length){
        const expected=rows.map(({relative,isDirectory,ino})=>({relative,isDirectory,ino}));if(JSON.stringify(structure(dir))!==JSON.stringify(expected))fail('Frozen namespace changed');
      }}
      this.state=stateWrite(this.folder,this.state,'frozen',this.hash,this.hook);
      for(const e of d.entries){this.current();if(!stillAuthorized())fail('Authorization ended before publication');const p=positions(this.root,this.folder,e,workspace);
        if(e.oldId){fs.renameSync(p.target,p.old);this.hook?.('old:'+e.name)}fs.renameSync(p.next,p.target);this.hook?.('new:'+e.name);
      }
      if(!stillAuthorized())fail('Authorization ended before commit');
      this.state=stateWrite(this.folder,this.state,'committed',this.hash,this.hook);
      const result=recover(this.root,{owned:true,expectedId:this.id,lock:this.lock,hook:this.hook});published=result;this.closed=true;this.lock.release();return result;
    }catch(error){
      // Publication is already durable and visible. A helper cleanup error must
      // not relabel it rolled back, clear a later owner's record or allow reuse
      // of old in-memory extensions. Retain the commit truth and report cleanup.
      if(published?.status==='committed')return {...published,warning:'整批文件已提交，租约收尾需确认：'+error.message};
      try{const result=recover(this.root,{owned:true,expectedId:this.id,lock:this.lock});this.closed=true;error.outcome=result;this.lock.release();if(result.status==='committed')return result}
      catch(recoveryError){error.outcome={status:'recovery_required',id:this.id,error:recoveryError.message}}
      throw error;
    }
  }
  abort(){if(this.closed)return {status:'closed'};this.current();for(const stream of this.streams.values())fs.closeSync(stream.fd);this.streams.clear();try{const result=recover(this.root,{owned:true,expectedId:this.id,lock:this.lock});this.closed=true;return result}finally{this.lock.release()}}
}
function inspect(root){root=rootOf(root);const a=active(root);if(!a)return {status:'none'};return {status:['complete','rolled_back'].includes(a.state.phase)?a.state.phase:'pending',id:a.owner.id,phase:a.state.phase,ownerAlive:alive(a.owner.pid),binding:a.state.descriptorHash?descriptorAt(a).binding:null}}
module.exports={Transaction,recover,inspect,normalize,manifestDigest:batch=>sha(Buffer.from(JSON.stringify(normalize(batch)))),acquireWriteLease:root=>lease(fs.realpathSync.native(root),true),_test:{tree,stateRead,acl,capture,rowsAt}};

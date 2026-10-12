'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cache=new Map(),MAX=300*1048576,FILES=4096;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function stamp(s){return [s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':')}
/** Bounded content observations on join/recheck, never on bridge heartbeat.
 * Cache requires the entire path/type/stat inventory to remain unchanged.
 * A later transfer always recollects and verifies its own authorized manifest.
 */
function scan(root,names,{force=false}={}){
  const result={};let budget=0,count=0;
  if(names.length>64)throw Error('体检扩展数量超过 64');
  for(const name of names){
    try{
      if(typeof name!=='string'||!name||/[\x00-\x1f<>:"/\\|?*]/.test(name)||/[. ]$/.test(name)||name==='.'||name==='..')throw Error('扩展名称无效');
      const base=path.join(root,'extension',name),rows=[],directories=[];
      function walk(dir,rel){const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('拒绝链接目录');directories.push([rel,stamp(st)]);
        for(const entry of fs.readdirSync(dir).sort()){
          const file=path.join(dir,entry),relative=rel?rel+'/'+entry:entry,s=fs.lstatSync(file);
          if(s.isSymbolicLink())throw Error('拒绝链接文件');
          if(s.isDirectory())walk(file,relative);
          else if(s.isFile()&&s.nlink===1){budget+=s.size;count++;if(budget>MAX||count>FILES)throw Error('体检文件超过大小或数量上限');rows.push({path:relative,size:s.size,stamp:stamp(s)})}
          else throw Error('拒绝非常规文件');
        }
      }
      walk(base,'');if(!rows.some(r=>r.path==='extension.js'))throw Error('缺少扩展入口');
      const key=base,signature=JSON.stringify({directories,rows}),previous=cache.get(key);
      if(!force&&previous?.signature===signature&&Date.now()-previous.at<15000){result[name]=previous.value;continue}
      const files=rows.map(row=>{const fd=fs.openSync(path.join(base,...row.path.split('/')),'r');try{
        if(stamp(fs.fstatSync(fd))!==row.stamp)throw Error('体检期间文件变化');
        const h=crypto.createHash('sha256'),bytes=Buffer.alloc(65536);let n;
        while((n=fs.readSync(fd,bytes,0,bytes.length,null)))h.update(bytes.subarray(0,n));
        if(stamp(fs.fstatSync(fd))!==row.stamp)throw Error('体检期间文件变化');return {path:row.path,size:row.size,sha256:h.digest('hex')};
      }finally{fs.closeSync(fd)}});
      const value={digest:hash(Buffer.from(JSON.stringify(files))),count:files.length,total:files.reduce((n,f)=>n+f.size,0)};
      cache.set(key,{signature,at:Date.now(),value});while(cache.size>128)cache.delete(cache.keys().next().value);result[name]=value;
    }catch(error){result[name]={error:error.message}}
  }
  return result;
}
module.exports={scan};

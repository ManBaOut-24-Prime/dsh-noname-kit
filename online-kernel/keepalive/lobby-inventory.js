// The boot profile carries configuration only; disk observations are refreshed on demand.
export async function collectLobbyInventory(profile,{signal}={}){
  const fs=require('node:fs'),path=require('node:path');
  const guard=()=>{if(signal?.aborted)throw Error('体检已取消');};
  guard();const boot=profile.inventory;
  if(!boot||!Array.isArray(boot.exts)||!Array.isArray(boot.packs)||!Array.isArray(boot.cards))throw Error('游戏配置快照不可用，请重新打开联机入口。');
  const inventory={exts:[...boot.exts],installed:[],packs:[...boot.packs],cards:[...boot.cards],kernel:boot.kernel||profile.version||'',
    identity:{name:String(profile.identity?.name??profile.identity?.connectNickname??'').slice(0,12),avatar:String(profile.identity?.avatar??profile.identity?.connectAvatar??'').slice(0,24)},batchProtocol:0,inventoryVersion:1};
  try{
    const base=path.join(profile.root,'extension'),stat=await fs.promises.lstat(base);guard();
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('扩展目录不可用');
    const names=await fs.promises.readdir(base);guard();const stock=new Set(profile.stockExtensions||[]);
    for(const name of names){
      if(name==='联机助手'||stock.has(name))continue;
      try{await fs.promises.access(path.join(base,name,'extension.js'));guard();inventory.installed.push(name);}
      catch(error){guard();if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
    }
    const {scanAsync}=require(path.join(profile.root,'extension','联机助手','lib','manifest-files.cjs'));
    inventory.installed.sort();inventory.contents=await scanAsync(profile.root,inventory.installed,{force:true,signal});guard();
    // File errors cross the peer boundary only as bounded explanations, never local paths.
    for(const row of Object.values(inventory.contents))if(row.error)row.error='扩展文件未能完整核验';
  }catch(error){guard();inventory.contents={};inventory.inventoryError='本机扩展文件清单未能完整读取';}
  return inventory;
}

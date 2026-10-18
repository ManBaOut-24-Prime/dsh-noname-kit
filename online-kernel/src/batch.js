/* Batch file integration. Content transfer is paused; no remote toggle. */
(function(){
  var nnk=window.__nnk__,req=typeof window.require==='function'?window.require:typeof require==='function'?require:null;
  var CONTENT_PAUSED=true;
  if(!req){nnk.modules.batch={capability:0,paused:true,attach:function(){},changed:function(){},detach:function(){},handle:function(socket,raw){return typeof raw==='string'&&raw.indexOf('"nnk_files"')>=0},snapshot:function(){return []},reload:function(){return false},retry:function(){return false},canEnter:function(){return true}};return;}
  var path=req('node:path'),root=nnk.modules.compat.gameRoot();
  if(!root)throw new Error('整批文件模块未找到游戏目录');
  nnk.modules.batch=req(path.join(root,'extension','联机助手','lib','batch-runtime.cjs')).createRuntime(nnk,{enabled:!CONTENT_PAUSED,storage:window.localStorage});
  nnk.state.batchFilesPaused=CONTENT_PAUSED;
})();

(function () {
  const nnk = window.__nnk__;
  function join(method,key,value,action) {
    if(nnk.keepaliveRuntime) return nnk.keepaliveRuntime[method](value);
    if(nnk.keepaliveEntry?.role==='ordinary') return nnk.keepaliveEntry.beginCarrier({action,args:{[key]:value}});
    throw Error('联机网络窗口尚未就绪');
  }
  nnk.modules.guest = {
    init() { throw Error('保活路径不安装自动重连'); },
    joinByRoomCode(code) { return join('joinByRoomCode','code',code,'join_room'); },
    joinByInvite(code) { return join('joinByInvite','code',code,'join_invite'); },
    cancelJoin() { return nnk.keepaliveRuntime ? nnk.keepaliveRuntime.cancelJoin() : undefined; },
    resumeEntry() { return false; }
  };
})();

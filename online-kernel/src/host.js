(function () {
  const nnk = window.__nnk__;
  function call(method, args, action) {
    if (nnk.keepaliveRuntime) return nnk.keepaliveRuntime[method](...args);
    if (action && nnk.keepaliveEntry?.role === 'ordinary') return nnk.keepaliveEntry.beginCarrier({action,args:{mode:args[0],signaling:args[1]}});
    throw Error('联机网络窗口尚未就绪');
  }
  nnk.modules.host = {
    init() { throw Error('保活路径不安装旧引擎网络宿主'); },
    createInternetRoom(mode,signaling) { return call('createInternetRoom',[mode,signaling],'create_room'); },
    restartRoom(mode) { return call('restartRoom',[mode]); },
    setRoomMode(mode) { return call('setRoomMode',[mode]); },
    refreshInvite(kind,id) { return call('refreshInvite',[kind,id]); },
    acceptAnswer(id,code) { return call('acceptAnswer',[id,code]); },
    cancelAll() { return nnk.keepaliveRuntime ? nnk.keepaliveRuntime.cancelAll() : undefined; }
  };
})();

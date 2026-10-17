/* Existing game channel metadata is also handled while parked in the lobby.
 * Files remain subject to the separate bound consent and full transaction. */
(function(){
    var nnk=window.__nnk__,peers=new WeakMap(),live=new Set(),pending=new Set(),localScans=0,requestSeq=0,peerSeq=0;
    var peerBoot=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    function emit(type,data){if(nnk.modules.bridge)nnk.modules.bridge.emit(type,data)}
    function check(p,status,reason){emit('manifest_check',{peerId:p.peerId,request:p.request,status:status,reason:reason||'',role:p.role,identity:p.identity||null})}
    function publish(p,result){emit('manifest_diff',Object.assign({},result,{peerId:p.peerId,request:p.request,role:p.role,verification:'verified'}))}
    function collect(){
        var lib=nnk.env.lib,installed=(lib.config.extensions||[]).filter(function(n){return n!=="联机助手"}),exts=installed.filter(function(n){return !!lib.config["extension_"+n+"_enable"]});
        return {exts:exts.sort(),installed:installed.sort(),packs:Object.keys(lib.characterPack||{}).sort(),cards:Object.keys(lib.cardPack||{}).sort(),kernel:nnk.version,
            identity:{name:nnk.env.get.connectNickname(),avatar:lib.config.connect_avatar||""},batchProtocol:2,inventoryVersion:1};
    }
    function observed(force){
        localScans++;
        try{return observeFiles(force)}finally{localScans--}
    }
    function observeFiles(force){
        var m=collect();
        if(!nnk.modules.consent||!nnk.modules.batch){m.inventoryVersion=0;return m;}
        try{
            var req=typeof window.require==="function"?window.require:typeof require==="function"?require:null;
            if(!req)throw Error('没有本机文件接口');
            var root=nnk.modules.compat.gameRoot(),path=req('node:path'),fs=req('node:fs');
            var stock=(nnk.env.lib.config.all||{}).stockextension||[];
            m.installed=fs.readdirSync(path.join(root,'extension')).filter(function(n){return n!=="联机助手" && stock.indexOf(n)<0 && fs.existsSync(path.join(root,'extension',n,'extension.js'))}).sort();
            var scan=req(path.join(root,'extension','联机助手','lib','manifest-files.cjs')).scan;
            m.contents=scan(root,m.installed,{force:!!force});
        }catch(error){m.contents={};m.inventoryError=error.message}
        return m;
    }
    async function observedAsync(force,signal){
        localScans++;
        function guard(){if(signal&&signal.aborted)throw signal.reason||Error('体检已取消');}
        try{
            guard();var m=collect();
            if(!nnk.modules.consent||!nnk.modules.batch){m.inventoryVersion=0;return m;}
            try{
                var req=typeof window.require==='function'?window.require:typeof require==='function'?require:null;
                if(!req)throw Error('没有本机文件接口');
                // Each native engine already has a validated root. process.cwd
                // belongs to the shared shell and may name the other version.
                var root=window.__dirname||nnk.modules.compat.gameRoot(),path=req('node:path'),fs=req('node:fs');
                var stock=(nnk.env.lib.config.all||{}).stockextension||[],names=await fs.promises.readdir(path.join(root,'extension'));guard();
                m.installed=[];
                for(var name of names){
                    if(name==='联机助手'||stock.indexOf(name)>=0)continue;
                    try{await fs.promises.access(path.join(root,'extension',name,'extension.js'));guard();m.installed.push(name);}catch(error){guard();if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
                }
                m.installed.sort();
                var scan=req(path.join(root,'extension','联机助手','lib','manifest-files.cjs')).scanAsync;
                if(typeof scan!=='function')throw Error('异步体检文件接口不可用');
                m.contents=await scan(root,m.installed,{force:!!force,signal:signal});guard();
            }catch(error){guard();m.contents={};m.inventoryError=error.message;}
            guard();return m;
        }finally{localScans--;}
    }
    function valid(m){
        if(!m||!Array.isArray(m.exts)||m.exts.length>64)return false;
        for(var key of ['exts','installed','packs','cards'])if(m[key]!==undefined && (!Array.isArray(m[key])||m[key].length>4096||!m[key].every(function(n){return typeof n==='string'&&n.length<=120})))return false;
        if(m.contents!==undefined){if(!m.contents||typeof m.contents!=='object'||Array.isArray(m.contents)||Object.keys(m.contents).length>64)return false;
            for(var name in m.contents){var c=m.contents[name];if(!c||typeof c!=='object'||c.digest!==undefined&&!/^[a-f0-9]{64}$/.test(c.digest)||c.error!==undefined&&typeof c.error!=='string')return false;}}
        return true;
    }
    function diff(host,guest){
        function split(a,b){return {missing:a.filter(function(n){return b.indexOf(n)<0}),extra:b.filter(function(n){return a.indexOf(n)<0})}}
        var exts=split(host.exts,guest.installed||guest.exts);exts.disabled=[];exts.changed=[];exts.matching=[];exts.unverified=[];
        host.exts.forEach(function(n){
            var a=host.contents&&host.contents[n],b=guest.contents&&guest.contents[n];
            if(exts.missing.indexOf(n)>=0)return;
            if(host.inventoryVersion!==1||guest.inventoryVersion!==1||!a||!b||!a.digest||!b.digest){exts.unverified.push(n);return}
            if(a.digest!==b.digest)exts.changed.push(n);
            else if(guest.exts.indexOf(n)<0)exts.disabled.push(n);
            else exts.matching.push(n);
        });
        exts.needsFiles=exts.missing.concat(exts.changed).filter(function(n){return host.contents&&host.contents[n]&&host.contents[n].digest});
        return {exts:exts,packs:split(host.packs||[],guest.packs||[]),cards:split(host.cards||[],guest.cards||[]),guestKernel: guest.kernel || null,hostKernel: host.kernel || null,
            guestBatchProtocol:guest.batchProtocol||null,hostBatchProtocol:host.batchProtocol||null,guestIdentity:guest.identity||null,hostIdentity:host.identity||null};
    }
    function current(p){return !!p&&!p.closed&&!!p.socket&&peers.get(p.socket)===p&&!p.socket._closed&&!p.socket._disposed&&p.socket.channel.readyState==='open'}
    function detach(socket){
        var p=peers.get(socket);if(!p||p.closed)return;
        p.closed=true;p.legacyAmbiguous=true;p.incoming++;clearTimeout(p.timer);p.timer=null;p.scanController&&p.scanController.abort();p.scanController=null;live.delete(p);
        try{check(p,'closed','连接已结束，本次尚未核验。')}finally{p.socket=null;p.identity=null}
    }
    async function onGuest(p,m,request,incoming,signal){
        if(!current(p)||p.incoming!==incoming)return;
        var local=p.asynchronous?await observedAsync(p.fresh,signal):observed(false);
        if(!current(p)||p.incoming!==incoming)return;
        var result=diff(local,m);
        // A new capable peer receives the completed offer before the admission check.
        // Older manifests still display name differences, but cannot prove content equality.
        if(result.exts.missing.length||result.exts.changed.length)emit('info',{message:(nnk.modules.transfer&&nnk.modules.transfer.pauseReason)||'补传已暂停；缺包或内容差异仍需核对。'});
        if(result.exts.needsFiles.length && nnk.modules.consent)await nnk.modules.consent.propose(p.socket,result.exts.needsFiles);
        if(!current(p)||p.incoming!==incoming)return;
        // Metadata returns only on the requesting connection, including parked peers.
        // File delivery retains its separate entered-bridge route and consent checks.
        p.socket.send(JSON.stringify(request===undefined?['nnk_manifest_diff',result]:['nnk_manifest_diff',result,request]));
        if(!current(p)||p.incoming!==incoming)return;
        publish(p,result);check(p,'verified');
    }
    function receiveHost(socket,m,request){
        var p=peers.get(socket);if(!current(p)||p.role!=='host'||!valid(m)||request!==undefined&&(!Number.isSafeInteger(request)||request<=0))return;
        var incoming=++p.incoming;p.request=request===undefined?incoming:request;p.identity=m.identity||null;check(p,'pending','本次尚未核验，正在体检。');
        if(p.asynchronous){p.scanController&&p.scanController.abort();p.scanController=new AbortController();}
        p.pendingChecks++;pending.add(p);
        onGuest(p,m,request,incoming,p.scanController&&p.scanController.signal).catch(function(error){if(current(p)&&p.incoming===incoming){check(p,'unverified','体检失败，本次尚未核验。');emit('error',{message:'体检失败：'+error.message})}})
            .finally(function(){p.pendingChecks--;if(!p.pendingChecks)pending.delete(p)});
    }
    function send(p,force){
        if(!current(p))return;
        // Untagged replies are attributable only to the first sole pending request.
        // After a later send, timeout or numbered reply, arrival order cannot identify them.
        if(p.request)p.legacyAmbiguous=true;
        clearTimeout(p.timer);p.ready=false;var request=p.request=++requestSeq;check(p,'pending','本次尚未核验，正在体检。');
        if(p.asynchronous){p.scanController&&p.scanController.abort();p.scanController=new AbortController();}
        p.timer=setTimeout(function(){
            if(!current(p)||p.request!==request||p.ready)return;p.timer=null;p.ready=true;p.legacyAmbiguous=true;check(p,'unverified','对方体检未应答，本次尚未核验。');
            p.scanController&&p.scanController.abort();
            emit('info',{message:'对方体检未应答；内容一致性尚未验证。补传不会降级。'});nnk.modules.guest&&nnk.modules.guest.resumeEntry(p.socket);
        },15000);
        function failed(error){if(!current(p)||p.request!==request||p.ready)return;clearTimeout(p.timer);p.timer=null;p.legacyAmbiguous=true;check(p,'unverified','体检失败，本次尚未核验。');emit('error',{message:'体检失败：'+error.message});p.ready=true;nnk.modules.guest&&nnk.modules.guest.resumeEntry(p.socket);}
        if(p.asynchronous){
            p.pendingChecks++;pending.add(p);
            return observedAsync(force,p.scanController.signal).then(function(m){if(current(p)&&p.request===request&&!p.ready)p.socket.send(JSON.stringify(['nnk_manifest',m,request]));})
                .catch(failed).finally(function(){p.pendingChecks--;if(!p.pendingChecks)pending.delete(p);});
        }
        try{p.socket.send(JSON.stringify(['nnk_manifest',observed(force),request]))}
        catch(error){failed(error);}
    }
    function attach(socket,role,options){
        if(peers.has(socket))return;var p={socket:socket,peerId:options&&typeof options.stablePeerId==='string'?options.stablePeerId:peerBoot+'-'+(++peerSeq),role:role,ready:false,closed:false,request:0,incoming:0,legacyAmbiguous:false,timer:null,pendingChecks:0,asynchronous:options&&options.asynchronousHealth===true,fresh:options&&options.freshHealth===true,scanController:null};peers.set(socket,p);live.add(p);
        socket.onDown(function(){detach(socket)});
        if(role==='guest')socket.onUp(function(){send(p,p.fresh)});
    }
    function handle(socket,raw){
        if(typeof raw!=='string'||raw.length>1048576)return false;
        var p=peers.get(socket),m;
        try{m=JSON.parse(raw)}catch(error){return false}
        if(!Array.isArray(m))return false;
        if(m[0]!=='nnk_manifest'&&m[0]!=='nnk_manifest_diff')return false;
        if(!current(p))return true;
        if(p.role==='host'&&m[0]==='nnk_manifest'){receiveHost(socket,m[1],m[2]);return true}
        if(p.role==='guest'&&m[0]==='nnk_manifest_diff'){
            if(m[2]!==undefined)p.legacyAmbiguous=true;
            else if(!p.request||p.ready)return true;
            else if(p.legacyAmbiguous){check(p,'unverified','旧体检回复无法对应本次请求，本次尚未核验；请升级联机助手或重新建立连接后核对。');return true}
            if(!m[1]||!m[1].exts||!Array.isArray(m[1].exts.missing))return true;
            if(!p.request||p.ready||m[2]!==undefined&&m[2]!==p.request)return true;
            p.legacyAmbiguous=true;p.ready=true;clearTimeout(p.timer);p.timer=null;p.identity=m[1].hostIdentity||null;
            publish(p,m[1]);check(p,'verified');nnk.modules.guest&&nnk.modules.guest.resumeEntry(socket);return true;
        }
        return true;
    }
    nnk.modules.manifest={collect:collect,observed:observed,observedAsync:observedAsync,diff:diff,attach:attach,detach:detach,handle:handle,
        resourceSnapshot:function(socket){
            var selected=socket?[peers.get(socket)].filter(Boolean):Array.from(new Set(Array.from(live).concat(Array.from(pending))));
            var result={live:socket?Number(!!selected[0]&&live.has(selected[0])):live.size,pendingTimers:0,socketReferences:0,pendingScans:localScans,pendingChecks:0,retiredPending:0};
            selected.forEach(function(p){result.pendingTimers+=Number(p.timer!=null);result.socketReferences+=Number(!!p.socket);result.pendingChecks+=p.pendingChecks;result.retiredPending+=Number(p.closed&&!!p.pendingChecks)});return result;
        },
        beforeEnter:function(socket){var p=peers.get(socket);return !nnk.modules.batch||!nnk.modules.batch.capability||!p||p.ready},
        recheck:function(){live.forEach(function(p){if(p.role==='guest')send(p,true)})},
        sendManifest:function(){if(!live.size){nnk.env.game.send('nnk_manifest',observed(false));return}live.forEach(function(p){if(p.role==='guest'&&!p.ready)send(p,p.fresh)})},
        install:function(){var lib=nnk.env.lib;
            if(lib.message&&lib.message.server)lib.message.server.nnk_manifest=function(m,request){receiveHost(this.ws||this,m,request)};
            // Native client dispatch has no source socket; only a request number proves ownership.
            if(lib.message&&lib.message.client)lib.message.client.nnk_manifest_diff=function(d,request){if(request!==undefined)handle(nnk.env.game.ws,JSON.stringify(['nnk_manifest_diff',d,request]))};
        }};
})();

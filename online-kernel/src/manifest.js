/* Existing game channel metadata is also handled while parked in the lobby.
 * Files remain subject to the separate bound consent and full transaction. */
(function(){
    var nnk=window.__nnk__,peers=new WeakMap(),live=new Set(),requestSeq=0;
    function emit(type,data){if(nnk.modules.bridge)nnk.modules.bridge.emit(type,data)}
    function collect(){
        var lib=nnk.env.lib,installed=(lib.config.extensions||[]).filter(function(n){return n!=="联机助手"}),exts=installed.filter(function(n){return !!lib.config["extension_"+n+"_enable"]});
        return {exts:exts.sort(),installed:installed.sort(),packs:Object.keys(lib.characterPack||{}).sort(),cards:Object.keys(lib.cardPack||{}).sort(),kernel:nnk.version,
            identity:{name:nnk.env.get.connectNickname(),avatar:lib.config.connect_avatar||""},batchProtocol:2,inventoryVersion:1};
    }
    function observed(force){
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
    function current(p){return !!p&&peers.get(p.socket)===p&&!p.closed&&!p.socket._closed&&!p.socket._disposed&&p.socket.channel.readyState==='open'}
    function detach(socket){
        var p=peers.get(socket);if(!p||p.closed)return;
        p.closed=true;p.incoming++;clearTimeout(p.timer);p.timer=null;live.delete(p);
    }
    async function onGuest(p,m,request,incoming){
        if(!current(p)||p.incoming!==incoming)return;
        var socket=p.socket,result=diff(observed(false),m);emit('manifest_diff',result);
        // A new capable peer receives the completed offer before the admission check.
        // Older manifests still display name differences, but cannot prove content equality.
        if(result.exts.missing.length||result.exts.changed.length)emit('info',{message:(nnk.modules.transfer&&nnk.modules.transfer.pauseReason)||'补传已暂停；缺包或内容差异仍需核对。'});
        if(result.exts.needsFiles.length && nnk.modules.consent)await nnk.modules.consent.propose(socket,result.exts.needsFiles);
        if(!current(p)||p.incoming!==incoming)return;
        // Metadata returns only on the requesting connection, including parked peers.
        // File delivery retains its separate entered-bridge route and consent checks.
        socket.send(JSON.stringify(request===undefined?['nnk_manifest_diff',result]:['nnk_manifest_diff',result,request]));
    }
    function receiveHost(socket,m,request){
        var p=peers.get(socket);if(!current(p)||p.role!=='host'||!valid(m)||request!==undefined&&(!Number.isSafeInteger(request)||request<=0))return;
        var incoming=++p.incoming;
        onGuest(p,m,request,incoming).catch(function(error){if(current(p)&&p.incoming===incoming)emit('error',{message:'体检失败：'+error.message})});
    }
    function send(p,force){
        if(!current(p))return;
        clearTimeout(p.timer);p.ready=false;var request=p.request=++requestSeq;
        p.timer=setTimeout(function(){
            if(!current(p)||p.request!==request||p.ready)return;p.timer=null;p.ready=true;
            emit('info',{message:'对方体检未应答；内容一致性尚未验证。补传不会降级。'});nnk.modules.guest&&nnk.modules.guest.resumeEntry(p.socket);
        },15000);
        try{p.socket.send(JSON.stringify(['nnk_manifest',observed(force),request]))}
        catch(error){if(!current(p)||p.request!==request)return;clearTimeout(p.timer);p.timer=null;emit('error',{message:'体检失败：'+error.message});p.ready=true;nnk.modules.guest&&nnk.modules.guest.resumeEntry(p.socket)}
    }
    function attach(socket,role){
        if(peers.has(socket))return;var p={socket:socket,role:role,ready:false,closed:false,request:0,incoming:0,tagged:false};peers.set(socket,p);live.add(p);
        socket.onDown(function(){detach(socket)});
        if(role==='guest')socket.onUp(function(){send(p,false)});
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
            if(!m[1]||!m[1].exts||!Array.isArray(m[1].exts.missing))return true;
            if(!p.request||p.ready||m[2]!==undefined&&m[2]!==p.request||m[2]===undefined&&p.tagged)return true;
            if(m[2]!==undefined)p.tagged=true;
            p.ready=true;clearTimeout(p.timer);p.timer=null;emit('manifest_diff',m[1]);nnk.modules.guest&&nnk.modules.guest.resumeEntry(socket);return true;
        }
        return true;
    }
    nnk.modules.manifest={collect:collect,observed:observed,diff:diff,attach:attach,detach:detach,handle:handle,
        beforeEnter:function(socket){var p=peers.get(socket);return !nnk.modules.batch||!nnk.modules.batch.capability||!p||p.ready},
        recheck:function(){live.forEach(function(p){if(p.role==='guest')send(p,true)})},
        sendManifest:function(){if(!live.size){nnk.env.game.send('nnk_manifest',observed(false));return}live.forEach(function(p){if(p.role==='guest'&&!p.ready)send(p,false)})},
        install:function(){var lib=nnk.env.lib;
            if(lib.message&&lib.message.server)lib.message.server.nnk_manifest=function(m,request){receiveHost(this.ws||this,m,request)};
            if(lib.message&&lib.message.client)lib.message.client.nnk_manifest_diff=function(d,request){handle(nnk.env.game.ws,JSON.stringify(request===undefined?['nnk_manifest_diff',d]:['nnk_manifest_diff',d,request]))};
        }};
})();

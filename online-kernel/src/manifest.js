/* Existing game channel metadata is also handled while parked in the lobby.
 * Files remain subject to the separate bound consent and full transaction. */
(function(){
    var nnk=window.__nnk__,peers=new WeakMap(),live=new Set();
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
    async function onGuest(socket,m){
        if(!valid(m))return;
        var p=peers.get(socket),result=diff(observed(false),m);emit('manifest_diff',result);
        // A new capable peer receives the completed offer before the admission check.
        // Older manifests still display name differences, but cannot prove content equality.
        if(result.exts.missing.length||result.exts.changed.length)emit('info',{message:(nnk.modules.transfer&&nnk.modules.transfer.pauseReason)||'补传已暂停；缺包或内容差异仍需核对。'});
        if(result.exts.needsFiles.length && nnk.modules.consent)await nnk.modules.consent.propose(socket,result.exts.needsFiles);
        if(p&&p.closed)return;
        if(nnk.modules.transfer)nnk.modules.transfer.sendDirect(this, "nnk_manifest_diff",result);
        else socket.send(JSON.stringify(['nnk_manifest_diff',result]));
    }
    function send(p,force){
        if(p.closed||p.socket.channel.readyState!=='open')return;
        try{p.socket.send(JSON.stringify(['nnk_manifest',observed(force)]))}
        catch(error){emit('error',{message:'体检失败：'+error.message});p.ready=true;nnk.modules.guest&&nnk.modules.guest.resumeEntry(p.socket)}
    }
    function attach(socket,role){
        if(peers.has(socket))return;var p={socket:socket,role:role,ready:false,closed:false};peers.set(socket,p);live.add(p);
        socket.onDown(function(){p.closed=true;live.delete(p);clearTimeout(p.timer)});
        if(role==='guest')socket.onUp(function(){send(p,false);p.timer=setTimeout(function(){
            if(p.closed||p.ready)return;p.ready=true;emit('info',{message:'对方体检未应答；内容一致性尚未验证。补传不会降级。'});nnk.modules.guest&&nnk.modules.guest.resumeEntry(socket);
        },15000)});
    }
    function handle(socket,raw){
        if(typeof raw!=='string'||raw.length>1048576)return false;
        var p=peers.get(socket);if(!p||p.closed)return false;var m;
        try{m=JSON.parse(raw)}catch(error){return false}
        if(!Array.isArray(m))return false;
        if(p.role==='host'&&m[0]==='nnk_manifest'){onGuest.call(socket,socket,m[1]).catch(function(error){emit('error',{message:'体检失败：'+error.message})});return true}
        if(p.role==='guest'&&m[0]==='nnk_manifest_diff'){
            if(!m[1]||!m[1].exts||!Array.isArray(m[1].exts.missing))return true;
            p.ready=true;clearTimeout(p.timer);emit('manifest_diff',m[1]);nnk.modules.guest&&nnk.modules.guest.resumeEntry(socket);return true;
        }
        return false;
    }
    nnk.modules.manifest={collect:collect,observed:observed,diff:diff,attach:attach,handle:handle,
        beforeEnter:function(socket){var p=peers.get(socket);return !nnk.modules.batch||!nnk.modules.batch.capability||!p||p.ready},
        recheck:function(){live.forEach(function(p){if(p.role==='guest')send(p,true)})},
        sendManifest:function(){if(!live.size){nnk.env.game.send('nnk_manifest',observed(false));return}live.forEach(function(p){if(p.role==='guest'&&!p.ready)send(p,false)})},
        install:function(){var lib=nnk.env.lib;
            if(lib.message&&lib.message.server)lib.message.server.nnk_manifest=function(m){onGuest.call(this,this.ws||this,m).catch(function(error){emit('error',{message:error.message})})};
            if(lib.message&&lib.message.client)lib.message.client.nnk_manifest_diff=function(d){emit('manifest_diff',d)};
        }};
})();

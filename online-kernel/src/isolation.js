/* Compatibility guard. Filesystem namespace isolation controls whether extensions may execute. */
(function() {
    var nnk=window.__nnk__;
    function blocked(name) {
        if (name==='联机助手') return false;
        var root=nnk.modules.compat && nnk.modules.compat.gameRoot();
        var req=typeof window.require==='function' ? window.require : typeof require==='function' ? require : null;
        if (!root || !req) return false;
        try {
            var fs=req('node:fs'),path=req('node:path');
            return fs.existsSync(path.join(root,'nnk-batches','active'));
        } catch (error) { return true; }
    }
    nnk.modules.isolation={blocked:blocked};
})();

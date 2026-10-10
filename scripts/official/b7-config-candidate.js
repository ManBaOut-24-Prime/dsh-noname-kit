/* Official IndexedDB config lock. File publication is forbidden before strict oncomplete. */
(function() {
	var nnk = window.__nnk__, KEY = "nnk_pendingBatch";
	function marker() { return nnk.env.lib.config[KEY]; }
	function blocked(name) {
		var m = marker();
		if (!m) return false;
		// Unknown/corrupt markers fail closed; the offline journal is the recovery authority.
		return !m || m.v !== 1 || !Array.isArray(m.extensions) || m.extensions.indexOf(name) >= 0;
	}
	function database() {
		var db = nnk.env.lib.db;
		if (!db || !db.objectStoreNames.contains("config")) throw new Error("官方配置数据库不可用，不能安全隔离扩展");
		return db;
	}
	function transaction(fn) {
		return new Promise(function(resolve, reject) {
			var tx, value, timer;
			try {
				tx = database().transaction(["config"], "readwrite", { durability: "strict" });
				if (tx.durability !== "strict") throw new Error("配置数据库不支持严格持久化");
				tx.oncomplete = function() { clearTimeout(timer); resolve(value); };
				tx.onabort = tx.onerror = function() { clearTimeout(timer); reject(tx.error || new Error("配置隔离事务失败")); };
				timer = setTimeout(function() { try { tx.abort(); } catch (e) {} reject(new Error("配置隔离超时")); }, 15000);
				fn(tx.objectStore("config"), function(v) { value = v; });
			} catch (e) { if (tx) { try { tx.abort(); } catch (ignore) {} } clearTimeout(timer); reject(e); }
		});
	}
	async function lock(id, names) {
		if (marker() || nnk.env._status.reloading || !/^[a-f0-9]{32}$/.test(id) || !Array.isArray(names) || !names.length || names.length > 64) throw new Error("无法建立批次隔离");
		var seen = new Set(), lib = nnk.env.lib;
		names.forEach(function(name) {
			if (typeof name !== "string" || seen.has(name.toLowerCase()) || name === "联机助手" || (lib.config.all.stockextension || []).includes(name) || (lib.config.all.plays || []).includes(name)) throw new Error("批次包含不支持隔离的官方内置扩展");
			seen.add(name.toLowerCase());
		});
		var m = await transaction(function(store, result) {
			var request = store.get(KEY);
			request.onsuccess = function() {
				if (request.result) { store.transaction.abort(); return; }
				var old = {}, remaining = names.length, list = store.get("extensions");
				list.onsuccess = function() {
					var installed = Array.isArray(list.result) ? list.result : lib.config.extensions || [];
					names.forEach(function(name) {
						var key = "extension_" + name + "_enable", read = store.get(key);
						read.onsuccess = function() {
							old[name] = { installed: installed.includes(name), present: read.result !== undefined, enabled: read.result };
							store.put(false, key);
							if (--remaining === 0) { var value = { v: 1, id: id, extensions: names.slice(), old: old }; store.put(value, KEY); result(value); }
						};
					});
				};
			};
		});
		names.forEach(function(name) { lib.config["extension_" + name + "_enable"] = false; }); lib.config[KEY] = m;
		return JSON.parse(JSON.stringify(m));
	}
	async function release(id, committed) {
		var m = marker(), lib = nnk.env.lib;
		if (!m || m.id !== id || m.v !== 1 || !Array.isArray(m.extensions) || !m.old) throw new Error("隔离记录不匹配，须离线恢复");
		var list = await transaction(function(store, result) {
			var verify = store.get(KEY);
			verify.onsuccess = function() {
				if (!verify.result || verify.result.id !== id) { store.transaction.abort(); return; }
				var read = store.get("extensions"); read.onsuccess = function() {
					var entries = (Array.isArray(read.result) ? read.result : lib.config.extensions || []).slice();
					m.extensions.forEach(function(name) {
						var prior = m.old[name], key = "extension_" + name + "_enable";
						if (committed) { if (!entries.includes(name)) entries.push(name); store.put(true, key); }
						else { if (!prior.installed) entries = entries.filter(function(n) { return n !== name; }); if (prior.present) store.put(prior.enabled, key); else store.delete(key); }
					});
					store.put(entries, "extensions"); store.delete(KEY); result(entries);
				};
			};
		});
		m.extensions.forEach(function(name) { var key = "extension_" + name + "_enable", prior = m.old[name]; if (committed) lib.config[key] = true; else if (prior.present) lib.config[key] = prior.enabled; else delete lib.config[key]; });
		lib.config.extensions = list; delete lib.config[KEY];
	}
	function install() {
		var game = nnk.env.game, original = game.saveConfig;
		if (original.__nnkIsolation) return;
		function save(key, value) {
			var args = Array.from(arguments), match = /^extension_(.+)_enable$/.exec(key);
			if (match && blocked(match[1]) && value !== false) args[1] = false;
			return original.apply(this, args);
		}
		save.__nnkIsolation = true; game.saveConfig = save;
	}
	nnk.modules.isolation = { blocked: blocked, lock: lock, release: release, install: install, marker: marker };
})();

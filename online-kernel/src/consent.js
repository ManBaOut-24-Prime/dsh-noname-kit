/* B6 authority protocol. B8 consumes local grants through private socket hooks;
 * this module still carries metadata only, with no legacy fallback. */
(function() {
	var nnk = window.__nnk__;
	var VERSION = 2, TTL = 120000, MAX_FILES = 4096, MAX_META = 1048576;
	var peers = new WeakMap(), live = new Set(), guest = null;
	function emit(type, data) { if (nnk.modules.bridge) nnk.modules.bridge.emit(type, data); }
	function id() {
		var b = new Uint8Array(16); window.crypto.getRandomValues(b);
		return Array.from(b).map(function(x) { return x.toString(16).padStart(2, "0"); }).join("");
	}
	function validId(x) { return typeof x === "string" && /^[a-f0-9]{32}$/.test(x); }
	function safePart(x) {
		return typeof x === "string" && x.length > 0 && x.length <= 120 && x === x.normalize("NFC")
			&& !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(x) && !/[. ]$/.test(x)
			&& x !== "." && x !== ".." && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x);
	}
	function normalize(batch) {
		if (!batch || !Array.isArray(batch.extensions) || !batch.extensions.length || batch.extensions.length > 64) throw new Error("扩展名单无效");
		var seen = new Set(), total = 0, count = 0;
		var extensions = batch.extensions.map(function(ext) {
			if (!ext || !safePart(ext.name) || ext.name === "联机助手" || !Array.isArray(ext.files) || !ext.files.length) throw new Error("扩展清单无效");
			var key = ext.name.toLowerCase(); if (seen.has(key)) throw new Error("扩展路径重复"); seen.add(key);
			var paths = new Set();
			var files = ext.files.map(function(f) {
				if (!f || typeof f.path !== "string" || f.path.length > 240 || !f.path.split("/").every(safePart)
					|| !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("文件清单无效");
				var lower = f.path.toLowerCase(); if (paths.has(lower)) throw new Error("文件路径重复"); paths.add(lower);
				total += f.size; count++;
				if (!Number.isSafeInteger(total) || total > limit() || count > MAX_FILES) throw new Error("批次超过上限");
				return { path: f.path, size: f.size, sha256: f.sha256 };
			}).sort(function(a,b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
			files.forEach(function(f) {
				var parts = f.path.toLowerCase().split("/"); parts.pop();
				while (parts.length) { if (paths.has(parts.join("/"))) throw new Error("文件与目录冲突"); parts.pop(); }
			});
			if (!paths.has("extension.js")) throw new Error("缺少扩展入口");
			return { name: ext.name, files: files };
		}).sort(function(a,b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
		return { extensions: extensions, total: total, count: count };
	}
	function limit() { return Math.min(300, Number(nnk.modules.config && nnk.modules.config.get("transferLimitMB")) || 300) * 1048576; }
	async function digest(batch) {
		var bytes = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(batch)));
		return Array.from(new Uint8Array(bytes)).map(function(x) { return x.toString(16).padStart(2, "0"); }).join("");
	}
	function view(p, summary) {
		if (!p || !p.proposal) return null;
		var q = p.proposal;
		return { session: p.local, peerSession: p.remote, proposal: q.id, digest: q.digest, role: p.role,
			status: q.status, source: q.source, batch: q.batch ? (summary ? { extensions: q.batch.extensions.map(function(e) { return { name: e.name, fileCount: e.files.length }; }), total: q.batch.total, count: q.batch.count } : JSON.parse(JSON.stringify(q.batch))) : null,
			expires: q.expires, reason: q.reason || "", transferPaused: !nnk.modules.batch || nnk.modules.batch.paused };
	}
	function changed(p) { var q = p.proposal; emit("batch_consent", { session: p.local, proposal: q.id, status: q.status, reason: q.reason || "" }); if (nnk.modules.batch) nnk.modules.batch.changed(p.socket); }
	function hello(p) { return { role: p.role, files: nnk.modules.batch ? nnk.modules.batch.capability : 0 }; }
	function send(p, kind, fields) {
		if (p.closed || p.socket.channel.readyState !== "open") throw new Error("补传连接已断开");
		p.socket.send(JSON.stringify(Object.assign({ nnk_batch: VERSION, kind: kind, from: p.local, to: p.remote }, fields || {})));
	}
	function bound(q) { return { proposal: q.id, digest: q.digest }; }
	function active(q) { return q && ["preparing", "pending", "accepting", "rejecting", "authorized_paused"].includes(q.status); }
	function finish(p, status, reason, notify) {
		var q = p.proposal, rank = { declined: 1, expired: 2, cancelled: 3, failed: 4, disconnected: 5 };
		// Terminal states can only move toward a stronger stop; delayed messages never revive consent.
		if (!q || (!active(q) && !(rank[status] > (rank[q.status] || 0)))) return;
		clearTimeout(q.timer); clearTimeout(q.retry); q.status = status; q.reason = reason || status;
		changed(p);
		if (notify) { try { send(p, "cancel", Object.assign(bound(q), { status: status })); } catch (e) { /* peer expires independently */ } }
	}
	function arm(p, q) {
		q.expires = Date.now() + TTL;
		q.timer = setTimeout(function() { if (p.proposal === q) finish(p, "expired", "提议已超时", true); }, TTL);
	}
	function detach(socket) {
		var p = peers.get(socket); if (!p || p.closed) return;
		finish(p, "disconnected", "连接结束，授权失效", false); p.closed = true;
		clearTimeout(p.helloTimer); live.delete(p);
		if (nnk.modules.batch) nnk.modules.batch.detach(socket);
	}
	function attach(socket, role) {
		if (peers.has(socket)) return;
		var p = { socket: socket, role: role, local: id(), remote: null, closed: false, proposal: null, used: new Set() };
		peers.set(socket, p); live.add(p); if (role === "guest") guest = p;
		if (nnk.modules.batch) nnk.modules.batch.attach(socket, role);
		socket.onDown(function() { detach(socket); });
		// A single delayed hello lets both bridge constructors finish. No engine slots are replaced.
		p.helloTimer = setTimeout(function() {
			try { send(p, "hello", hello(p)); } catch (e) { /* channel not open yet */ }
		}, 0);
		if (role === "guest") socket.onUp(function() { try { send(p, "hello", hello(p)); } catch (e) {} });
	}
	async function receive(p, m) {
		if (m.nnk_batch !== VERSION) { finish(p, "failed", "对端协议版本不兼容", true); emit("batch_upgrade", { message: "双方需升级到支持批次授权的新内核；补传不降级。" }); return; }
		if (m.kind === "hello") {
			if (!validId(m.from) || m.role !== (p.role === "host" ? "guest" : "host")) return;
			if (p.remote && p.remote !== m.from) { finish(p, "failed", "连接上的会话标识变化", true); return; }
			if (p.files !== undefined && p.files !== (m.files === 1 ? 1 : 0)) { finish(p, "failed", "连接上的文件能力发生变化", true); return; }
			p.files = m.files === 1 ? 1 : 0;
			if (!p.remote) { p.remote = m.from; send(p, "hello", hello(p)); }
			return;
		}
		if (!p.remote || m.from !== p.remote || m.to !== p.local) return;
		var q = p.proposal;
		if (m.kind === "offer" && p.role === "guest") {
			if (!validId(m.proposal) || typeof m.digest !== "string" || !/^[a-f0-9]{64}$/.test(m.digest) || m.ttlMs !== TTL) return;
			if (q && q.id === m.proposal) {
				try { if (q.digest !== m.digest || JSON.stringify(normalize(m.batch)) !== JSON.stringify(q.batch)) finish(p, "failed", "提议内容变化", true); }
				catch (e) { finish(p, "failed", "提议内容变化", true); }
				return;
			}
			if (p.used.has(m.proposal) || p.used.size >= 128) return;
			finish(p, "cancelled", "提议已被替换，须重新授权", true);
			q = { id: m.proposal, digest: m.digest, status: "preparing", source: String(m.source || "房主").slice(0, 80) };
			p.proposal = q; p.used.add(q.id); arm(p, q);
			try {
				q.batch = normalize(m.batch);
				if (await digest(q.batch) !== q.digest) throw new Error("提议摘要不匹配");
				if (p.closed || p.proposal !== q || q.status !== "preparing") return;
				q.status = "pending"; changed(p);
			} catch (e) { if (p.proposal === q) finish(p, "failed", e.message, true); }
			return;
		}
		if (!q || m.proposal !== q.id || m.digest !== q.digest) return;
		if (m.kind === "decision" && p.role === "host" && typeof m.yes === "boolean") {
			if (q.choice !== undefined) {
				if (q.choice !== m.yes) { finish(p, "failed", "同一提议出现冲突的授权响应", true); return; }
				send(p, "result", Object.assign(bound(q), { status: q.status })); return;
			}
			if (q.status !== "pending") return;
			if (Date.now() >= q.expires) { finish(p, "expired", "提议已超时", true); return; }
			q.choice = m.yes;
			if (m.yes) { q.status = "authorized_paused"; changed(p); }
			else finish(p, "declined", "客人拒绝补传", false);
			send(p, "result", Object.assign(bound(q), { status: q.status }));
		} else if (m.kind === "result" && p.role === "guest" && q.status === "accepting" && m.status === "authorized_paused") {
			clearTimeout(q.retry); q.status = "authorized_paused"; changed(p);
		} else if (m.kind === "result" && p.role === "guest" && q.status === "rejecting" && m.status === "declined") {
			finish(p, "declined", "你已拒绝补传", false);
		} else if (m.kind === "result" && p.role === "guest" && ["cancelled", "expired", "failed"].includes(m.status)) {
			finish(p, m.status, "对端确认提议已终止", false);
		} else if (m.kind === "cancel" && ["cancelled", "expired", "failed"].includes(m.status)) {
			finish(p, m.status, "对端终止了本次提议", false);
		}
	}
	function handle(socket, raw) {
		if (typeof raw !== "string" || raw.indexOf('"nnk_batch"') < 0) return false;
		if (raw.length > MAX_META && /^\s*\{/.test(raw)) { var owner = peers.get(socket); if (owner) finish(owner, "failed", "补传元数据超过上限", true); return true; }
		var m; try { m = JSON.parse(raw); } catch (e) { return false; }
		if (!m || Array.isArray(m) || !Object.prototype.hasOwnProperty.call(m, "nnk_batch")) return false;
		var p = peers.get(socket);
		if (p && !p.closed) {
			if (raw.length > MAX_META) finish(p, "failed", "补传元数据超过上限", true);
			else receive(p, m).catch(function(e) { finish(p, "failed", e.message, true); });
		}
		return true;
	}
	async function collect(names) {
		if (!Array.isArray(names) || names.length > 64) throw new Error("扩展数量超过上限");
		var req = window.require; if (!req) throw new Error("官方 Electron 文件能力不可用");
		var fs = req("fs"), path = req("path"), crypto = req("crypto"), root = nnk.modules.compat.gameRoot();
		if (!root) throw new Error("无法定位官方游戏目录");
		var base = path.join(root, "extension"), extensions = [], total = 0, count = 0;
		if (!fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink()) throw new Error("扩展根目录不安全");
		for (var name of names) {
			if (!safePart(name) || name === "联机助手") throw new Error("扩展名无效");
			var files = [];
			async function walk(dir, rel) {
				var st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("拒绝链接或非常规目录");
				for (var entry of fs.readdirSync(dir)) {
					if (!safePart(entry)) throw new Error("文件路径无效");
					var full = path.join(dir, entry), relative = rel ? rel + "/" + entry : entry;
					var s = fs.lstatSync(full);
					if (s.isSymbolicLink()) throw new Error("拒绝链接文件");
					if (s.isDirectory()) await walk(full, relative);
					else if (s.isFile()) {
						total += s.size; count++; if (total > limit() || count > MAX_FILES) throw new Error("批次超过上限");
						var data = await fs.promises.readFile(full);
						if (data.length !== s.size) throw new Error("采集时文件变化");
						files.push({ path: relative, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
					} else throw new Error("拒绝非常规文件");
				}
			}
			await walk(path.join(base, name), ""); extensions.push({ name: name, files: files });
		}
		return normalize({ extensions: extensions });
	}
	async function propose(client, names) {
		var socket = client && (client.ws || client), p = peers.get(socket);
		if (!p || p.closed || p.role !== "host" || !p.remote) { emit("batch_upgrade", { message: "对端未协商批次授权协议；请双方升级并重启。补传保持暂停。" }); return false; }
		if (active(p.proposal) || !names.length || p.used.size >= 128) return false;
		var key = JSON.stringify(names.slice().sort()); if (p.lastOffered === key) return false; p.lastOffered = key;
		var q = { id: id(), digest: "", status: "preparing", source: "房主" }; p.proposal = q; p.used.add(q.id); arm(p, q);
		try {
			q.batch = await collect(names); q.digest = await digest(q.batch);
			if (p.closed || p.proposal !== q || q.status !== "preparing") return false;
			q.source = String(nnk.env.get.connectNickname() || "房主").slice(0, 80);
			var offer = Object.assign(bound(q), { batch: q.batch, source: q.source, ttlMs: TTL });
			if (JSON.stringify(offer).length + 256 > MAX_META) throw new Error("批次元数据超过上限");
			q.status = "pending"; send(p, "offer", offer); changed(p); return true;
		} catch (e) { if (p.proposal === q) finish(p, "failed", e.message, true); return false; }
	}
	function decide(args) {
		var p = guest, q = p && p.proposal;
		if (!p || p.closed || !q || q.status !== "pending" || Date.now() >= q.expires || typeof args.yes !== "boolean"
			|| args.session !== p.local || args.peerSession !== p.remote || args.proposal !== q.id || args.digest !== q.digest) return false;
		q.choice = args.yes; q.status = args.yes ? "accepting" : "rejecting";
		changed(p);
		var attempts = 0;
		function deliver() {
			if (p.closed || p.proposal !== q || !["accepting", "rejecting"].includes(q.status)) return;
			try { send(p, "decision", Object.assign(bound(q), { yes: args.yes })); }
			catch (e) { finish(p, "disconnected", e.message, false); return; }
			if (++attempts < 5) q.retry = setTimeout(deliver, 2000);
		}
		deliver();
		return true;
	}
	function cancel(args) {
		for (var p of live) {
			var q = p.proposal;
			if (q && args.session === p.local && args.peerSession === p.remote && args.proposal === q.id && args.digest === q.digest) {
				finish(p, "cancelled", "用户取消本次提议", true); return true;
			}
		}
		return false;
	}
	function retry(socket,args) {
		var p=peers.get(socket),q=p && p.proposal;
		if(!p || p.closed || p.role!=="host" || !q || !q.batch || q.status==="declined" || args.session!==p.local || args.peerSession!==p.remote || args.proposal!==q.id || args.digest!==q.digest)return false;
		finish(p,"cancelled","房主明确重新提议，须再次授权",true);p.lastOffered=null;
		return propose(socket,q.batch.extensions.map(function(e){return e.name}));
	}
	nnk.modules.consent = { attach: attach, detach: detach, handle: handle, propose: propose, decide: decide, cancel: cancel,
		retry: retry,
		authorization: function(socket) { var p=peers.get(socket), q=p && p.proposal; return p && !p.closed && q && q.status === "authorized_paused" && q.choice === true && Date.now() < q.expires ? view(p, false) : null; },
		fileCapable: function(socket) { var p=peers.get(socket); return !!(p && p.files === 1); },
		cancelAll: function() { live.forEach(function(p) { finish(p, "cancelled", "用户取消", true); }); },
		snapshot: function() { return Array.from(live).concat(guest && !live.has(guest) ? [guest] : []).map(function(p) { return view(p, false); }).filter(Boolean); },
		summaries: function() { return Array.from(live).concat(guest && !live.has(guest) ? [guest] : []).map(function(p) { return view(p, true); }).filter(Boolean); },
		normalize: normalize, digest: digest, version: VERSION };
})();

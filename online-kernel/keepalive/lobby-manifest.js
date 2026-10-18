import { compareManifests } from './manifest-compare.js';

export const LOBBY_MANIFEST_PROTOCOL = 'nnk-lobby-manifest/1';
export const LOBBY_MANIFEST_TYPES = new Set(['lobby-manifest-request', 'lobby-manifest-response']);
const REQUEST = 'lobby-manifest-request', RESPONSE = 'lobby-manifest-response';
const MAX_BYTES = 200 * 1024, MAX_PEERS = 32, MAX_FILES = 4096, MAX_TOTAL = 1024 * 1048576;
const leases = ['partySessionId', 'roundId', 'operationId'];
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]/.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const allowed = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const bounded = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
const names = (value, max) => Array.isArray(value) && value.length <= max
  && value.every(name => bounded(name, 120) && name.length > 0) && new Set(value).size === value.length;
const name = value => bounded(value, 120) && value.length > 0 && !/[<>:"/\\|?*]/.test(value)
  && !/[. ]$/.test(value) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(value);
const clone = value => JSON.parse(JSON.stringify(value));
const scopeKey = scope => JSON.stringify(scope);
function readScope(value) {
  if (!exact(value, ['carrierSessionId', 'partyEpoch']) || !id(value.carrierSessionId)
    || !Number.isSafeInteger(value.partyEpoch) || value.partyEpoch < 0 || value.partyEpoch > 1000000000) throw Error('Current bounded carrier scope required');
  return { carrierSessionId: value.carrierSessionId, partyEpoch: value.partyEpoch };
}

export function validLobbyInventory(value) {
  const keys = ['exts', 'installed', 'packs', 'cards', 'kernel', 'identity', 'batchProtocol', 'inventoryVersion', 'contents', 'inventoryError'];
  if (!allowed(value, keys) || !names(value.exts, 64) || !value.exts.every(name)
    || !names(value.installed, 64) || !value.installed.every(name) || !names(value.packs, 4096) || !names(value.cards, 4096)
    || !bounded(value.kernel, 80) || !exact(value.identity, ['name', 'avatar'])
    || !bounded(value.identity.name, 12) || !bounded(value.identity.avatar, 24)
    || ![0, 1].includes(value.inventoryVersion) || value.batchProtocol !== undefined && ![0, 2].includes(value.batchProtocol)
    || value.inventoryError !== undefined && (!bounded(value.inventoryError, 240) || !value.inventoryError)) return false;
  if (value.contents !== undefined) {
    if (!plain(value.contents) || Object.keys(value.contents).length > 64) return false;
    for (const [key, item] of Object.entries(value.contents)) {
      if (!name(key) || !value.installed.includes(key) || !allowed(item, ['digest', 'count', 'total', 'error'])) return false;
      if (item.error !== undefined) {
        if (!exact(item, ['error']) || !bounded(item.error, 240) || !item.error) return false;
      } else if (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)
        || item.count !== undefined && (!Number.isSafeInteger(item.count) || item.count < 0 || item.count > MAX_FILES)
        || item.total !== undefined && (!Number.isSafeInteger(item.total) || item.total < 0 || item.total > MAX_TOTAL)) return false;
    }
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES; } catch { return false; }
}

// Preserve content summaries, never send filesystem paths or exception details.
export function sanitizeLobbyInventory(value) {
  if (!validLobbyInventory(value)) throw Error('Local package inventory is invalid or exceeds its bound');
  const result = clone(value);
  if (result.inventoryError) result.inventoryError = '本机扩展清单未能完整读取';
  for (const item of Object.values(result.contents || {})) if (item.error !== undefined) item.error = '扩展文件摘要未能读取';
  return result;
}

export class LobbyManifest {
  constructor({ sessions, getRole, collect, emit = () => {}, getScope, now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer), newRequestId = () => crypto.randomUUID(), timeoutMs = 15000, minIntervalMs = 1500 }) {
    if (!sessions || [getRole, collect, emit, getScope, now, setTimer, clearTimer, newRequestId].some(fn => typeof fn !== 'function')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
      || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1 || minIntervalMs > 60000) throw Error('Bounded manifest dependencies required');
    Object.assign(this, { sessions, getRole, collect, emit, getScope, now, setTimer, clearTimer, newRequestId, timeoutMs, minIntervalMs });
    this.capable = new Map(); this.pending = new Map(); this.inbound = new Map(); this.latest = new Map();
    this.lastOutgoing = new Map(); this.lastIncoming = new Map(); this.seen = new Map(); this.recent = [];
    this.scan = null; this.pendingScans = 0; this.sequence = 0; this.closed = false; this.scope = readScope(getScope());
  }
  capabilities() { return [LOBBY_MANIFEST_PROTOCOL]; }
  capabilitySnapshot() {
    return [...this.capable.keys()].filter(peer => !this.closed && this._actual(peer)).map(peer => ({
      peerId: peer, owner: this.sessions.getOwner(peer), connectionSessionId: this.sessions.get(peer).connectionSessionId,
    }));
  }
  _scope() { return readScope(this.getScope()); }
  _syncScope() {
    const current = this._scope();
    if (scopeKey(current) !== scopeKey(this.scope)) {
      for (const row of new Set([...this.pending.values(), ...this.inbound.values()])) this._finish(row, 'closed', '会话已更换，本次尚未核验。');
      this.scan?.controller.abort(); this.latest.clear(); this.scope = current;
    }
    return current;
  }
  _actual(peer, owner = this.sessions.getOwner(peer)) {
    const record = this.sessions.get(peer), cap = this.capable.get(peer);
    return !!record && !!owner && this.sessions.isLive(peer) && this.sessions.getOwner(peer) === owner
      && this.sessions.peerForActualOwner(owner) === peer && cap?.owner === owner && cap.sessionId === record.connectionSessionId;
  }
  setPeerCapability(peer, supported = true) {
    if (!supported) { this.forgetPeer(peer); return false; }
    if (this.closed) return false;
    const record = this.sessions.get(peer), owner = this.sessions.getOwner(peer);
    if (!record || !owner || !this.sessions.isLive(peer) || this.sessions.peerForActualOwner(owner) !== peer || this.capable.size >= MAX_PEERS && !this.capable.has(peer)) return false;
    this.capable.set(peer, { owner, sessionId: record.connectionSessionId }); return true;
  }
  _active(row) {
    return !this.closed && !row.done && this._actual(row.peer, row.owner)
      && this.sessions.get(row.peer).connectionSessionId === row.connectionSessionId
      && scopeKey(this._scope()) === scopeKey(row.scope) && this.getRole() === row.role;
  }
  _emit(row, type, data) {
    if (this.latest.get(row.peer) !== row || scopeKey(this._scope()) !== scopeKey(row.scope)) return;
    this.emit(type, { ...data, peerId: row.peer, request: row.request, role: row.role,
      identity: row.identity || null, scope: clone(row.scope), manifestScope: clone(row.scope) });
  }
  _finish(row, status, reason = '') {
    if (row.done) return; row.done = true; this.clearTimer(row.timer); row.timer = null;
    if (this.pending.get(row.peer) === row) this.pending.delete(row.peer);
    if (this.inbound.get(row.peer) === row) this.inbound.delete(row.peer);
    this.scan?.users.delete(row); if (this.scan && !this.scan.users.size) this.scan.controller.abort();
    this._emit(row, 'manifest_check', { status, reason });
  }
  _newRow(peer, requestId, direction) {
    if (this.sequence >= 1000000000) throw Error('Package check request limit reached');
    const owner = this.sessions.getOwner(peer), record = this.sessions.get(peer);
    const row = { peer, owner, connectionSessionId: record.connectionSessionId, requestId, request: ++this.sequence,
      role: this.getRole(), scope: clone(this.scope), identity: null, direction, done: false, timer: null,
      afterSequence: owner.snapshot().lastAcceptedControlSeq };
    // A simultaneous incoming check must not hide the pending local request's result.
    if (direction !== 'incoming' || !this.pending.has(peer)) this.latest.set(peer, row);
    row.timer = this.setTimer(() => this._finish(row, 'unverified', '对方体检未应答，本次尚未核验。'), this.timeoutMs);
    this._emit(row, 'manifest_check', { status: 'pending', reason: '本次尚未核验，正在体检。' }); return row;
  }
  async _inventory(rows) {
    let scan = this.scan;
    if (scan && (scan.controller.signal.aborted || scopeKey(scan.scope) !== scopeKey(this.scope))) throw Error('Previous package inventory is still retiring');
    if (!scan) {
      const controller = new AbortController(); scan = { controller, scope: clone(this.scope), users: new Set(), promise: null };
      this.scan = scan; this.pendingScans++;
      scan.promise = Promise.resolve().then(() => this.collect({ signal: controller.signal })).then(value => {
        if (controller.signal.aborted || this.closed || scopeKey(this._scope()) !== scopeKey(scan.scope)) throw Error('Retired package inventory');
        return sanitizeLobbyInventory(value);
      }).finally(() => { this.pendingScans--; if (this.scan === scan) this.scan = null; });
    }
    rows.forEach(row => scan.users.add(row)); return scan.promise;
  }
  _data(row, inventory, responseTo) {
    const requestId = responseTo ? this.newRequestId() : row.requestId;
    if (!id(requestId)) throw Error('Fresh bounded manifest request ID required');
    return { protocol: LOBBY_MANIFEST_PROTOCOL, partySessionId: null, roundId: null, operationId: null,
      requestId, connectionSessionId: row.connectionSessionId, ...(responseTo ? { responseTo } : {}), inventory };
  }
  validate(owner, frame) {
    if (!LOBBY_MANIFEST_TYPES.has(frame?.type)) return null;
    try {
      if (this.closed) return 'retired-lobby-manifest';
      this._syncScope();
      const peer = this.sessions.peerForActualOwner(owner), role = this.getRole(), record = peer && this.sessions.get(peer), d = frame.data;
      if (!['host', 'guest'].includes(role) || !peer || !this._actual(peer, owner) || owner.role !== role
        || frame.sourcePeer !== (role === 'host' ? 'guest' : 'host') || frame.sessionId !== record.connectionSessionId
        || !Number.isSafeInteger(frame.seq) || frame.seq < 1 || !plain(d)
        || d.protocol !== LOBBY_MANIFEST_PROTOCOL || !leases.every(key => d[key] === null)
        || d.connectionSessionId !== record.connectionSessionId || !id(d.requestId)) return 'invalid-lobby-manifest-source';
      const base = ['protocol', ...leases, 'requestId', 'connectionSessionId'];
      if (frame.type === REQUEST) {
        if (!exact(d, [...base, 'inventory']) || !validLobbyInventory(d.inventory)) return 'invalid-lobby-manifest-inventory';
        const history = this.seen.get(peer) || [], at = this.now();
        if (history.includes(d.requestId) || this.inbound.has(peer) || this.inbound.size >= 4
          || at - (this.lastIncoming.get(peer) ?? -Infinity) < this.minIntervalMs
          || this.recent.filter(t => at - t < 10000).length >= 8) return 'lobby-manifest-request-limited';
      } else {
        const error = Object.hasOwn(d, 'error'), fields = [...base, 'responseTo', error ? 'error' : 'inventory'];
        if (!exact(d, fields) || !id(d.responseTo) || error && d.error !== 'inventory-unavailable'
          || !error && !validLobbyInventory(d.inventory)) return 'invalid-lobby-manifest-response';
        const row = this.pending.get(peer);
        if (!row || !this._active(row) || row.owner !== owner || row.requestId !== d.responseTo
          || frame.seq <= row.afterSequence || !row.inventory) return 'stale-lobby-manifest-response';
      }
      return true;
    } catch { return 'invalid-lobby-manifest-state'; }
  }
  _publish(row, local, remote) {
    if (!this._active(row)) return;
    row.identity = clone(remote.identity);
    const result = row.role === 'host' ? compareManifests(local, remote) : compareManifests(remote, local);
    this._emit(row, 'manifest_diff', { ...result, verification: 'verified', metadataOnly: true });
    this._finish(row, 'verified');
  }
  async control(owner, frame) {
    if (this.validate(owner, frame) !== true) return false;
    const peer = this.sessions.peerForActualOwner(owner), d = frame.data;
    if (frame.type === RESPONSE) {
      const row = this.pending.get(peer);
      if (d.error) this._finish(row, 'unverified', '对方体检失败，本次尚未核验。');
      else this._publish(row, row.inventory, d.inventory);
      return true;
    }
    const at = this.now(); this.lastIncoming.set(peer, at); this.recent = this.recent.filter(t => at - t < 10000); this.recent.push(at);
    const history = this.seen.get(peer) || []; history.push(d.requestId); this.seen.set(peer, history.slice(-32));
    const row = this._newRow(peer, d.requestId, 'incoming'); this.inbound.set(peer, row); row.identity = clone(d.inventory.identity);
    try {
      const local = await this._inventory([row]);
      if (!this._active(row)) return true;
      this.sessions.sendControl(peer, RESPONSE, this._data(row, local, d.requestId)); this._publish(row, local, d.inventory);
    } catch {
      if (this._active(row)) {
        const data = this._data(row, undefined, d.requestId); delete data.inventory; data.error = 'inventory-unavailable';
        try { this.sessions.sendControl(peer, RESPONSE, data); } catch { /* A stopped owner cannot receive a result. */ }
        this._finish(row, 'unverified', '本机体检失败，本次尚未核验。');
      }
    }
    return true;
  }
  async recheck({ peerId } = {}, onStarted) {
    if (this.closed) throw Error('当前联机会话已退出'); this._syncScope();
    if (onStarted !== undefined && typeof onStarted !== 'function') throw Error('Local package check callback required');
    const state = this.readiness();
    if (!state.available) throw Error(state.reason);
    const peers = peerId === undefined ? state.peers : state.peers.filter(peer => peer === peerId);
    if (!peers.length) throw Error('当前对端不支持插件房间包体检');
    const at = this.now();
    if (this.pending.size || onStarted && (this.inbound.size || this.pendingScans) || peers.some(peer => at - (this.lastOutgoing.get(peer) ?? -Infinity) < this.minIntervalMs)) throw Error('包体检正在进行或操作过快，请稍候');
    const rows = peers.map(peer => {
      const requestId = this.newRequestId(); if (!id(requestId)) throw Error('Fresh bounded manifest request ID required');
      const row = this._newRow(peer, requestId, 'outgoing'); this.pending.set(peer, row); this.lastOutgoing.set(peer, at); return row;
    });
    try {
      if (onStarted) onStarted(rows.map(row => ({ peerId: row.peer, request: row.request, scope: clone(row.scope) })));
      const inventory = await this._inventory(rows);
      for (const row of rows) if (this._active(row)) {
        row.inventory = clone(inventory);
        try { this.sessions.sendControl(row.peer, REQUEST, this._data(row, inventory)); }
        catch { this._finish(row, 'unverified', '体检请求未能发送，本次尚未核验。'); }
      }
    } catch { for (const row of rows) if (this._active(row)) this._finish(row, 'unverified', '本机体检失败，本次尚未核验。'); }
    return { requested: rows.some(row => !row.done), peers, verification: 'pending; current metadata events supply the result' };
  }
  readiness() {
    if (!this.closed) this._syncScope();
    const peers = this.closed || !['host', 'guest'].includes(this.getRole()) ? [] : [...this.capable.keys()].filter(peer => this._actual(peer));
    const connected = !this.closed && this.sessions.snapshot().some(record => this.sessions.isLive(record.peerId));
    return { available: peers.length > 0, scope: clone(this.scope), peers, pending: this.pending.size + this.inbound.size,
      pendingScans: this.pendingScans, reason: this.closed ? '当前联机会话已退出' : !connected ? '需要双方先连接插件房间' : !peers.length ? '对方尚未支持插件房间包体检，请双方更新内核并重启后再核对' : '' };
  }
  forgetPeer(peer) {
    const row = this.latest.get(peer), wasDone = row?.done;
    for (const active of [this.pending.get(peer), this.inbound.get(peer)].filter(Boolean)) this._finish(active, 'closed', '连接已结束，本次尚未核验。');
    if (wasDone) this._emit(row, 'manifest_check', { status: 'closed', reason: '连接已结束，本次尚未核验。' });
    this.capable.delete(peer); this.latest.delete(peer); this.lastOutgoing.delete(peer); this.lastIncoming.delete(peer); this.seen.delete(peer);
  }
  dispose() {
    if (this.closed) return;
    for (const peer of this.capable.keys()) this.forgetPeer(peer);
    this.scan?.controller.abort(); this.recent = []; this.closed = true;
  }
}

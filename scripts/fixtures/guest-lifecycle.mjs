import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const source = name => readFileSync(new URL('../../online-kernel/src/' + name + '.js', import.meta.url), 'utf8')
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
export async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve() }
export function fixture(options = {}) {
  const pcs = [], signals = [], events = [], timers = new Map(), storage = new Map()
  let timerId = 0, reloads = 0, nativeCloses = 0, exits = 0
  const timeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }
  class PC {
    constructor() { this.offer = deferred(); this.remote = deferred(); this.channels = []; this.connectionState = 'new'; this.localDescription = { type: 'offer', sdp: 'fixture' }; this.locals = 0; this.closed = 0; pcs.push(this) }
    createDataChannel(label) { const channel = { label, readyState: 'connecting', bufferedAmount: 0, send() {}, close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.() } }; this.channels.push(channel); return channel }
    createOffer() { return this.offer.promise }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'fixture' }) }
    setLocalDescription() { this.locals++; return Promise.resolve() }
    setRemoteDescription() { return this.remote.promise }
    close() { this.closed++; this.connectionState = 'closed'; for (const channel of this.channels) channel.close() }
  }
  const nnk = { state: {}, modules: {}, env: { _status: { connectMode: true }, get: { connectNickname: () => 'guest' }, ui: { click: { exit() { exits++ } } },
    lib: { config: {}, configprefix: 'fixture-', element: { ws: { onopen() {}, onmessage() {}, onerror() {}, onclose() { nativeCloses++; if (!this._nocallback) reloads++ } } }, message: { client: { denied() { this.nativeDenied = true; nnk.env.game.ws.close() } } } },
    game: { online: false, connect() {}, reload() { reloads++ }, saveConfig() {} },
  } }
  nnk.modules.bridge = { emit: (type, data) => events.push({ type, data }), setPhase: (phase, data) => events.push({ phase, data }) }
  nnk.modules.config = { get: () => [] }
  nnk.modules.signaling = { randomId: () => 'g', roomTopic: (code, leaf) => code + '/' + leaf, openRoomSession: (code, role, topics, cb, signal) => {
    const d = deferred(), entry = { ...d, cb, signal, ended: 0, publishes: 0 }
    entry.session = { end: () => entry.ended++, publish: () => { entry.publishes++; return Promise.resolve() } }
    signals.push(entry); return entry.promise
  } }
  const context = { window: { __nnk__: nnk, alert() {}, confirm() {} }, RTCPeerConnection: PC, AbortController,
    setTimeout: timeout, clearTimeout: id => timers.delete(id), setInterval: timeout, clearInterval: id => timers.delete(id),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    console: { log() {}, warn() {}, error() {} }, Date, TextEncoder, TextDecoder, atob, btoa,
  }
  if (options.prepare) options.prepare(nnk)
  runInNewContext(source('rtc'), context)
  nnk.modules.rtc.waitGather = () => Promise.resolve()
  nnk.modules.rtc.trackPc = () => {}
  nnk.modules.rtc.directHosts = () => []
  nnk.modules.rtc.addInjected = () => 0
  runInNewContext(source('guest'), context); nnk.modules.guest.init()
  return { nnk, pcs, signals, events, timers, storage, context, stats: () => ({ reloads, nativeCloses, exits }) }
}

/**
 * 联机助手:内核安装管理 + 工坊↔游戏内核的心跳桥会话。
 *
 * 架构:跨网络联机的传输层(WebRTC)必须跑在游戏进程里,所以有一个以扩展
 * 形态存在的「内核」(online-kernel/,随插件打包)。它无头运行,由本模块:
 *  1. 安装/升级到游戏 extension/联机助手/(复制 + 盖章 + 哈希配对,同 preset
 *     哲学;备份放在游戏根目录 nnk-kernel-backups/ —— 不能放 extension/ 里,
 *     游戏会把那里每个含 extension.js 的子目录都当成扩展加载);
 *  2. 经 nnk-bridge.json(安装时写入桥地址与 token)与内核保持心跳:
 *     内核轮询 POST /online/bridge 上报状态与事件、取回工坊下发的命令
 *     (create_room / join_invite / accept_answer / invite_refresh / cancel)。
 *
 * 为什么不用 preset.js 的 hashDir:安装时会往内核目录多写一个 nnk-bridge.json
 * (哈希必须忽略它),所以这里自带一份带跳过清单的目录哈希。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installKernelFiles, kernelContentHash, kernelInstallPending } from './kernel-install.js'

export const KERNEL_FOLDER = '联机助手'
export const KERNEL_MANIFEST = '.nnk-kernel.json'
/** 命令在队列里的最长等待:内核 0.7s 一轮,60s 足够宽裕;过期丢弃防陈旧命令误执行。 */
const COMMAND_TTL_MS = 60_000
/** bridge.snapshot() 里 online 的判定窗口(内核 0.7s 一轮,3 秒没消息即视为离线)。 */
const ONLINE_WINDOW_MS = 3000
/* 房间状态宽限:游戏关掉后,最后一拍心跳的状态(房号/成员/阶段)不能永远挂
 * 在工坊上(实测:关游戏后房间还在)。30 秒=覆盖「载入到游戏」重载期间的心跳
 * 空窗(游戏页重载→内核重启),超时即视为房间已散,快照不再下发 state/role */
const ROOM_STATE_GRACE_MS = 30_000

/** 插件包内自带的内核源目录(唯一真源)。 */
export function bundledKernelDir() {
  return fileURLToPath(new URL('../online-kernel/', import.meta.url))
}

export function kernelDirOf(nonameDir) {
  return join(nonameDir, 'extension', KERNEL_FOLDER)
}

/** 内核版本号:从自带 extension.js 的 __nnk__ 初始化行里读。内核源随插件冻结,
 *  运行期只读一次盘(工坊状态每 1.5s 轮询,别让它反复打文件)。 */
let cachedKernelVersion
export function bundledKernelVersion() {
  if (cachedKernelVersion !== undefined) return cachedKernelVersion
  try {
    const code = readFileSync(join(bundledKernelDir(), 'extension.js'), 'utf8')
    const m = /window\.__nnk__ = \{ version: "([^"]+)"/.exec(code)
    cachedKernelVersion = m ? m[1] : null
  } catch {
    cachedKernelVersion = null
  }
  return cachedKernelVersion
}

/** 补传暂停运行标识:与磁盘内容哈希分开,心跳必须来自已重启的新内核。 */
export function bundledKernelBuild() {
  const code = readFileSync(join(bundledKernelDir(), 'extension.js'), 'utf8')
  return /window\.__nnk__ = \{ version: "[^"]+", build: "([^"]+)"/.exec(code)?.[1] ?? null
}

/** 已安装文件不代表运行代码更新。只在新内核已就绪并报告暂停处理器安装后标记补传暂停生效。 */
export function kernelRuntimeStatus(kernel, bridge) {
  if (!bridge?.online) return 'offline'
  if (kernel?.state !== 'ok' || bridge.kernelVersion !== bundledKernelVersion()
    || bridge.kernelBuild !== bundledKernelBuild() || bridge.transferPaused !== true) return 'restart_required'
  return bridge.bootStage === 'ready' ? 'b0_active' : 'booting'
}
/** 目录内容哈希:相对路径与原始字节，读取失败显式抛出，不接受部分目录。 */
export function hashKernelDir(dir) {
  return kernelContentHash(dir)
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, KERNEL_MANIFEST), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 内核自检:state ok/stale/missing/unknown(语义同 preset;unknown = 插件自带
 * 源不完整,打包异常,此时不能催用户重装)。
 * 状态查询读取实际内容，不用大小/mtime 缓存代替内容验证；安装恢复记录未结案时不报 ok。
 */
export function kernelStatus({ nonameDir, token }) {
  const bundledDir = bundledKernelDir()
  let bundledHash
  try { bundledHash = hashKernelDir(bundledDir) }
  catch (error) { return { state: 'unknown', error: '读取自带内核失败: ' + error.message } }
  if (!bundledHash || !existsSync(join(bundledDir, 'extension.js'))) {
    return { state: 'unknown', error: `插件自带的内核源不完整(缺 extension.js):${bundledDir}` }
  }
  const target = kernelDirOf(nonameDir)
  if (kernelInstallPending(nonameDir)) {
    return { state: 'stale', recoveryPending: true, error: '上次内核安装中断，请关闭游戏后再次安装以恢复。', bundledHash }
  }
  if (!existsSync(target)) {
    return { state: 'missing', bundledHash, installedHash: null, installedAt: null, boundApi: null }
  }
  let installedHash
  try { installedHash = hashKernelDir(target) }
  catch (error) { return { state: 'stale', error: '读取已安装内核失败: ' + error.message, bundledHash } }
  /* 内核心跳绑定在哪个 dsh(装它时写入的 baseUrl)——双 dsh 共管一个游戏目录时,
   * 心跳只发绑定方,另一方会显示离线,这个字段让绑定关系可见 */
  let boundApi = null
  /* token 是否还是本实例的那把:noname-kit.json 损坏被留档重建后会重生成 token,
   * 内核手里仍是老的 → 每一拍心跳都 403、lastSeen 永不刷新,工坊只显示「内核离线」,
   * 用户被引去查"扩展启没启用"(实测关注点)。tokenMatches 让界面能直接给出出路 */
  let tokenMatches = null
  /* 桥配置在不在:内容哈希刻意跳过 nnk-bridge.json(安装时写入、不属于内核内容),
   * 所以它丢了/坏了 state 照样报 ok——而心跳全靠它,表现只有「内核永久离线」,
   * 界面上看不出原因。missing 时给界面一条准确出路(重装内核) */
  let bridgeConfig = 'missing'
  try {
    const bridgeCfg = JSON.parse(readFileSync(join(target, 'nnk-bridge.json'), 'utf8'))
    bridgeConfig = 'ok'
    boundApi = bridgeCfg.baseUrl || null
    if (typeof bridgeCfg.token === 'string' && typeof token === 'string' && token) {
      tokenMatches = bridgeCfg.token === token
    }
  } catch { /* 没装桥配置(未安装/老版本/被删) */ }
  return {
    state: installedHash === bundledHash ? 'ok' : 'stale',
    bundledHash,
    installedHash,
    installedAt: readManifest(target)?.installedAt ?? null,
    boundApi,
    tokenMatches,
    bridgeConfig,
  }
}

/** 文件系统错误 → 人话 + 下一步。安装/重装内核是用户唯一能自救的动作,
 *  只回 EPERM/EBUSY 这种天书等于把用户晾在原地(实测反馈面)。 */
function ioHint(error) {
  const code = error && error.code
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return '(文件被占用/无权限:先完全关闭游戏与杀软实时防护,再点一次「📦 安装内核」重写即可)'
  }
  if (code === 'ENOSPC') return '(磁盘空间不足:清理磁盘后再点一次)'
  return '(可再点一次「📦 安装内核」重试;重复失败请把本条原文发给开发者)'
}

/**
 * 安装/重装内核:旧目录整体备份到游戏根 nnk-kernel-backups/(滚动留 3 份),
 * 在 extension/ 外复制校验并写配置/盖章，然后切换目录；失败恢复或保留明确待恢复记录。装完需重启游戏加载。
 */
export function installKernel({ nonameDir, baseUrl, token, intervalMs }) {
  const result = installKernelFiles({ root: nonameDir, source: bundledKernelDir(), baseUrl, token, intervalMs,
    version: bundledKernelVersion(), build: bundledKernelBuild() })
  if (!result.ok) result.error += ioHint(result)
  return result
}

/**
 * 心跳桥会话(每插件实例一份,内存态,不落盘):
 * 内核轮询时上报状态与事件,取回到期命令;工坊经 pushCommand 下发命令。
 * syncSource:返回希望内核处于的配置({identity:{name,avatar}, mqttUrl}),
 * 内核上报的 cfg 与之不一致时自动补发对应命令,覆盖「保存时游戏没开(命令
 * 60s TTL 内没被取走)」「换游戏目录后新内核副本没配置」两个场景。
 * mqttUrl 只在非空时强制(空 = 不覆盖,跟随各游戏目录自己的值)。
 */
export function createBridgeSession({ token, syncSource }) {
  const session = {
    token,
    lastSeen: 0,
    kernelVersion: null,
    kernelBuild: null,
    transferPaused: false,
    bootStage: null,
    role: '',
    state: null,
    events: [],
    commands: [],
    nextCmdId: 1,
  }
  const lastPushed = {}
  const api = {
    /** 内核每次轮询调用:收事件、刷新在线状态、吐出到期命令。 */
    poll(payload) {
      session.lastSeen = Date.now()
      session.kernelVersion = payload?.kernel?.version ?? session.kernelVersion
      // 不粘滞:换成旧内核/缺字段时立即撤销补传暂停已生效判定。
      session.kernelBuild = typeof payload?.kernel?.build === 'string' ? payload.kernel.build : null
      session.transferPaused = payload?.kernel?.transferPaused === true
      session.bootStage = payload?.kernel?.stage ?? session.bootStage
      /* 按字段更新而非粘滞:新内核每拍都上报 role(空串=当前既非主机也非客人,
       * 是真实状态,取消房间后要能落回空);旧内核(≤0.3.42)不发该字段,保持
       * 原值,工坊靠阶段启发式兜底 */
      if (typeof payload?.kernel?.role === 'string') session.role = payload.kernel.role
      session.state = payload?.state ?? session.state
      session.cfg = payload?.cfg ?? session.cfg
      /* 配置离线补发:同一个值只补一次,内核应用后 cfg 追平即不再发 */
      let want = null
      try { want = typeof syncSource === 'function' ? syncSource() : null } catch { want = null }
      if (want && payload?.cfg) {
        const id = want.identity
        if (id) {
          const key = 'id:' + JSON.stringify(id)
          const nameOk = String(payload.cfg.onlineName || '') === String(id.name || '')
          const avatarOk = String(payload.cfg.onlineAvatar || '') === String(id.avatar || '')
          if ((!nameOk || !avatarOk) && lastPushed.identity !== key) {
            lastPushed.identity = key
            api.pushCommand('set_identity', { name: String(id.name || ''), avatar: String(id.avatar || '') })
          }
        }
        const url = String(want.mqttUrl || '')
        if (url && String(payload.cfg.mqttUrl || '') !== url && lastPushed.mqttUrl !== url) {
          lastPushed.mqttUrl = url
          api.pushCommand('set_config', { key: 'mqttUrl', value: url })
        }
      }
      for (const ev of payload?.events || []) {
        /* 内核拒收人物标识(头像武将本机没有):解除"同一值只补一次"锁——
         * 此前一旦被拒(武将未加载/扩展未启用)就永不重发,工坊却仍显示
         * "已保存"(审计发现)。带 60 秒冷却防拒绝-重发死循环,等武将随
         * 扩展加载后自然重试成功 */
        if (ev && ev.type === 'error' && typeof ev.message === 'string' && ev.message.indexOf('头像武将') >= 0) {
          if (!lastPushed.identityRetryAt || Date.now() - lastPushed.identityRetryAt > 60_000) {
            lastPushed.identityRetryAt = Date.now()
            lastPushed.identity = undefined
          }
        }
        session.events.push(ev)
      }
      if (session.events.length > 200) session.events.splice(0, session.events.length - 200)
      const now = Date.now()
      const due = []
      session.commands = session.commands.filter((cmd) => {
        if (now - cmd.createdAt > COMMAND_TTL_MS) return false
        due.push(cmd)
        return false
      })
      return { commands: due }
    },
    /** 工坊下发命令;返回带 id 的命令对象。 */
    pushCommand(action, args) {
      const cmd = { id: session.nextCmdId++, action, args: args || {}, createdAt: Date.now() }
      session.commands.push(cmd)
      return cmd
    },
    /** 工坊轮询的快照。 */
    snapshot() {
      const now = Date.now()
      const stateFresh = Boolean(session.lastSeen) && now - session.lastSeen < ROOM_STATE_GRACE_MS
      return {
        online: Boolean(session.lastSeen) && now - session.lastSeen < ONLINE_WINDOW_MS,
        lastSeen: session.lastSeen || null,
        kernelVersion: session.kernelVersion,
        kernelBuild: session.kernelBuild,
        transferPaused: session.transferPaused,
        bootStage: session.bootStage,
        /* 角色/房间状态只在心跳还热时下发:游戏关掉后房间随即从工坊消失,
         * 不会永远挂着最后一拍的房号;cfg 保留(身份回填/离线保存仍可用) */
        role: stateFresh ? session.role : '',
        state: stateFresh ? session.state : null,
        cfg: session.cfg,
        events: session.events.slice(-50),
        pending: session.commands.length,
      }
    },
    token,
  }
  return api
}

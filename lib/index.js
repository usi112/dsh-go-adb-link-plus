// local-adb-link — find this phone's Shizuku/Stellar TCP ADB port and keep adb
// connected, so a DSH bash call can use `adb shell` without anyone typing a
// port again.
//
// The phone is reachable because a Shizuku-style manager (Stellar, a Shizuku
// fork) or `adb tcpip <port>` leaves adbd listening over TCP. This plugin:
//   1. probes the remembered port and the usual candidates with the ADB
//      handshake (lib/adb.js, pure Node, no adb binary needed to search);
//   2. falls back to a localhost port scan when a button asks for it;
//   3. runs `adb connect`, waits for the key authorization (the phone shows
//      "允许调试" once), and remembers the port in state.json;
//   4. reconnects on every engine start afterwards, and the shared adb server
//      on 127.0.0.1:5037 is then what bash's `adb` talks to.
import fs from 'node:fs'
import path from 'node:path'

import { findAdbPorts, findOpenPorts, findTlsPorts, probeAdb, probeTls } from './adb.js'
import {
  adbConnect,
  adbConnectAt,
  adbDevices,
  adbDisconnect,
  adbPair,
  adbTcpip,
  installAdb,
  resolveAdb,
  run,
} from './cli.js'
import { loadState, saveState, statePath } from './state.js'

export const name = 'local-adb-quiet'

const KNOWN_PORTS = [3455, 5555]
const PORT_EXCLUDE = [3080, 5037]
const SCAN_START = 1
const SCAN_END = 65535
const SCAN_CONCURRENCY = 400
const SCAN_TIMEOUT_MS = 280
const AUTO_COOLDOWN_MS = 90_000
const AUTH_COOLDOWN_MS = 10 * 60_000
const SCAN_RETRY_MS = 10 * 60_000
const PANEL_POLL_MS = 6_000
const STRIP_POLL_MS = 12_000
const CONNECT_WAIT_MS = 45_000
const CONNECT_WAIT_PENDING_MS = 20_000
// 固定端口：`adb tcpip 3455` 让 adbd 用明文 ADB 监听固定端口，掉线后也能一眼找回。
// 3455 优先于 5555 —— 5555 是 adb 的模拟器约定端口，会在 `adb devices` 里冒出
// `emulator-5554` 幽灵条目，导致不带 -s 的 adb 命令报 more than one device。
const FIX_PORT = 3455
// 配对后找连接端口：Android 把无线调试的连接端口放在高位临时端口区间。
// 实测（28k 端口、3 个 TLS 服务在听）：
//   c300/t250 → 3/3 两次；c400/t250 → 3/3；c600/t200 → 3/3 最快 ~15.5s；c800/t200 → 只有 2/3（会漏）
// 所以并发不要冲高：孤立端口在高并发下会被 proot 用户态网络丢掉。
const PAIR_SCAN_START = 32768
const PAIR_SCAN_END = 60999
const PAIR_SCAN_CONCURRENCY = 300
const PAIR_SCAN_TIMEOUT_MS = 220
// 冷扫一次没命中时的第二次机会（换低并发再扫，绕开偶发丢包）
const PAIR_SCAN_RETRY_CONCURRENCY = 200

// ── copy ──────────────────────────────────────────────────────────────────

const DICT = {
  zh: {
    plugin: 'ADB 自动连接',
    status: {
      connected: '已连接',
      checking: '检查中',
      connecting: '连接中',
      scanning: '扫描端口',
      installing: '安装 adb',
      waiting: '等待授权',
      disconnected: '未连接',
      noadb: '缺 adb 客户端',
    },
    strip: {
      connected: (port) => `ADB · ${port}`,
      checking: 'ADB 检查中…',
      connecting: 'ADB 连接中…',
      scanning: '正在扫描端口…',
      installing: '正在装 adb…',
      waiting: 'ADB 待授权 · 点按',
      disconnected: 'ADB 未连接 · 点按',
      noadb: '缺 adb 客户端 · 点按',
    },
    note: {
      connected: 'ADB 通道已就绪，本机可直接执行 adb 命令。',
      checking: '正在检查 adb 状态…',
      connecting: '正在连接手机上的 ADB 端口…',
      scanning: '正在扫描本机端口，寻找 ADB 服务…',
      installing: '本机缺少 adb 客户端，正在自动安装…',
      waiting: '请在手机上点“允许”，并勾选“始终允许这台计算机”。',
      disconnected: '点“连接”自动找到手机上的 ADB 端口并连上。',
      noadb: '本机没有 adb 客户端，点“连接”会自动安装。',
    },
    key: {
      status: '状态',
      mode: '方式',
      port: '端口',
      endpoint: '端点',
      device: '设备',
      adb: '客户端',
      auto: '自动重连',
      paired: '已配对',
      checked: '检查',
      error: '最近错误',
    },
    mode: { tcpip: `固定 ${FIX_PORT}`, wireless: '无线调试', port: '普通端口', none: '—' },
    pair: {
      title: '无线调试配对',
      host: '地址',
      port: '配对端口',
      code: '配对码',
      submit: '配对并连接',
      hint: '手机上：开发者选项 › 无线调试 ›「使用配对码配对设备」。地址填屏上那个 IP，码是 6 位数字；配对端口可留空，留空时插件自己扫出 TLS 端口再逐个试配对（稍慢）。',
    },
    btn: { connect: '连接', fix: `固定 ${FIX_PORT}`, scan: '扫描端口', disconnect: '断开', copy: '复制命令' },
    hint: '首次连接：在手机上点“允许”并勾选“始终允许这台计算机”，之后每次启动自动重连。',
    on: '开',
    off: '关',
    none: '未找到',
    pending: { connect: '连接 ADB', scan: '扫描 ADB 端口', fix: `固定端口 ${FIX_PORT}`, pair: '无线调试配对' },
    toast: {
      connected: (port) => `ADB 已连接 · ${port}`,
      already: 'ADB 已经连着了',
      unauthorized: '请在手机上点“允许调试”',
      noPort: '没找到 ADB 端口，请确认 Stellar 的 TCP 已开',
      installFailed: '自动安装 adb 失败，请手动安装',
      noAdb: '本机没有 adb 客户端',
      timeout: '连接 ADB 超时，请重试',
      disconnected: '已断开 ADB，不会再自动重连',
      copied: '命令已复制',
      cancelled: '已取消',
      fixed: (port) => `已固定在 ${port}`,
      fixFailed: '固定端口失败：先用「连接」把通道接通',
      fixNeedDevice: '当前没连着设备，先点「连接」',
      pairNeed: '请填地址、配对端口和 6 位配对码',
      pairFailed: '配对失败：端口或配对码不对（配对码一次性，面板每次都会换）',
      pairNoConnect: '配对成功，但没找到连接端口：点「扫描端口」再试',
      paired: (port) => `配对成功 · ${port}`,
      noPortTls: '没找到明文 ADB 端口：无线调试是 TLS，用下面的配对表单',
      noPortTlsScan: '没扫到可连的 adb 端口：无线调试没开、没配对，或不在同一 Wi-Fi',
      tlsScanning: '无线调试是 TLS：正在扫开放端口并逐个用 adb 验证…',
      pairScanning: '没给配对端口：正在扫高位端口并逐个试配对…',
      pairPortEmpty: '配对端口留空：自动扫描',
    },
  },
  en: {
    plugin: 'ADB auto-link',
    status: {
      connected: 'Connected',
      checking: 'Checking',
      connecting: 'Connecting',
      scanning: 'Scanning',
      installing: 'Installing',
      waiting: 'Waiting',
      disconnected: 'Offline',
      noadb: 'No adb client',
    },
    strip: {
      connected: (port) => `ADB · ${port}`,
      checking: 'ADB checking…',
      connecting: 'ADB connecting…',
      scanning: 'Scanning ports…',
      installing: 'Installing adb…',
      waiting: 'ADB needs allow · tap',
      disconnected: 'ADB offline · tap',
      noadb: 'No adb client · tap',
    },
    note: {
      connected: 'The ADB channel is ready; this machine can run adb now.',
      checking: 'Checking the adb state…',
      connecting: 'Connecting to the phone ADB port…',
      scanning: 'Scanning localhost for an ADB service…',
      installing: 'The adb client is missing; installing it…',
      waiting: 'Tap “Allow” and tick “Always allow from this computer”.',
      disconnected: 'Tap “Connect” to find the phone ADB port and link it.',
      noadb: 'No adb client on this machine; “Connect” installs it.',
    },
    key: {
      status: 'State',
      mode: 'Mode',
      port: 'Port',
      endpoint: 'Endpoint',
      device: 'Device',
      adb: 'Client',
      auto: 'Reconnect',
      paired: 'Paired',
      checked: 'Checked',
      error: 'Last error',
    },
    mode: { tcpip: `Fixed ${FIX_PORT}`, wireless: 'Wireless', port: 'Plain port', none: '—' },
    pair: {
      title: 'Wireless pairing',
      host: 'Address',
      port: 'Pair port',
      code: 'Pair code',
      submit: 'Pair and connect',
      hint: 'Phone: Developer options › Wireless debugging › “Pair device with pairing code”. Use that IP and the 6 digits; leave the pair port empty and the plugin scans for the TLS port itself.',
    },
    btn: { connect: 'Connect', fix: `Fix ${FIX_PORT}`, scan: 'Scan ports', disconnect: 'Disconnect', copy: 'Copy command' },
    hint: 'First time: tap “Allow” and tick “Always allow” on the phone; then it reconnects by itself.',
    on: 'on',
    off: 'off',
    none: 'not found',
    pending: { connect: 'Connecting ADB', scan: 'Scanning ADB ports', fix: `Fixing port ${FIX_PORT}`, pair: 'Pairing' },
    toast: {
      connected: (port) => `ADB connected · ${port}`,
      already: 'ADB is already connected',
      unauthorized: 'Tap “Allow” in the dialog on the phone',
      noPort: 'No ADB port found; check Stellar TCP debugging',
      installFailed: 'Could not install adb; install it manually',
      noAdb: 'No adb client on this machine',
      timeout: 'ADB connect timed out; try again',
      disconnected: 'ADB disconnected; auto-reconnect is off',
      copied: 'Command copied',
      cancelled: 'Cancelled',
      fixed: (port) => `Fixed on ${port}`,
      fixFailed: 'Could not fix the port: connect first',
      fixNeedDevice: 'No device right now; tap Connect first',
      pairNeed: 'Fill in the address, pair port and the 6-digit code',
      pairFailed: 'Pairing failed: wrong port or code (the code changes every time)',
      pairNoConnect: 'Paired, but no connect port found; run Scan ports',
      paired: (port) => `Paired · ${port}`,
      noPortTls: 'No plaintext ADB port: wireless debugging is TLS, use the form below',
      noPortTlsScan: 'No reachable adb port: wireless debugging is off, unpaired, or another Wi-Fi',
      tlsScanning: 'Wireless debugging is TLS: scanning open ports and checking each with adb…',
      pairScanning: 'No pair port given: scanning high ports and trying to pair…',
      pairPortEmpty: 'Pair port empty: scan automatically'
    },
  },
}

const dict = (locale) => (String(locale ?? '').toLowerCase().startsWith('en') ? DICT.en : DICT.zh)

// ── runtime state ─────────────────────────────────────────────────────────

/** `busy` is the in-progress step shown before the device list catches up. */
const rt = { busy: null, snapshot: null, lastKnown: null, snapshotAt: 0, inflight: null, lastAutoAt: 0, lastScanAt: 0 }
const listeners = new Set()

function bump() {
  for (const callback of [...listeners]) {
    try { callback() } catch {}
  }
}

function subscribeLive(callback) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

function invalidate() {
  rt.snapshot = null
  rt.snapshotAt = 0
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

const portOf = (serial) => {
  const match = /:(\d+)$/.exec(String(serial))
  const port = match ? Number(match[1]) : NaN
  return Number.isInteger(port) && port > 0 ? port : null
}

const isTcpSerial = (serial) => /:\d+$/.test(serial) && !String(serial).startsWith('emulator-')

/** Host part of a TCP serial (`192.168.1.20:44000` → `192.168.1.20`). */
function peerOf(serial) {
  const text = String(serial ?? '')
  const at = text.lastIndexOf(':')
  return at > 0 ? text.slice(0, at) : '127.0.0.1'
}

/** How this link was made, for the panel: fixed tcpip port vs wireless pair vs plain. */
function modeOf(serial, port) {
  if (port === FIX_PORT) return 'tcpip'
  return peerOf(serial) !== '127.0.0.1' ? 'wireless' : 'port'
}

/** `adb pair` keeps its trust record here; its presence means pairing already happened. */
function hasPairingKey() {
  try {
    return fs.existsSync(path.join(process.env.HOME || '/root', '.android', 'adb_known_hosts.pb'))
  } catch {
    return false
  }
}

/**
 * Wait until `<host>:<port>` shows up as a device. Returns
 * `{ ok, device?, serial?, unauthorized? }`; never throws.
 */
/**
 * Open ports in `[start, end]`, then keep only the ones that complete a TLS
 * handshake. Wireless debugging's pairing port and connect port are both TLS and
 * both invisible to the plaintext ADB handshake.
 */
async function tlsCandidates(host, { signal, want = 3, start = PAIR_SCAN_START, end = PAIR_SCAN_END } = {}) {
  // 快速路径：端口没变时不需要扫描
  //   ① 上次连上的 TLS 端口（state.tlsPort）
  //   ② 已连接设备上的 service.adb.tls.port（无线调试打开时由 adbd 写入，精确值）
  // 先试缓存那一个（几乎零成本，不用碰 adb）；不通再问设备属性
  const stored = loadState()
  if (Number.isInteger(stored.tlsPort) && stored.tlsPort > 0 && (await probeTls(stored.tlsPort, { host }))) {
    return [stored.tlsPort]
  }
  const devicePort = await deviceTlsPortHint()
  if (devicePort && (await probeTls(devicePort, { host }))) return [devicePort]

  // 扫到 want 个 TLS 候选就停：无线调试端口是随机的，平均能省一半时间
  const scanOnce = (concurrency, want = 2) => findTlsPorts({
    host,
    start,
    end,
    concurrency,
    timeoutMs: PAIR_SCAN_TIMEOUT_MS,
    want,
    chunkSize: 4096,
    exclude: PORT_EXCLUDE,
    signal,
  })

  const first = await scanOnce(PAIR_SCAN_CONCURRENCY, want)
  if (first.length > 0 || signal?.aborted) return first
  // 一次没命中就换低并发再扫一遍：并发冲高时孤立端口会被内核/proot 丢掉（实测 c800 会漏）
  const retry = await scanOnce(PAIR_SCAN_RETRY_CONCURRENCY, want)
  if (retry.length > 0 || signal?.aborted) return retry
  // 最后兜底：TLS 判定可能因为 adbd 的握手细节（SNI / 证书）失手，
  // 所以扫不到 TLS 端口时，把开放端口原样交给调用方去试 adb connect（限 8 个）。
  return (await findOpenPorts({
    host,
    start,
    end,
    concurrency: PAIR_SCAN_RETRY_CONCURRENCY,
    timeoutMs: PAIR_SCAN_TIMEOUT_MS,
    exclude: PORT_EXCLUDE,
    signal,
  })).slice(0, 8)
}

/**
 * `service.adb.tls.port` from the device we already hold: when wireless debugging
 * is on, adbd publishes the exact TLS port there, so no scan is needed.
 */
async function deviceTlsPortHint() {
  const adb = resolveAdb()
  if (!adb) return null
  const snap = await snapshot({ ttl: 5_000 })
  if (snap.kind !== 'connected' || !snap.serial) return null
  const result = await run(adb, ['-s', snap.serial, 'shell', 'getprop', 'service.adb.tls.port'], { timeoutMs: 4_000 })
  const port = Number(String(result.stdout ?? '').trim())
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** Hosts worth trying: the remembered one, then loopback. */
function scanHosts(stored) {
  return [...new Set([stored.host, '127.0.0.1'].filter(Boolean))]
}

async function waitForDevice(host, port, waitMs) {
  const adb = resolveAdb()
  const deadline = Date.now() + Math.max(1_000, waitMs)
  let unauthorized = false
  while (Date.now() < deadline) {
    const devices = adb ? await adbDevices(adb) : []
    const mine = devices.find((device) => portOf(device.serial) === port && peerOf(device.serial) === host)
    if (mine && mine.state === 'device') {
      return {
        ok: true,
        serial: mine.serial,
        device: [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial,
      }
    }
    if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) unauthorized = true
    await sleep(900)
  }
  return { ok: false, unauthorized }
}

function pickDevice(devices, port) {
  const tcp = devices.filter((device) => isTcpSerial(device.serial))
  if (port) {
    const exact = tcp.find((device) => portOf(device.serial) === port)
    if (exact) return exact
  }
  return tcp.find((device) => device.state === 'device')
    ?? tcp.find((device) => device.state === 'unauthorized' || device.state === 'authorizing')
    ?? null
}

function clockOf(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * One read of "what does adb look like right now". Cached briefly so the strip
 * and the panel polling do not each spawn a client.
 */
async function snapshot({ ttl = 1500 } = {}) {
  const now = Date.now()
  if (rt.snapshot !== null && now - rt.snapshotAt < ttl) return rt.snapshot
  const stored = loadState()
  const adb = resolveAdb()
  const out = {
    kind: 'disconnected',
    adb,
    port: stored.port,
    host: stored.host || '',
    mode: stored.mode || '',
    paired: hasPairingKey(),
    serial: null,
    device: '',
    at: now,
    auto: stored.auto !== false,
    authorized: stored.authorized === true,
    busy: rt.busy,
  }
  try {
    const devices = adb ? await adbDevices(adb) : []
    const mine = pickDevice(devices, stored.port)
    if (mine && mine.state === 'device') {
      out.kind = 'connected'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
      out.host = peerOf(mine.serial)
      out.mode = modeOf(mine.serial, out.port)
      out.device = [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial
    } else if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      out.kind = 'waiting-auth'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
    } else if (!adb) {
      out.kind = rt.busy ?? 'no-adb'
    } else {
      out.kind = rt.busy ?? 'disconnected'
    }
  } catch {
    if (!adb) out.kind = 'no-adb'
  }
  rt.snapshot = out
  rt.lastKnown = out
  rt.snapshotAt = now
  return out
}

// ── connecting ────────────────────────────────────────────────────────────

async function discoverPort(stored, { scan, signal }) {
  const candidates = [...new Set([stored.port, ...KNOWN_PORTS].filter((port) => Number.isInteger(port)))]
  for (const port of candidates) {
    if (signal?.aborted) return null
    if (await probeAdb(port, { timeoutMs: 700 })) return port
  }
  if (!scan) return null
  rt.busy = 'scanning'
  bump()
  invalidate()
  const found = await findAdbPorts({
    candidatePorts: candidates,
    start: SCAN_START,
    end: SCAN_END,
    concurrency: SCAN_CONCURRENCY,
    timeoutMs: SCAN_TIMEOUT_MS,
    exclude: PORT_EXCLUDE,
    signal,
  })
  return found[0] ?? null
}

/**
 * Ensure adb exists, find the phone's adbd if it does, connect, and wait for
 * the key to be authorized. Resolves to a plain result, never throws.
 */
async function doConnect({ scan = true, install = true, waitMs = CONNECT_WAIT_MS, signal } = {}) {
  let adb = resolveAdb()
  if (!adb && install) {
    rt.busy = 'installing'
    bump()
    invalidate()
    const installed = await installAdb({ signal })
    adb = resolveAdb()
    if (!adb) return { ok: false, reason: 'install-failed', detail: installed.detail }
  }
  if (!adb) return { ok: false, reason: 'no-adb' }

  const before = await snapshot({ ttl: 0 })
  if (before.kind === 'connected') {
    saveState({
      port: before.port,
      host: before.host || peerOf(before.serial),
      mode: before.mode || modeOf(before.serial, before.port),
      authorized: true,
      lastAt: Date.now(),
      authWaitUntil: 0,
      lastError: '',
    })
    return { ok: true, already: true, port: before.port, device: before.device }
  }

  const stored = loadState()
  const port = await discoverPort(stored, { scan, signal })
  if (port === null) return { ok: false, reason: 'no-port' }

  rt.busy = 'connecting'
  bump()
  invalidate()
  const connected = await adbConnect(port, { signal })

  const deadline = Date.now() + waitMs
  let sawUnauthorized = false
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    const devices = await adbDevices(adb)
    const mine = pickDevice(devices, port)
    if (mine && mine.state === 'device') {
      saveState({
        port,
        host: peerOf(mine.serial),
        mode: modeOf(mine.serial, port),
        authorized: true,
        auto: true,
        lastAt: Date.now(),
        authWaitUntil: 0,
        lastError: '',
      })
      invalidate()
      return {
        ok: true,
        port,
        device: [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial,
      }
    }
    if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      sawUnauthorized = true
      if (rt.busy !== 'waiting-auth') {
        rt.busy = 'waiting-auth'
        bump()
        invalidate()
      }
    }
    await sleep(1200)
  }

  if (sawUnauthorized) {
    saveState({ port, authorized: false, lastAt: Date.now(), authWaitUntil: Date.now() + AUTH_COOLDOWN_MS, lastError: 'unauthorized' })
    return { ok: false, reason: 'unauthorized', port }
  }
  saveState({ lastAt: Date.now(), lastError: connected.ok ? 'no-device' : 'connect-failed' })
  return { ok: false, reason: 'timeout', port, detail: connected.detail }
}

/** Run one connect at a time; concurrent callers share the same attempt. */
function connectOnce(options) {
  if (rt.inflight) return rt.inflight
  rt.inflight = doConnect(options)
    .catch((error) => ({ ok: false, reason: 'error', detail: String(error?.message ?? error) }))
    .finally(() => {
      rt.inflight = null
      rt.busy = null
      invalidate()
      bump()
    })
  return rt.inflight
}

/** Record a live connection found by polling, so the next start reconnects. */
function remember(snap) {
  if (snap.kind !== 'connected' || !snap.port) return
  const stored = loadState()
  const host = snap.host || peerOf(snap.serial)
  const mode = snap.mode || modeOf(snap.serial, snap.port)
  if (stored.port === snap.port && stored.authorized === true && stored.host === host && stored.mode === mode) return
  saveState({ port: snap.port, host, mode, authorized: true, authWaitUntil: 0, lastError: '' })
  invalidate()
}

/** Reconnect silently after an engine start, or when a feed mounts. */
function maybeAutoConnect() {
  const now = Date.now()
  if (now - rt.lastAutoAt < AUTO_COOLDOWN_MS) return
  rt.lastAutoAt = now
  const stored = loadState()
  if (stored.auto === false) return
  if (now < stored.authWaitUntil) return
  if (rt.inflight) return
  if (!resolveAdb()) return
  connectOnce({ scan: false, install: false, waitMs: 6_000 }).then((result) => {
    // The saved port is gone but the phone was paired before: the port may have
    // moved (reboot / Stellar restart). Look for it again, at most every 10 min.
    if (result?.ok || result?.reason !== 'no-port') return
    if (loadState().authorized !== true) return
    if (Date.now() - rt.lastScanAt < SCAN_RETRY_MS) return
    rt.lastScanAt = Date.now()
    connectOnce({ scan: true, install: false, waitMs: 6_000 }).catch(() => {})
  }).catch(() => {})
}

// ── effects ───────────────────────────────────────────────────────────────

function patchFor(result, locale) {
  const d = dict(locale)
  if (result.ok) {
    const stored = loadState()
    const mode = stored.mode ? (d.mode[stored.mode] ?? d.mode.none) : d.mode.none
    const host = stored.host || '127.0.0.1'
    return {
      note: d.note.connected,
      tone: 'good',
      status: d.status.connected,
      mode,
      port: String(result.port ?? '—'),
      endpoint: result.port ? `${host}:${result.port}` : '—',
      device: result.device || '—',
      adb: resolveAdb() || d.none,
      paired: hasPairingKey() ? d.on : d.off,
      auto: d.on,
      error: '—',
      checked: clockOf(Date.now()),
    }
  }
  const reason = result.reason
  const patch = { checked: clockOf(Date.now()) }
  if (reason === 'unauthorized') {
    Object.assign(patch, { note: d.note.waiting, tone: 'warn', status: d.status.waiting, port: String(result.port ?? '—') })
  } else if (reason === 'no-port') {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  } else if (reason === 'no-adb' || reason === 'install-failed') {
    Object.assign(patch, { note: d.note.noadb, tone: 'bad', status: d.status.noadb, adb: d.none })
  } else {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  }
  return patch
}

function toastFor(result, locale) {
  const t = dict(locale).toast
  switch (result.reason) {
    case 'unauthorized': return t.unauthorized
    case 'no-port': return t.noPort
    case 'no-adb': return t.noAdb
    case 'install-failed': return t.installFailed
    case 'cancelled': return t.cancelled
    default: return t.timeout
  }
}

function connectHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.connect, timeoutMs: 58_000 },
    result: async (signal) => {
      const result = await connectOnce({ scan: true, install: true, waitMs: CONNECT_WAIT_PENDING_MS, signal })
      if (result.ok) {
        return { toast: result.already ? d.toast.already : d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
      }
      return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
    },
  }
}

function scanHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.scan, timeoutMs: 58_000 },
    result: async (signal) => {
      try {
        const stored = loadState()
        rt.busy = 'scanning'
        bump()
        invalidate()
        const found = await findAdbPorts({
          candidatePorts: [stored.port, ...KNOWN_PORTS].filter(Boolean),
          start: SCAN_START,
          end: SCAN_END,
          concurrency: SCAN_CONCURRENCY,
          timeoutMs: SCAN_TIMEOUT_MS,
          exclude: PORT_EXCLUDE,
          signal,
        })
        if (found.length === 0) {
          // 明文握手一个都没回：安卓 11+ 无线调试是 TLS，改扫开放端口 + TLS 判定 + adb 验证
          for (const host of scanHosts(stored)) {
            if (signal?.aborted) break
            const ports = await tlsCandidates(host, { signal })
            for (const port of ports) {
              if (signal?.aborted) break
              await adbConnectAt(host, port, { timeoutMs: 5_000, signal })
              const linked = await waitForDevice(host, port, 3_000)
              if (!linked.ok) continue
              saveState({
                port,
                host,
                tlsPort: port,
                mode: 'wireless',
                authorized: true,
                auto: true,
                lastAt: Date.now(),
                authWaitUntil: 0,
                lastError: '',
              })
              rt.busy = null
              invalidate()
              bump()
              return {
                toast: d.toast.connected(port),
                patch: patchFor({ ok: true, port, device: linked.device }, event?.locale),
              }
            }
          }
          rt.busy = null
          invalidate()
          return { toast: d.toast.noPortTlsScan, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
        }
        saveState({ port: found[0] })
        const result = await connectOnce({ scan: false, install: false, waitMs: 15_000, signal })
        if (result.ok) return { toast: d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
        return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
      } finally {
        rt.busy = null
        invalidate()
        bump()
      }
    },
  }
}

async function disconnectHandler(scope, event) {
  const d = dict(event?.locale)
  const stored = loadState()
  const live = await snapshot({ ttl: 0 })
  if (live.serial) {
    // Disconnect the endpoint we actually hold (127.0.0.1 or a LAN host), not a
    // guessed one; otherwise a stale transport survives and `adb devices` keeps it.
    const adb = resolveAdb()
    if (adb) await run(adb, ['disconnect', live.serial], { timeoutMs: 2_400 })
  } else {
    await adbDisconnect(stored.port, { timeoutMs: 2_400 })
  }
  saveState({ auto: false, authWaitUntil: 0, lastError: '' })
  invalidate()
  const snap = await snapshot({ ttl: 0 })
  return {
    toast: d.toast.disconnected,
    patch: {
      note: d.note.disconnected,
      tone: 'muted',
      status: d.status.disconnected,
      auto: d.off,
      port: snap.port ? String(snap.port) : '—',
      checked: clockOf(Date.now()),
    },
  }
}

function copyHandler(scope, event) {
  const d = dict(event?.locale)
  const stored = loadState()
  const port = stored.port ?? KNOWN_PORTS[0]
  const host = stored.host || '127.0.0.1'
  return {
    copy: `export HOME=/root; adb connect ${host}:${port}\n`,
    toast: d.toast.copied,
  }
}

/**
 * Pin the link on `adb tcpip 3455`: adbd restarts in plaintext TCP mode on that
 * fixed port, so the next reconnect is a single `adb connect` instead of a
 * 65k-port scan. 5555 is deliberately not used — adb treats it as the emulator
 * port and adds an `emulator-5554` ghost that breaks `adb` without `-s`.
 */
function fixHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.fix, timeoutMs: 58_000 },
    result: async (signal) => {
      const snap = await snapshot({ ttl: 0 })
      if (snap.kind !== 'connected' || !snap.serial) {
        return { toast: d.toast.fixNeedDevice, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
      }
      const previous = snap.serial
      rt.busy = 'connecting'
      bump()
      invalidate()
      const switched = await adbTcpip(FIX_PORT, { serial: previous, signal })
      if (!switched.ok) {
        rt.busy = null
        invalidate()
        bump()
        return { toast: d.toast.fixFailed, patch: patchFor({ ok: false, reason: 'timeout' }, event?.locale) }
      }
      // adbd is restarting: wait for the fixed port to answer the handshake.
      let ready = false
      for (let i = 0; i < 30; i += 1) {
        if (signal?.aborted) break
        if (await probeAdb(FIX_PORT, { timeoutMs: 700 })) { ready = true; break }
        await sleep(600)
      }
      await adbDisconnect(portOf(previous), { timeoutMs: 2_400 })
      if (ready) await adbConnect(FIX_PORT, { signal })
      const linked = await waitForDevice('127.0.0.1', FIX_PORT, 15_000)
      rt.busy = null
      invalidate()
      bump()
      if (linked.ok) {
        saveState({
          port: FIX_PORT,
          host: '127.0.0.1',
          mode: 'tcpip',
          authorized: true,
          auto: true,
          lastAt: Date.now(),
          authWaitUntil: 0,
          lastError: '',
        })
        return {
          toast: d.toast.fixed(FIX_PORT),
          patch: patchFor({ ok: true, port: FIX_PORT, device: linked.device }, event?.locale),
        }
      }
      return {
        toast: d.toast.fixFailed,
        patch: patchFor({ ok: false, reason: linked.unauthorized ? 'unauthorized' : 'timeout' }, event?.locale),
      }
    },
  }
}

/** Pull the form fields out of whatever shape the app hands the submit action. */
function pairInputOf(event) {
  const bag = {}
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
    for (const key of ['pairHost', 'pairPort', 'pairCode', 'host', 'port', 'code']) {
      const value = obj[key]
      if (value !== undefined && value !== null && String(value).trim() !== '') bag[key] = String(value).trim()
    }
  }
  collect(event?.value)
  collect(event?.value?.data)
  collect(event?.value?.fields)
  collect(event?.data)
  collect(event?.fields)
  const code = String(bag.pairCode || bag.code || '').replace(/\D/g, '').slice(0, 6)
  const port = Number(bag.pairPort || bag.port || 0)
  return { host: bag.pairHost || bag.host || '', port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0, code }
}

/**
 * Android 11+ wireless debugging is TLS: the plaintext handshake cannot see it,
 * so pairing needs the phone's pair port + 6-digit code, then a scan for the
 * (different, random) connect port with `adb connect` as the only judge.
 */
function pairHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.pair, timeoutMs: 58_000 },
    result: async (signal) => {
      const stored = loadState()
      const input = pairInputOf(event)
      const host = input.host || stored.host || ''
      if (!host || !/^\d{6}$/.test(input.code)) {
        return { toast: d.toast.pairNeed }
      }
      rt.busy = 'connecting'
      bump()
      invalidate()

      // 配对端口可以留空：无线调试的两个端口都是 TLS，扫高位端口段逐个试配对。
      // 配对码只对真正那个配对端口有效，所以「试」是安全的，失败不会配对错设备。
      let pairPort = input.port
      if (!pairPort) {
        const candidates = await tlsCandidates(host, { signal })
        for (const port of candidates) {
          if (signal?.aborted) break
          const attempt = await adbPair({ host, port, code: input.code, signal })
          if (attempt.ok) { pairPort = port; break }
        }
      } else {
        const paired = await adbPair({ host, port: pairPort, code: input.code, signal })
        if (!paired.ok) pairPort = null
      }

      if (!pairPort) {
        rt.busy = null
        invalidate()
        bump()
        return { toast: d.toast.pairFailed, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
      }

      // 配对成功后连接端口是另一个（也是 TLS），逐个 adb connect 验证。
      const ports = await tlsCandidates(host, { signal })
      for (const port of ports) {
        if (signal?.aborted) break
        if (port === pairPort) continue
        await adbConnectAt(host, port, { timeoutMs: 6_000, signal })
        const linked = await waitForDevice(host, port, 3_500)
        if (!linked.ok) continue
        saveState({
          port,
          host,
          tlsPort: port,
          mode: 'wireless',
          authorized: true,
          auto: true,
          lastAt: Date.now(),
          authWaitUntil: 0,
          lastError: '',
        })
        rt.busy = null
        invalidate()
        bump()
        return {
          toast: d.toast.paired(port),
          patch: patchFor({ ok: true, port, device: linked.device }, event?.locale),
        }
      }
      rt.busy = null
      invalidate()
      bump()
      return { toast: d.toast.pairNoConnect, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
    },
  }
}

// ── views ─────────────────────────────────────────────────────────────────

function stripTextFor(snap, locale) {
  const s = dict(locale).strip
  switch (snap.kind) {
    case 'connected': return s.connected(snap.port ?? '')
    case 'waiting-auth': return s.waiting
    case 'connecting': return s.connecting
    case 'scanning': return s.scanning
    case 'installing': return s.installing
    case 'no-adb': return s.noadb
    default: return s.disconnected
  }
}

function stripToneFor(snap) {
  switch (snap.kind) {
    case 'connected': return 'good'
    case 'waiting-auth': return 'warn'
    case 'no-adb': return 'bad'
    case 'connecting':
    case 'scanning':
    case 'installing':
    case 'checking': return 'info'
    default: return 'muted'
  }
}

function stripDataFor(snap, locale) {
  // 未连接时不占输入框上方那一行：整条状态条隐藏，只在真的连上或等你授权时出现。
  if (snap.kind === 'disconnected' || snap.kind === 'checking') return null
  const text = stripTextFor(snap, locale)
  if (!text) return null
  return { text, icon: 'terminal', tone: stripToneFor(snap) }
}

function statusTextFor(snap, locale) {
  const st = dict(locale).status
  switch (snap.kind) {
    case 'connected': return st.connected
    case 'waiting-auth': return st.waiting
    case 'connecting': return st.connecting
    case 'scanning': return st.scanning
    case 'installing': return st.installing
    case 'no-adb': return st.noadb
    case 'checking': return st.checking
    default: return st.disconnected
  }
}

function noteFor(snap, locale) {
  const note = dict(locale).note
  switch (snap.kind) {
    case 'connected': return note.connected
    case 'waiting-auth': return note.waiting
    case 'connecting': return note.connecting
    case 'scanning': return note.scanning
    case 'installing': return note.installing
    case 'no-adb': return note.noadb
    case 'checking': return note.checking
    default: return note.disconnected
  }
}

function panelDataFor(snap, locale) {
  const d = dict(locale)
  const stored = loadState()
  const mode = snap.mode || stored.mode
  const host = snap.host || stored.host
  return {
    note: noteFor(snap, locale),
    tone: stripToneFor(snap),
    status: statusTextFor(snap, locale),
    mode: mode ? (d.mode[mode] ?? d.mode.none) : d.mode.none,
    port: snap.port ? String(snap.port) : '—',
    endpoint: snap.serial || (snap.port ? `${host || '127.0.0.1'}:${snap.port}` : '—'),
    device: snap.device || '—',
    adb: snap.adb || d.none,
    paired: snap.paired ? d.on : d.off,
    auto: snap.auto ? d.on : d.off,
    error: stored.lastError ? stored.lastError : '—',
    checked: snap.at ? clockOf(snap.at) : '—',
  }
}

function buildView(locale) {
  const d = dict(locale)
  return {
    v: 2,
    type: 'stack',
    children: [
      { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.tone' } },
      {
        type: 'keyValue',
        items: [
          [d.key.status, { $: 'data.status' }],
          [d.key.mode, { $: 'data.mode' }],
          [d.key.port, { $: 'data.port' }],
          [d.key.endpoint, { $: 'data.endpoint' }],
          [d.key.device, { $: 'data.device' }],
          [d.key.paired, { $: 'data.paired' }],
          [d.key.adb, { $: 'data.adb' }],
          [d.key.auto, { $: 'data.auto' }],
          [d.key.error, { $: 'data.error' }],
          [d.key.checked, { $: 'data.checked' }],
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.connect, action: 'connect', icon: 'refresh', style: 'primary' },
          { label: d.btn.fix, action: 'fix', icon: 'pin' },
          { label: d.btn.disconnect, action: 'disconnect', icon: 'link' },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.scan, action: 'scan', icon: 'search' },
          { label: d.btn.copy, action: 'copy', icon: 'copy' },
        ],
      },
      {
        type: 'form',
        label: d.pair.title,
        submitLabel: d.pair.submit,
        submit: { id: 'pair', args: {} },
        children: [
          { type: 'textField', label: d.pair.host, bind: 'data.pairHost', placeholder: '192.168.1.20' },
          { type: 'textField', label: d.pair.port, bind: 'data.pairPort', placeholder: '44285', pattern: 'integer' },
          { type: 'textField', label: d.pair.code, bind: 'data.pairCode', placeholder: '902415', pattern: 'integer' },
        ],
      },
      { type: 'text', text: d.pair.hint, tone: 'muted' },
      { type: 'text', text: d.hint, tone: 'muted' },
    ],
  }
}

// ── prompt injection ───────────────────────────────────────────────────────

/**
 * System-prompt section the harness shows while this plugin is loaded. It is
 * what makes the channel *proactive*: once adb is connected, the agent is told
 * which jobs are worth doing through adb instead of detouring.
 */
function adbPromptText() {
  const snap = rt.lastKnown ?? rt.snapshot
  const connected = snap !== null && snap.kind === 'connected'
  const where = connected && snap.port ? `（127.0.0.1:${snap.port}）` : ''
  const fixed = connected && snap?.mode === 'tcpip'
  const head = connected
    ? `本机是 DSH Go 手机，ADB 通道已由「ADB 自动连接」插件连好${where}，bash 里可直接运行 adb 命令，也可以调用 adb 工具（参数更结构化）。${fixed ? `通道用的是 adb tcpip 固定端口 ${FIX_PORT}；手机重启后要恢复，先在插件面板点「固定 ${FIX_PORT}」。` : ''}`
    : '本机是 DSH Go 手机，装有「ADB 自动连接」插件（后台保持 adb 通道）；需要系统级操作时先用 adb devices 确认，不通再让用户到插件面板点「连接」。'
  return [
    head,
    '当任务需要普通 bash 或手机操控做不到、或明显更费劲的系统级操作时，主动使用 adb，不要先问用户要不要用 adb：',
    'appops/运行时权限、安装卸载 APK、读取 /data 或受保护数据、截图录屏、模拟点击和输入、查询进程/电量/网络/温度、改系统设置、uiautomator dump。',
    '登录、支付、验证码、删除等敏感操作仍按原有规则先向用户确认。',
  ].join('\n')
}

// ── adb tool ───────────────────────────────────────────────────────────────

const TOOL_CLIP = 12_000
const TOOL_TIMEOUT_MS = 30_000
const TOOL_MAX_TIMEOUT_MS = 120_000

const ADB_TOOL_DESCRIPTION = [
  '在 DSH 手机的 ADB 通道上执行 adb 命令；插件会保持连接，连不上时先自动重连一次。',
  '当任务需要普通 bash 做不到、或明显更费劲的系统级操作时主动使用，不要先问用户要不要用：',
  'appops/运行时权限、安装卸载 APK、读取 /data 或受保护数据、截图录屏（exec-out screencap -p）、模拟点击输入（input tap/text）、查询进程/电量/网络/温度、改系统设置、uiautomator dump。',
  'args 原样传给 adb，不经过 shell：例如 ["shell","pm","list","packages"]、["shell","appops","get","<包名>","REQUEST_INSTALL_PACKAGES"]、["devices","-l"]。',
  '登录、支付、验证码、删除等敏感操作仍要先向用户确认。',
].join('\n')

function clipToolText(text, max = TOOL_CLIP) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`
}

function adbFailure(reason) {
  switch (reason) {
    case 'no-adb': return '本机没有 adb 客户端：先运行 apt-get install -y adb，或打开插件面板点「连接」自动安装。'
    case 'no-port': return '没找到手机的 ADB 端口：让用户打开插件面板点「扫描端口」或确认 Stellar/无线调试的 TCP 已开启。'
    case 'unauthorized': return '手机还没授权调试：让用户到插件面板点「连接」，并在手机弹窗点「允许」。'
    default: return 'ADB 连接失败：让用户打开插件面板重试「连接」。'
  }
}

/** One registry-ready definition; a factory so registration can retry under a fallback name. */
function adbToolDefinition(toolName) {
  return {
    name: toolName,
    description: ADB_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: '一句话说明这条 adb 命令要做什么（显示在界面上）。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '原样传给 adb 的参数数组，不经过 shell。',
        },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000。' },
      },
      required: ['description', 'args'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'number' },
          command: { type: 'string' },
          device: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['exitCode', 'command', 'device', 'stdout', 'stderr'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `$ ${value.command}`,
          value.device ? `设备：${value.device}` : '',
          value.stdout.trimEnd(),
          value.stderr ? `[stderr] ${value.stderr.trimEnd()}` : '',
          `exit ${value.exitCode}`,
        ].filter(Boolean).join('\n'),
      }],
      presentationMeta: (_args, value) => ({
        'dsh-go/view': {
          type: 'stack',
          title: 'ADB',
          children: [
            {
              type: 'keyValue',
              items: [
                ['命令', value.command],
                ['退出码', String(value.exitCode)],
                ['设备', value.device || '—'],
              ],
            },
            { type: 'text', text: (value.stdout || value.stderr || '（无输出）').slice(0, 1500), tone: 'muted' },
          ],
        },
      }),
    },
    presentCall: (args) => ({ card: 'generic', title: 'adb', rawInput: args }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const adbArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : []
      const command = ['adb', ...adbArgs].join(' ')
      if (adbArgs.length === 0) {
        return { exitCode: -1, command, device: '', stdout: '', stderr: 'args 不能为空。' }
      }
      const adb = resolveAdb()
      if (!adb) {
        return { exitCode: -1, command, device: '', stdout: '', stderr: adbFailure('no-adb') }
      }
      let snap = await snapshot({ ttl: 1000 })
      if (snap.kind !== 'connected') {
        const linked = await connectOnce({ scan: false, install: false, waitMs: 8000 })
        if (!linked.ok) {
          return { exitCode: -1, command, device: '', stdout: '', stderr: adbFailure(linked.reason) }
        }
        snap = await snapshot({ ttl: 0 })
      }
      const timeoutMs = Number.isFinite(args.timeoutMs)
        ? Math.min(TOOL_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(args.timeoutMs)))
        : TOOL_TIMEOUT_MS
      const result = await run(adb, adbArgs, { timeoutMs, signal: exec?.signal })
      const stderr = [
        result.error ? String(result.error.message ?? result.error) : '',
        result.killed ? '命令超时被终止。' : '',
        result.stderr ? clipToolText(result.stderr) : '',
      ].filter(Boolean).join('\n')
      return {
        exitCode: typeof result.code === 'number' ? result.code : -1,
        command,
        device: snap.device || snap.serial || '',
        stdout: clipToolText(result.stdout),
        stderr,
      }
    },
  }
}

// ── plugin ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // Not dsh-go-specific: any harness host that mounts systemPrompt gets the
  // guidance; without the bridge the plugin simply has no native surfaces.
  ctx.inject(['systemPrompt'], (scope) => {
    const bashOrder = scope.systemPrompt.getSectionOrder('TOOL_BASH')
    scope.systemPrompt.section({
      name: 'adb-link:prompt',
      order: Number.isFinite(bashOrder) ? bashOrder + 5 : 1005,
      interpolate: false,
      text: () => adbPromptText(),
    })
  })

  ctx.inject(['tools'], (scope) => {
    try {
      scope.tools.register(adbToolDefinition('adb'))
    } catch {
      // Another plugin owns "adb"; keep the capability under a fallback name.
      try { scope.tools.register(adbToolDefinition('adb_shell')) } catch {}
    }
  })

  ctx.inject(['dshGo'], (ctx) => {
    const startData = (emit, caps, isPanel) => {
      const locale = caps?.locale ?? ''
      let alive = true
      const push = async () => {
        try {
          const snap = await snapshot()
          if (!alive) return
          remember(snap)
          if (snap.kind === 'disconnected') maybeAutoConnect()
          emit(isPanel ? panelDataFor(snap, locale) : stripDataFor(snap, locale))
        } catch {
          if (!alive) return
          emit(isPanel
            ? { note: dict(locale).note.disconnected, tone: 'muted', status: dict(locale).status.disconnected, port: '—', device: '—', adb: '—', auto: '—', checked: '—' }
            : null)
        }
      }
      if (isPanel) {
        emit({
          note: dict(locale).note.checking,
          tone: 'info',
          status: dict(locale).status.checking,
          port: loadState().port ? String(loadState().port) : '—',
          device: '—',
          adb: resolveAdb() || dict(locale).none,
          auto: loadState().auto === false ? dict(locale).off : dict(locale).on,
          checked: clockOf(Date.now()),
        })
      }
      push()
      const timer = setInterval(push, isPanel ? PANEL_POLL_MS : STRIP_POLL_MS)
      timer.unref?.()
      const off = subscribeLive(push)
      maybeAutoConnect()
      return () => {
        alive = false
        clearInterval(timer)
        off()
      }
    }

    // Try to restore the link as soon as the engine starts, before anyone looks.
    maybeAutoConnect()

    // Status line above the composer; tapping it opens the panel.
    ctx.dshGo.strip('adb-state', (scope, emit, caps) => startData(emit, caps, false))

    ctx.dshGo.panel('adb', {
      view: (scope, caps) => buildView(caps?.locale),
      data: (scope, emit, caps) => startData(emit, caps, true),
      actions: {
        connect: connectHandler,
        fix: fixHandler,
        scan: scanHandler,
        disconnect: disconnectHandler,
        copy: copyHandler,
        pair: pairHandler,
      },
    })
  })
}

/** Exposed for the local test harness only. */
export const __test = {
  snapshot,
  connectOnce,
  discoverPort,
  statePath,
  buildView,
  panelDataFor,
  stripDataFor,
  adbPromptText,
  fixHandler,
  pairHandler,
  scanHandler,
  pairInputOf,
  tlsCandidates,
  FIX_PORT,
}

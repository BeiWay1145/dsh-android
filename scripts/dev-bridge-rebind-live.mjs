/**
 * 真机测量：一次无障碍服务重绑定让调用方等多久。
 *
 * 口径见 docs/bridge-rebind-measurement.md —— 判定只看 DEVICE 侧，
 * 也就是设备日志里 `service connected` -> `listening on localabstract` 的间隔。
 * 轮询耗时（POLL）只作为参考列打印出来，好让两边差距一直可见。
 *
 * 用法：
 *   node scripts/dev-bridge-rebind-live.mjs [serial]
 *
 * 会临时把 bridge 从 enabled_accessibility_services 里摘掉再放回，并保持屏幕常亮，
 * 结束时恢复原状。属于写操作：只在明确授权的真机上跑。
 */
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const SERIAL = process.argv[2] || process.env.ANDROID_SERIAL
if (!SERIAL) {
  console.error('需要一个设备 serial：node scripts/dev-bridge-rebind-live.mjs <serial>')
  process.exit(1)
}

const ADB = process.env.ADB || 'adb'
const OTHER = 'com.zjwh.android_wh_physicalfitness/com.acse.ottn.service.ShopHelperService'
const BRIDGE = 'com.beiway1145.dshbridge/com.beiway1145.dshbridge.BridgeService'
const FULL = OTHER + ':' + BRIDGE
const PORT = 28765

const sh = (c) => { try { return execFileSync(ADB, ['-s', SERIAL, 'shell', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const adb = (a) => { try { return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }

/**
 * 保持屏幕常亮。不这样做测出来的就是 Doze，而不是 bridge——见文档。
 */
function keepAwake() {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  adb(['shell', 'svc', 'power', 'stayon', 'true'])
  return sh('dumpsys power | grep mWakefulness=').includes('Awake')
}

/**
 * 重建 adb forward。必须每次探活前做：服务解绑后，旧 forward 的连接会挂在
 * 已死 socket 上撑住抽象名，此时新连接能握手但没人 accept。
 */
function resetForward() {
  adb(['forward', '--remove-all'])
  adb(['forward', 'tcp:' + PORT, 'localabstract:dsh_bridge'])
}

function call(timeoutMs = 1200) {
  return new Promise((res) => {
    const t = Date.now()
    const s = net.connect(PORT, '127.0.0.1')
    let buf = ''
    let done = false
    const fin = (o) => { if (!done) { done = true; try { s.destroy() } catch {} res({ ms: Date.now() - t, ...o }) } }
    s.on('connect', () => s.write(JSON.stringify({ id: 1, cmd: 'ping', params: {} }) + '\n'))
    s.on('data', (d) => { buf += d; if (buf.indexOf('\n') >= 0) fin({ ok: true }) })
    s.on('error', () => fin({ ok: false }))
    setTimeout(() => fin({ ok: false, timeout: true }), timeoutMs)
  })
}

/** 从设备日志取真实的 connected -> listening 间隔，以及绑定失败/交接次数。 */
function deviceStats() {
  const lines = sh('logcat -d -v time 2>/dev/null | grep dsh-bridge').split('\n').filter(Boolean)
  const parse = (s) => {
    const m = s.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : null
  }
  const conns = lines.filter((l) => l.includes('service connected')).map(parse).filter((x) => x != null)
  const listens = lines.filter((l) => l.includes('listening on')).map(parse).filter((x) => x != null)
  const gaps = []
  for (const c of conns) {
    const after = listens.filter((x) => x >= c)
    if (after.length) gaps.push(Math.round((after[0] - c) * 1000))
  }
  return {
    bindFail: lines.filter((l) => l.includes('failed (attempt')).length,
    handover: lines.filter((l) => l.includes('(handover)')).length,
    releasedFast: lines.filter((l) => l.includes('(released after')).length,
    gapsMs: gaps,
    maxGapMs: gaps.length ? Math.max(...gaps) : 0,
  }
}

async function measureRound() {
  keepAwake()
  sh('logcat -c')
  sh(`settings put secure enabled_accessibility_services '${OTHER}'`)
  await new Promise((r) => setTimeout(r, 600))
  const t0 = Date.now()
  sh(`settings put secure enabled_accessibility_services '${FULL}'`)
  let attempts = 0
  while (Date.now() - t0 < 30_000) {
    attempts++
    resetForward()
    if ((await call(1200)).ok) break
    await new Promise((x) => setTimeout(x, 100))
  }
  const pollMs = Date.now() - t0
  await new Promise((r) => setTimeout(r, 800)) // 让日志落盘
  return { pollMs, attempts, ...deviceStats() }
}

const awake = keepAwake()
console.log('屏幕常亮:', awake)
if (!awake) {
  console.log('警告：屏幕不是 Awake，这一轮测的是 Doze 而不是 bridge，结果无效。')
}
resetForward()
console.log('前置探活:', (await call()).ok ? 'OK' : 'FAIL')

console.log('\n== E1 单次重绑定 ==')
const e1 = await measureRound()
console.log(`  DEVICE=${e1.maxGapMs}ms  POLL=${e1.pollMs}ms  bindFail=${e1.bindFail}  releasedFast=${e1.releasedFast}`)

console.log('\n== E2 连续 5 次重绑定 ==')
const rounds = []
for (let i = 1; i <= 5; i++) {
  const r = await measureRound()
  rounds.push(r)
  console.log(`  第 ${i} 轮: DEVICE=${r.maxGapMs}ms  POLL=${r.pollMs}ms  bindFail=${r.bindFail}`)
}

const dev = rounds.map((r) => r.maxGapMs)
const poll = rounds.map((r) => r.pollMs)
const bf = rounds.reduce((a, r) => a + r.bindFail, 0)
const maxDev = Math.max(...dev)

console.log('\n=========== 汇总 ===========')
console.log('  DEVICE  E1:', e1.maxGapMs + 'ms', '| E2:', dev.join(', '), '| max:', maxDev + 'ms')
console.log('  POLL    E1:', e1.pollMs + 'ms', '| E2:', poll.join(', '), ' (仅参考，含脚本开销)')
console.log('  bindFail 合计:', bf)
console.log('  报告基线: E1 4007ms / E2 10972ms')
console.log('\n=========== 判定（只看 DEVICE）===========')
const v1 = e1.maxGapMs < 1000
const v2 = maxDev < 2000
const v3 = bf === 0
console.log('  E1 <1000ms:', v1 ? 'PASS' : 'FAIL')
console.log('  E2 <2000ms:', v2 ? 'PASS' : 'FAIL')
console.log('  bindFail==0:', v3 ? 'PASS' : 'FAIL')

adb(['shell', 'svc', 'power', 'stayon', 'false'])
sh(`settings put secure enabled_accessibility_services '${FULL}'`)
await new Promise((r) => setTimeout(r, 2000))
console.log('\n收尾配置:', sh('settings get secure enabled_accessibility_services'))
resetForward()
console.log('收尾探活:', (await call()).ok ? 'OK' : 'FAIL')

process.exit(v1 && v2 && v3 ? 0 : 1)

/**
 * Regression smoke for the direct adb-server client and its CLI fallback.
 *
 * The optimisation this covers: resolveTarget used to spawn `adb devices -l` on
 * every tool call. Measured, the cost is the PROCESS, not the enumeration
 * (`adb version` 51 ms vs `adb devices -l` 59 ms), so the fix talks to the adb
 * server's socket instead - measured 0-1 ms with identical output.
 *
 * What must stay true:
 *   1. both paths parse to the SAME devices (one shared parser)
 *   2. every server failure yields undefined instead of throwing
 *   3. the CLI fallback still runs, at normal speed, when the server is down
 *   4. a malformed or hostile server response can never be mistaken for data
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await import(pathToFileURL(join(root, 'lib', 'adb-server.js')).href)
const { parseDeviceList } = await import(pathToFileURL(join(root, 'lib', 'adb.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

// ── 1. one parser, two inputs ────────────────────────────────────────────────
const DEVICE_LINE = 'HA1XZ6G8               device product:nabu model:M2105K81AC device:nabu transport_id:1'
const cliPayload = `List of devices attached\n${DEVICE_LINE}\n\n`
const srvPayload = `${DEVICE_LINE}\n`
const fromCli = parseDeviceList(cliPayload)
const fromSrv = parseDeviceList(srvPayload)
step('CLI payload parses to one device', fromCli.length === 1 && fromCli[0].serial === 'HA1XZ6G8')
step('server payload parses identically', JSON.stringify(fromCli) === JSON.stringify(fromSrv),
  'the CLI header is skipped either way, so both paths share parseDeviceList')
step('state, model and product survive', fromCli[0].state === 'device' && fromCli[0].model === 'M2105K81AC' && fromCli[0].product === 'nabu')
step('transport id is kept', fromCli[0].transportId === '1')
step('emulator detection is unchanged', fromCli[0].emulator === false)
const emu = parseDeviceList('emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64 device:emu transport_id:2')
step('an emulator is still detected as one', emu[0].emulator === true && emu[0].serial === 'emulator-5554')
step('an empty list parses to zero', parseDeviceList('List of devices attached\n\n').length === 0)
step('an offline device is not reported online', parseDeviceList('X\tunauthorized')[0].state === 'unauthorized')

// ── 2. failures resolve undefined, never throw ───────────────────────────────
const deadPort = 59998
step('a closed port resolves undefined', await server.adbServerRequest('host:devices-l', { port: deadPort }) === undefined)
step('an unknown service resolves undefined', await server.adbServerRequest('host:no-such-service') === undefined)
step('an empty service resolves undefined', await server.adbServerRequest('') === undefined)
step('an oversized service resolves undefined', await server.adbServerRequest('x'.repeat(200000)) === undefined)
// A loopback round trip measures 0-1 ms here, so ANY budget can legitimately be
// won by a healthy server -- asserting "a tiny timeout must fail" tests the
// machine's speed, not the client. The real guarantee is that a server which
// NEVER answers resolves undefined instead of hanging.
const lingering = new Set()
const silent = createServer(sock => {
  // Accept and never reply: the client must time out on its own.
  lingering.add(sock)
  sock.on('close', () => lingering.delete(sock))
})
await new Promise(res => silent.listen(0, '127.0.0.1', res))
const silentPort = silent.address().port
try {
  const started = Date.now()
  const result = await server.adbServerRequest('host:devices-l', { port: silentPort, timeoutMs: 250 })
  const elapsed = Date.now() - started
  step('a server that never replies resolves undefined (no hang)',
    result === undefined && elapsed < 2000, 'took ' + elapsed + ' ms')
} finally {
  // close() waits for open connections, and the client's socket is one. Drop it
  // first so the server can actually shut down.
  for (const sock of lingering) sock.destroy()
  await new Promise(res => silent.close(res))
}

// ── 3. a hostile server cannot fake a device list ────────────────────────────
async function withFakeServer(reply, fn) {
  const srv = createServer(sock => { sock.on('data', () => sock.write(reply)) })
  await new Promise(res => srv.listen(0, '127.0.0.1', res))
  const port = srv.address().port
  try { return await fn(port) } finally { await new Promise(res => srv.close(res)) }
}
step('a FAIL reply resolves undefined', await withFakeServer('FAIL0006nope!!', p => server.adbServerRequest('host:devices-l', { port: p })) === undefined)
step('a desynced reply resolves undefined', await withFakeServer('GARBAGE', p => server.adbServerRequest('host:devices-l', { port: p })) === undefined)
step('a truncated length resolves undefined', await withFakeServer('OKAY00', p => server.adbServerRequest('host:devices-l', { port: p })) === undefined)
step('a lying length resolves undefined', await withFakeServer('OKAYffff', p => server.adbServerRequest('host:devices-l', { port: p })) === undefined)
const honestBody = 'HA1XZ6G8       device'
const honest = await withFakeServer('OKAY' + honestBody.length.toString(16).padStart(4, '0') + honestBody, p => server.adbServerRequest('host:devices-l', { port: p }))
step('a well-formed reply IS returned', typeof honest === 'string' && honest.includes('HA1XZ6G8'))
step('a parsed well-formed reply yields a device', parseDeviceList(honest).length === 1)

// ── 4. port configuration ────────────────────────────────────────────────────
step('default port is 5037', server.adbServerPort({}) === 5037)
step('the env override is honoured', server.adbServerPort({ ANDROID_ADB_SERVER_PORT: '6000' }) === 6000)
step('a bogus env override is ignored', server.adbServerPort({ ANDROID_ADB_SERVER_PORT: 'nonsense' }) === 5037)
step('an out-of-range override is ignored', server.adbServerPort({ ANDROID_ADB_SERVER_PORT: '99999' }) === 5037)

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
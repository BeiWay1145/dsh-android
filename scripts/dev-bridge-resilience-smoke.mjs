/**
 * Bridge resilience smoke: how the fast path behaves when it FAILS.
 *
 * The bridge is optional and every failure falls back to uiautomator, which is
 * correct. The risk is not the fallback, it is failing to come BACK: the client
 * remembers a failure for a while, and a single TTL used for every kind of
 * failure means a transient one costs as much as a permanent one.
 *
 * Measured motivation, reported from a real session: ColorOS reclaimed the
 * accessibility service in the background (PID 20825 -> 23523). The service
 * rebinds itself in seconds, but the client's 60 s penalty kept it on the slow
 * path for a full minute AFTER the device had recovered -- and because the
 * fallback is silent, the only symptom was 'it got slow again'.
 *
 * What must stay true:
 *   1. a KNOWN-INSTALLED bridge that goes quiet is retried soon, not in a minute
 *   2. a bridge that is NOT installed is not re-probed on every read
 *   3. the transient penalty is strictly shorter than the permanent one
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bridge = await import(pathToFileURL(join(root, 'lib', 'bridge-client.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

step('the permanent penalty still exists', bridge.BRIDGE_NEGATIVE_TTL_MS === 60_000,
  `${bridge.BRIDGE_NEGATIVE_TTL_MS} ms`)
step('a transient penalty exists and is short',
  typeof bridge.BRIDGE_TRANSIENT_TTL_MS === 'number' && bridge.BRIDGE_TRANSIENT_TTL_MS <= 5_000,
  `${bridge.BRIDGE_TRANSIENT_TTL_MS} ms`)
step('the transient penalty is STRICTLY shorter than the permanent one',
  bridge.BRIDGE_TRANSIENT_TTL_MS < bridge.BRIDGE_NEGATIVE_TTL_MS,
  'a service that is rebinding must not be treated like one that is missing')
step('the transient penalty is long enough to avoid hammering a dead socket',
  bridge.BRIDGE_TRANSIENT_TTL_MS >= 500,
  `${bridge.BRIDGE_TRANSIENT_TTL_MS} ms`)
step('the service package name is exported for the status probe',
  bridge.BRIDGE_PACKAGE === 'com.beiway1145.dshbridge',
  String(bridge.BRIDGE_PACKAGE))

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
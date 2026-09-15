/**
 * Regression smoke for the stuck-empty-screencap recovery.
 *
 * The failure this covers, measured on a Xiaomi Pad 5 (MIUI 14): a swipe on the
 * LOCK SCREEN leaves `screencap -p` returning a zero-byte frame for about 10.3 s
 * (10.2-10.5 s across 6 trials). An agent hit it in a recorded session, believed
 * the old 'device may have gone offline' wording, and spent 38 tool calls and
 * ~3.2 M cached tokens hunting a device fault that did not exist.
 *
 * What must stay true:
 *   1. a single empty frame is retried, and an ordinary transient just works
 *   2. a STUCK empty frame is cleared by cycling the display (POWER, then WAKEUP)
 *   3. if it still cannot capture, the error blames the DISPLAY, never the device
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { AndroidHostController } = await import(pathToFileURL(join(root, 'lib', 'android-host.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')

/** A host whose screencap answers from a scripted list. */
function makeHost(script) {
  const seen = { captures: 0, power: 0, wake: 0, shells: [] }
  const toolchain = {
    async execOut(_s, args) {
      if (args[0] !== 'screencap') throw new Error('unexpected exec-out ' + args.join(' '))
      const n = seen.captures++
      return script[n] ?? Buffer.alloc(0)
    },
    async shell(_s, args) {
      seen.shells.push(args.join(' '))
      if (args.includes('KEYCODE_POWER')) seen.power++
      if (args.includes('KEYCODE_WAKEUP')) seen.wake++
      return ''
    },
  }
  // A REAL instance with only its toolchain replaced: the recovery uses private
  // fields, so a hand-rolled object is not a faithful stand-in.
  const host = new AndroidHostController(toolchain)
  return { host, seen }
}

// 1. A HEALTHY device: one capture, no recovery attempted.
{
  const { host, seen } = makeHost([PNG])
  const shot = await host.screenshot('FAKE')
  step('a healthy capture succeeds on the first try', shot.png.length > 0)
  step('a healthy capture does NOT touch the power key', seen.power === 0 && seen.wake === 0,
    'recovery must never run speculatively')
  step('a healthy capture reports no recovery', host.lastCaptureRecovered === false)
}

// 2. A single empty frame (an ordinary transient): retried, not recovered.
{
  const { host, seen } = makeHost([Buffer.alloc(0), PNG])
  const shot = await host.screenshot('FAKE')
  step('one empty frame is retried and succeeds', shot.png.length > 0)
  step('a single empty frame does NOT cycle the display', seen.power === 0,
    'the cheap retry must handle the common case')
}

// 3. A STUCK empty frame: the real lock-screen case, cleared by POWER + WAKEUP.
{
  const { host, seen } = makeHost([Buffer.alloc(0), Buffer.alloc(0), PNG])
  const shot = await host.screenshot('FAKE')
  step('a stuck empty frame is recovered', shot.png.length > 0)
  step('the recovery presses POWER exactly once', seen.power === 1)
  step('the recovery wakes the display again', seen.wake === 1,
    'POWER alone would leave the screen off')
  step('the recovery reports itself', host.lastCaptureRecovered === true)
}

// 4. A device that never answers a capture: the message must blame the DISPLAY.
{
  const { host } = makeHost([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)])
  let message = ''
  try { await host.screenshot('FAKE') } catch (e) { message = String(e.message) }
  step('a permanently empty capture throws', message !== '')
  step('the error says the device is REACHABLE', /REACHABLE/i.test(message),
    'the old wording said the device may have gone offline, which sent an agent hunting a fault')
  step('the error says it is a DISPLAY state', /display state/i.test(message))
  step('the error tells the caller NOT to run android_devices', /Do not run android_devices/i.test(message))
  step('the error offers android_ui_tree as the way to keep working', /android_ui_tree/.test(message),
    'the accessibility tree does not read the display, so it still works')
  step('the error no longer claims the device went offline', !/gone offline/i.test(message))
}


// 5. The wakefulness probe, which turns a symptom into a cause.
{
  const { host } = makeHost([PNG])
  const mk = (out) => {
    const h = new AndroidHostController({
      async execOut() { return PNG },
      async shell() { return out },
    })
    return h
  }
  step('an Awake device reports true', await mk('mWakefulness=Awake').isScreenAwake('FAKE') === true)
  step('an Asleep device reports false', await mk('mWakefulness=Asleep').isScreenAwake('FAKE') === false)
  step('an unreadable state reports undefined, not a guess',
    await mk('no useful output here').isScreenAwake('FAKE') === undefined,
    'an unknown answer must never be reported as a state')
  step('a probe that throws reports undefined',
    await mk2().isScreenAwake('FAKE') === undefined)

  step('an Awake device gets no note', (await mk('mWakefulness=Awake').sleepingScreenNote('FAKE')) === '')
  const asleepNote = await mk('mWakefulness=Asleep').sleepingScreenNote('FAKE')
  step('an Asleep device gets a note naming the cause', /ASLEEP/.test(asleepNote))
  step('the note says how to wake it', /name \"power\"/.test(asleepNote))
  step('the note refuses to change the device settings itself', /will not change/.test(asleepNote),
    'the plugin must not silently alter a user device')
  step('an unknown state gets no note', (await mk('garbage').sleepingScreenNote('FAKE')) === '')
}

function mk2() {
  return new AndroidHostController({
    async execOut() { return PNG },
    async shell() { throw new Error('adb wedged') },
  })
}

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
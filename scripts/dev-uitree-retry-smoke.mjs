/**
 * Regression smoke for the gated dump retry in dumpUiTreeXml.
 *
 * Reproduces the expensive failure: the primary dump keeps answering "could not
 * get idle state". The old code paid a second FULL dump; the gated version must
 * skip it when the cheap fingerprint says the screen never moved — and must
 * still retry when the fingerprint is unavailable.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { dumpUiTreeXml } = await import(pathToFileURL(join(root, 'lib', 'uitree.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`) }

const XML = '<?xml version=\'1.0\'?><hierarchy rotation="0"><node index="0" text="hi" class="android.widget.TextView" bounds="[0,0][10,10]"/></hierarchy>'

function makeToolchain({ focusChanges, fingerprintWorks = true }) {
  const calls = { primary: 0, fallback: 0, window: 0 }
  let focus = 'A'
  return {
    calls,
    flipFocus() { focus = focus === 'A' ? 'B' : 'A' },
    setUpFocus(v) { focus = v },
    async execOut(_serial, args) {
      const cmd = args.join(' ')
      if (cmd.includes('uiautomator dump /dev/tty')) {
        calls.primary++
        const err = new Error('uiautomator dump /dev/tty failed (exit 1): ERROR: could not get idle state.')
        throw err
      }
      if (cmd.startsWith('cat')) return Buffer.from(XML)
      return Buffer.from('')
    },
    async shell(_serial, args) {
      const cmd = args.join(' ')
      if (cmd.startsWith('dumpsys window')) {
        calls.window++
        if (!fingerprintWorks) throw new Error('dumpsys window unavailable')
        return `  mCurrentFocus=Window{1 u0 com.example/${focus}}\n  Frames: frame=[0,0][1,1]\n`
      }
      if (cmd.includes('uiautomator dump')) {
        calls.fallback++
        // Simulate focus changing only when the scenario says so.
        if (focusChanges) focus = 'B'
        return 'UI hierchary dumped to: /sdcard/window_dump.xml'
      }
      return ''
    },
  }
}

// 1. screen UNCHANGED -> the redundant primary retry must be skipped
{
  const t = makeToolchain({ focusChanges: false })
  t.setUpFocus('A')
  const xml = await dumpUiTreeXml(t, 'FAKE')
  step('unchanged screen: only ONE primary attempt', t.calls.primary === 1, `primary=${t.calls.primary}`)
  step('unchanged screen: falls through to the fallback', t.calls.fallback === 1, `fallback=${t.calls.fallback}`)
  step('unchanged screen: still returns a parsed document', xml.includes('<hierarchy'))
}

// 2. screen CHANGED between the two fingerprints -> the retry must still happen.
// The fake reports a different focus on the SECOND dumpsys window read, which
// is exactly the "the UI moved while we waited" case.
{
  const t = makeToolchain({ focusChanges: true })
  let windowReads = 0
  const orig = t.shell.bind(t)
  t.shell = async (s, a, o) => {
    const cmd = a.join(' ')
    if (cmd.startsWith('dumpsys window')) {
      windowReads++
      return `  mCurrentFocus=Window{1 u0 com.example/${windowReads === 1 ? 'A' : 'B'}}\n`
    }
    return orig(s, a, o)
  }
  await dumpUiTreeXml(t, 'FAKE').catch(() => {})
  step('changed screen: a second primary attempt IS spent', t.calls.primary === 2,
    `primary=${t.calls.primary} windowReads=${windowReads}`)
}

// 3. fingerprint UNAVAILABLE -> must NOT be read as "unchanged".
// The retry then fails too and the tool gives up (correct: the /sdcard fallback
// would run the identical dump), so assert on the attempts, not on success.
{
  const t = makeToolchain({ focusChanges: false, fingerprintWorks: false })
  let threw = false
  await dumpUiTreeXml(t, 'FAKE').catch(() => { threw = true })
  step('unavailable fingerprint: retry is preserved', t.calls.primary === 2, `primary=${t.calls.primary}`)
  step('two genuine idle failures: gives up without the identical fallback',
    threw === true && t.calls.fallback === 0, `threw=${threw} fallback=${t.calls.fallback}`)
}

console.log(`\n${pass}/${pass + fail} steps passed`)
process.exit(fail === 0 ? 0 : 1)

/**
 * Deterministic state verification smoke.
 *
 * The evaluator is the half of the observe/act contract that decides whether a task
 * actually finished, so its failure mode is the worst kind: a WRONG verdict that looks
 * precise. Every rule below exists because getting it wrong would mean asserting a
 * state nobody observed.
 *
 * Two distinctions carry most of the weight:
 *   unreadable vs failed -- 'I could not look' must never read as 'the state is wrong'
 *   structure vs appearance -- this module answers state, never looks
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const v = await import(pathToFileURL(join(root, 'lib', 'verify.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

// ── reading raw state ───────────────────────────────────────────────────────
step('screen reads mWakefulness out of a dumpsys power dump',
  v.extractObserved({ kind: 'screen' }, 'noise\n  mWakefulness=Awake\nmore noise') === 'Awake')
step('wifi reports the word, not the 0/1 setting',
  v.extractObserved({ kind: 'wifi' }, '1') === 'on' && v.extractObserved({ kind: 'wifi' }, '0') === 'off')
// The real format is Window{<hash> u0 <component>}. Taking the FIRST token after
// the brace returns the hash -- a value that looks like data and is not the app.
step('focus returns the COMPONENT, not the window hash',
  v.extractObserved({ kind: 'focus' }, '  mCurrentFocus=Window{3a068db u0 com.android.settings/.Settings}')
    === 'com.android.settings/.Settings',
  String(v.extractObserved({ kind: 'focus' }, '  mCurrentFocus=Window{3a068db u0 com.android.settings/.Settings}')))
step('a bare focus value still reads',
  v.extractObserved({ kind: 'focus' }, '  mCurrentFocus=null') === 'null')
step('package lists every matched name',
  v.extractObserved({ kind: 'package' }, 'package:com.a.b\npackage:com.c.d') === 'com.a.b com.c.d')
step('no matching package reads as empty, not as undefined',
  v.extractObserved({ kind: 'package' }, '') === '')

// ── command construction ────────────────────────────────────────────────────
step('a setting target is split into namespace and key',
  JSON.stringify(v.splitSettingTarget('system.screen_brightness')) === '{"namespace":"system","key":"screen_brightness"}')
step('an unknown namespace is REJECTED rather than defaulted',
  v.splitSettingTarget('nonsense.key') === undefined,
  'reading the wrong namespace can return a plausible value for a real key')
step('a target without a namespace is rejected', v.splitSettingTarget('screen_brightness') === undefined)
step('a trailing dot is rejected', v.splitSettingTarget('system.') === undefined)
step('a package claim without a target is invalid, not silently empty',
  'invalid' in v.commandForClaim({ kind: 'package' }))
step('a prop claim without a target is invalid',
  'invalid' in v.commandForClaim({ kind: 'prop' }))

// ── verdicts ────────────────────────────────────────────────────────────────
step('eq matches after trimming', v.evaluateClaim({ kind: 'screen', expect: 'Awake' }, ' Awake ').passed)
step('ne inverts', v.evaluateClaim({ kind: 'screen', expect: 'Awake', matcher: 'ne' }, 'Asleep').passed)
step('contains is a substring test',
  v.evaluateClaim({ kind: 'focus', expect: 'settings', matcher: 'contains' }, 'com.android.settings/.S').passed)
step('matches takes a regular expression',
  v.evaluateClaim({ kind: 'prop', expect: '^3[0-9]$', matcher: 'matches' }, '35').passed)
step('exists rejects an empty read', !v.evaluateClaim({ kind: 'package', matcher: 'exists' }, '').passed)
step('absent accepts an empty read', v.evaluateClaim({ kind: 'package', matcher: 'absent' }, '').passed)

// THE CENTRAL RULE: a read that failed is not a state that is wrong.
{
  const r = v.evaluateClaim({ kind: 'screen', expect: 'Awake' }, undefined, 'adb exploded')
  step('an unreadable claim is NOT reported as failed', r.unreadable === true,
    'collapsing these is how an agent acts on a state it never observed')
  step('an unreadable claim still carries its reason', String(r.error).includes('adb exploded'))
}
{
  const r = v.evaluateClaim({ kind: 'focus', matcher: 'matches', expect: '([unclosed' }, 'x')
  step('a bad caller regex is unreadable, not a verdict about the device', r.unreadable === true)
}

// ── the tool's own schema ───────────────────────────────────────────────────
step('the tool name is exported for the index and this suite to agree on',
  Array.isArray(v.ANDROID_VERIFY_TOOL_NAMES) && v.ANDROID_VERIFY_TOOL_NAMES.includes('android_verify'))

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
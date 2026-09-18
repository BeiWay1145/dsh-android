/**
 * Deterministic state verification -- the EVALUATOR half of the observe/act contract.
 *
 * WHY THIS EXISTS, and why it is not `android_assert`.
 *
 * `android_assert` answers a yes/no question by CAPTURING THE SCREEN and handing the
 * image to the calling model. That is the right tool for residual PERCEPTION -- a
 * spinner, an error tint, a layout only a picture can show. It is the wrong tool for a
 * question the system can answer itself, for four measured reasons:
 *
 *   1. It needs an attachment store and an image-capable route. On a host without one
 *      it does not degrade, it FAILS: measured on this machine,
 *      "no attachment store is mounted on this host". This module needs only adb.
 *   2. It costs about 590 ms and 2000-2600 tokens per call. A raw state read costs
 *      160-230 ms and a few dozen tokens (measured on a real device).
 *   3. The judgement is made by a model reading a picture; here it is made in code,
 *      so the same claim about the same state always gets the same answer.
 *   4. It cannot be replayed. (claim, passed, evidence) can.
 *
 * It reads RAW SYSTEM STATE and never goes through the UI-tree parser, so an assertion
 * cannot be fooled by the same projection layer the action used. That independence is
 * the point: an observer that checks its own output proves nothing.
 *
 * @module @zseven-w/dsh-android/verify
 */

/** A state source this module can read. */
export type VerifyKind = 'setting' | 'wifi' | 'screen' | 'focus' | 'package' | 'prop' | 'process'

/** How an expected value is compared against what was read. */
export type VerifyMatcher = 'eq' | 'ne' | 'contains' | 'matches' | 'exists' | 'absent'

/** One assertion, as the caller writes it. */
export interface VerifyClaim {
  kind: VerifyKind
  /**
   * What to read within that kind:
   *   setting -- `<namespace>.<key>`, e.g. `system.screen_brightness`
   *   prop    -- a property name, e.g. `ro.build.version.sdk`
   *   package -- a package name
   *   process -- a process name (or a substring)
   *   wifi | screen | focus -- not used
   */
  target?: string
  /** How to compare. Defaults to `eq`. */
  matcher?: VerifyMatcher
  /** What to compare against. Omitted for `exists` and `absent`. */
  expect?: string
}

/** The outcome of one claim, with the evidence that decided it. */
export interface VerifyResult {
  claim: VerifyClaim
  passed: boolean
  /** What was actually read, verbatim enough to audit. */
  observed?: string
  /** True when the read itself failed, so `passed` means nothing. */
  unreadable?: boolean
  /** Why it could not be read. */
  error?: string
}

/**
 * Compare one observed value against a claim.
 *
 * Exported and pure so the comparison rules are testable without a device -- the
 * part that decides pass/fail is exactly the part worth pinning down.
 *
 * `unreadable` is NOT `false`: a claim that could not be evaluated must never be
 * reported as failed, or a caller cannot tell 'the state is wrong' from 'I could not
 * look'. That distinction is the whole reason this returns a result object rather
 * than a boolean.
 */
export function evaluateClaim(claim: VerifyClaim, observed: string | undefined, error?: string): VerifyResult {
  if (observed === undefined) {
    return { claim, passed: false, unreadable: true, ...(error === undefined ? {} : { error }) }
  }
  const matcher = claim.matcher ?? 'eq'
  const expected = claim.expect ?? ''
  let passed: boolean
  switch (matcher) {
    case 'eq':
      passed = observed.trim() === expected.trim()
      break
    case 'ne':
      passed = observed.trim() !== expected.trim()
      break
    case 'contains':
      passed = observed.includes(expected)
      break
    case 'matches':
      try {
        passed = new RegExp(expected, 's').test(observed)
      } catch (err) {
        // A bad pattern is the CALLER's error, not a verdict about the device.
        return {
          claim,
          passed: false,
          observed,
          unreadable: true,
          error: 'the matcher pattern is not a valid regular expression: ' + (err instanceof Error ? err.message : String(err)),
        }
      }
      break
    case 'exists':
      passed = observed.trim() !== '' && observed.trim() !== 'null'
      break
    case 'absent':
      passed = observed.trim() === '' || observed.trim() === 'null'
      break
  }
  return { claim, passed, observed }
}

/**
 * Split a `namespace.key` setting target.
 *
 * Returns undefined rather than defaulting to a namespace: reading the WRONG
 * namespace can return a plausible value for a key that exists in several, and a
 * silent wrong-namespace read is exactly the confident-but-untethered answer this
 * module exists to prevent.
 */
export function splitSettingTarget(target: string | undefined): { namespace: string; key: string } | undefined {
  if (target === undefined) return undefined
  const dot = target.indexOf('.')
  if (dot <= 0 || dot === target.length - 1) return undefined
  const namespace = target.slice(0, dot)
  if (namespace !== 'system' && namespace !== 'secure' && namespace !== 'global') return undefined
  return { namespace, key: target.slice(dot + 1) }
}

/**
 * Build the adb shell command that reads one claim's source.
 *
 * Kept separate from execution so the command construction is reviewable and
 * testable -- it is the part a mistake would turn into a wrong verdict.
 */
export function commandForClaim(claim: VerifyClaim): { args: string[] } | { invalid: string } {
  switch (claim.kind) {
    case 'setting': {
      const parts = splitSettingTarget(claim.target)
      if (parts === undefined) {
        return { invalid: 'a setting claim needs target as <namespace>.<key>, where namespace is system, secure or global' }
      }
      return { args: ['settings', 'get', parts.namespace, parts.key] }
    }
    case 'wifi':
      // wifi_on is the authoritative switch; whether a NETWORK is connected is a
      // different question that would need a different claim kind.
      return { args: ['settings', 'get', 'global', 'wifi_on'] }
    case 'screen':
      return { args: ['dumpsys', 'power'] }
    case 'focus':
      return { args: ['dumpsys', 'window'] }
    case 'package':
      return claim.target === undefined || claim.target === ''
        ? { invalid: 'a package claim needs target (the package name)' }
        : { args: ['pm', 'list', 'packages', claim.target] }
    case 'prop':
      return claim.target === undefined || claim.target === ''
        ? { invalid: 'a prop claim needs target (the property name, e.g. ro.build.version.sdk)' }
        : { args: ['getprop', claim.target] }
    case 'process':
      return { args: ['ps', '-A', '-o', 'PID,NAME'] }
  }
}

/**
 * Reduce a raw command's output to the value a claim is really about.
 *
 * `dumpsys power` prints thousands of lines; a claim about the screen is about one
 * of them. Extracting here keeps the claim text honest -- the caller asserts
 * `screen eq Awake`, not a regex over an entire dump.
 */
export function extractObserved(claim: VerifyClaim, raw: string): string | undefined {
  if (claim.kind === 'screen') {
    return /mWakefulness=(\w+)/.exec(raw)?.[1]
  }
  if (claim.kind === 'focus') {
    // `mCurrentFocus=Window{3a068db u0 com.android.settings/.Settings}` -- the
    // COMPONENT is the last whitespace-separated token inside the braces, not
    // the first. An earlier pattern let the greedy class backtrack and returned
    // `Window{3a068db`, which is a hash, not an app: a verified claim about
    // which app has focus would then have been wrong while looking precise.
    const windowed = /mCurrentFocus=Window\{[^}]*?\s(\S+)\}/.exec(raw)
    if (windowed !== null) return windowed[1]
    // A keyguard or a null focus prints bare; fall back to the raw token so the
    // claim can still be evaluated (and `null` still reads as absent).
    return /mCurrentFocus=(\S+)/.exec(raw)?.[1]
  }
  if (claim.kind === 'wifi') {
    const value = raw.trim()
    // The setting is a 0/1 switch; report the word the claim is written with.
    if (value === '1') return 'on'
    if (value === '0') return 'off'
    return value
  }
  if (claim.kind === 'package') {
    const names = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('package:'))
      .map(line => line.slice('package:'.length))
    return names.length === 0 ? '' : names.join(' ')
  }
  if (claim.kind === 'process') {
    const target = claim.target ?? ''
    if (target === '') return raw.trim() === '' ? '' : 'some'
    return raw.split('\n').some(line => line.includes(target)) ? 'running' : ''
  }
  return raw.trim()
}

// ── the tool ────────────────────────────────────────────────────────────────

/** Options the tool needs from the host, structurally (testable without a device). */
export interface VerifyToolHost {
  resolveTarget(serial?: string): Promise<{ serial: string }>
  toolchain: { shell(serial: string, args: string[], options?: { timeoutMs?: number }): Promise<string> }
}

/** One claim's result, as it appears in the tool output. */
export interface VerifyClaimOutput {
  kind: string
  target?: string
  matcher: string
  expect?: string
  passed: boolean
  observed?: string
  unreadable?: boolean
  error?: string
}

/**
 * Read one claim's raw source and decide it.
 *
 * A read failure is reported as `unreadable`, never as `passed: false`. The
 * difference matters to a caller deciding whether to retry: 'the wifi is off' and 'I
 * could not read the wifi state' call for opposite responses, and collapsing them
 * into one boolean is how an agent ends up acting on a state it never observed.
 */
export async function verifyOneClaim(
  host: VerifyToolHost,
  serial: string,
  claim: VerifyClaim,
): Promise<VerifyResult> {
  const built = commandForClaim(claim)
  if ('invalid' in built) {
    return { claim, passed: false, unreadable: true, error: built.invalid }
  }
  let raw: string
  try {
    raw = await host.toolchain.shell(serial, built.args, { timeoutMs: 15_000 })
  } catch (error) {
    return {
      claim,
      passed: false,
      unreadable: true,
      error: 'the read failed: ' + (error instanceof Error ? error.message : String(error)),
    }
  }
  const observed = extractObserved(claim, raw)
  if (observed === undefined) {
    return {
      claim,
      passed: false,
      unreadable: true,
      error: 'the command succeeded but its output did not contain the expected field',
    }
  }
  return evaluateClaim(claim, observed)
}

// ── the tool definition ─────────────────────────────────────────────────────

/**
 * The tool-building primitive comes from the runtime; the two small helpers
 * below are defined LOCALLY so this module stays independently testable -- the
 * pure helpers above need no runtime at all.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const deviceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serial: { type: 'string', required: true },
    name: { type: 'string', required: true },
    androidVersion: { type: 'string', required: true },
    state: { type: 'string', required: true },
  },
} as const

// NOTE: `required` is NOT allowed at the items level of an array -- the DSL
// enforces its subset at runtime, and this rejects with
//   'parameters.claims.items.required is not supported by the value schema DSL'
// Only per-PROPERTY `required` is accepted, which is what `kind` uses below.
// TypeScript cannot see this; only constructing the tool does.
const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    target: { type: 'string' },
    matcher: { type: 'string' },
    expect: { type: 'string' },
  },
} as const

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    target: { type: 'string' },
    matcher: { type: 'string', required: true },
    expect: { type: 'string' },
    passed: { type: 'boolean', required: true },
    observed: { type: 'string' },
    unreadable: { type: 'boolean' },
    error: { type: 'string' },
  },
} as const

/**
 * The four fields the shared device shape requires, read from the device.
 *
 * `getprop` is one round trip and both values are already cached by every other
 * tool; the alternative -- filling them with empty strings -- would make this
 * verifier report an unobserved fact, which is the one thing it must never do.
 */
async function deviceIdentity(
  host: VerifyToolHost,
  target: { serial: string },
): Promise<{ serial: string; name: string; androidVersion: string; state: string }> {
  const [model, release] = await Promise.all([
    host.toolchain.shell(target.serial, ['getprop', 'ro.product.model'], { timeoutMs: 10_000 }).catch(() => ''),
    host.toolchain.shell(target.serial, ['getprop', 'ro.build.version.release'], { timeoutMs: 10_000 }).catch(() => ''),
  ])
  return {
    serial: target.serial,
    name: model.trim() === '' ? target.serial : model.trim(),
    androidVersion: release.trim(),
    state: 'device',
  }
}

/** The tool name, so the index and the contract suite agree on one string. */
export const ANDROID_VERIFY_TOOL_NAMES = ['android_verify'] as const

/**
 * `android_verify` -- deterministic final-state verification.
 *
 * Every claim is read from RAW SYSTEM STATE (settings / dumpsys / pm / getprop) and
 * judged in code, so the answer is the same every time and costs no image. Use it to
 * answer "did that actually happen" for anything the system records; reach for
 * android_assert only when the question is genuinely about APPEARANCE.
 */
export function createAndroidVerifyTools(host: VerifyToolHost): { androidVerify: ToolDefinition } {
  const androidVerify = defineTool({
    name: 'android_verify',
    description: 'Verify that the device is in an expected STATE, by reading raw system state and judging '
      + 'it in code -- no screenshot, no image tokens. This is the deterministic way to answer "did that '
      + 'actually happen" for anything the system records: a setting, the wifi switch, whether the screen '
      + 'is awake, which app has focus, whether a package is installed, a system property, or whether a '
      + 'process is running. It reads BELOW the accessibility layer, so a result cannot be fooled by the '
      + 'same parsing the action used. Pass several claims at once and it returns one verdict per claim. '
      + 'A claim that COULD NOT BE READ comes back with unreadable:true and is never reported as failed -- '
      + 'the caller must be able to tell "the state is wrong" from "I could not look". Claims that are '
      + 'genuinely about APPEARANCE (a spinner, an error colour, a layout) are not answerable here; use '
      + 'android_assert for those.',
    parameters: {
      device: {
        type: 'string',
        description: 'Target adb serial. Defaults to the streamed device, else the only online one.',
      },
      claims: {
        type: 'array',
        required: true,
        items: CLAIM_SCHEMA,
        description: 'Claims to check, each {kind, target?, matcher?, expect?}. kind: setting (target '
          + '"system.screen_brightness" -- namespace must be system, secure or global), wifi (the wifi '
          + 'switch: expect "on" or "off"), screen (expect "Awake" or "Asleep"), focus (target is a '
          + 'substring of the focused window, e.g. a package name), package (target is the package name), '
          + 'prop (target is a system property), process (target is a process-name substring). matcher: eq '
          + '(default), ne, contains, matches (expect is a regex), exists, absent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { ...deviceSchema, required: true },
          passed: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          unreadable: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: RESULT_SCHEMA },
          hint: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args: { device?: string; claims: VerifyClaim[] }, _exec: unknown) {
      const target = await host.resolveTarget(args.device)
      const claims = Array.isArray(args.claims) ? args.claims : []
      const results: VerifyClaimOutput[] = []
      for (const claim of claims) {
        const outcome = await verifyOneClaim(host, target.serial, claim)
        results.push({
          kind: claim.kind,
          ...(claim.target === undefined ? {} : { target: claim.target }),
          matcher: claim.matcher ?? 'eq',
          ...(claim.expect === undefined ? {} : { expect: claim.expect }),
          passed: outcome.passed,
          ...(outcome.observed === undefined ? {} : { observed: outcome.observed }),
          ...(outcome.unreadable === true ? { unreadable: true } : {}),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
      }
      const failed = results.filter(r => !r.passed && r.unreadable !== true).length
      const unreadable = results.filter(r => r.unreadable === true).length
      return {
        // The shared device schema marks all four fields required. Rather than
        // pad with empty strings, read the two facts from the device -- this
        // tool is a verifier, and a result that reports a placeholder as a
        // device name would be exactly the kind of unfounded claim it exists
        // to catch.
        device: await deviceIdentity(host, target),
        passed: failed === 0 && unreadable === 0,
        total: results.length,
        failed,
        unreadable,
        results,
        ...(results.length === 0 ? { hint: 'No claims were given, so nothing was checked.' } : {}),
        ...(unreadable > 0 && failed === 0
          ? { hint: 'No claim FAILED, but ' + unreadable + ' could not be read. Do not treat those as passed.' }
          : {}),
      }
    },
  })
  return { androidVerify }
}
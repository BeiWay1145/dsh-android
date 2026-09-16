/**
 * uiautomator backend: dump the frontmost window's view hierarchy over plain
 * adb, parse it, and shape it into the compact node tree the semantic tools
 * reason over.
 *
 * This is the Android answer to dsh-ios's AXe/WebDriverAgent split — and it
 * is a single backend, not two: emulators and physical devices both answer
 * `adb shell uiautomator dump`, so there is no per-backend matching table,
 * no snapshot-depth ladder, and no helper binary to install (uiautomator
 * ships inside the platform). What DOES differ from iOS:
 *
 * - Coordinates are DISPLAY PIXELS, origin top-left, in the current display
 *   space (`bounds="[l,t][r,b]"`). The frame the panel streams uses the same
 *   space, so a tap only needs `pixel / screen` to reach the normalized 0..1
 *   contract of `AndroidHostController.tap` (docs/architecture.zh.md).
 * - There is no `visible` flag. Off-screen rows are detected geometrically
 *   against the hierarchy root bounds, exactly like the AXe path did.
 * - Every node reports `enabled`, and almost all of them report `true`. To
 *   keep the 40 KB output cap useful, the flags are emitted ONLY in their
 *   interesting state: `enabled` appears only when the control is DISABLED,
 *   and `focused`/`clickable`/`scrollable` only when true. Absent therefore
 *   means "enabled / not focused / not clickable / not scrollable" — never
 *   "unknown".
 *
 * The XML parser below is hand-written on purpose: the plugin ships with no
 * third-party runtime dependency, and uiautomator's output is a tiny, strictly
 * attribute-only dialect (no text content, no namespaces, no DTD). It is
 * quote-aware, so an attribute value containing `>` cannot terminate a tag
 * early, and it decodes the five XML entities plus numeric character
 * references.
 * @module @zseven-w/dsh-android/uitree
 */

import type { AdbToolchain } from './adb.js'
import { screenFingerprint } from './screen-fingerprint.js'

/** Compact tree output cap: past this the deepest levels are pruned. */
export const UI_TREE_CAP_BYTES = 40 * 1024

/** Guidance appended when the 40 KB cap pruned the deepest levels. */
export const UI_TREE_TRUNCATED_HINT
  = 'The tree exceeded the 40 KB output cap and its deepest levels were pruned. '
  + 'Re-run with max_depth or filter to narrow the subtree.'

/** Default timeout for one `uiautomator dump` round trip. */
const DUMP_TIMEOUT_MS = 60_000
/** A dump of a busy list screen measures ~500 KB; 8 MB is slack, not a target. */
const DUMP_MAX_BUFFER = 8 * 1024 * 1024

/** Node bounds in display pixels, origin top-left. */
export interface UiBounds {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One compact view node.
 *
 * Empty string attributes are omitted (uiautomator writes `text=""` on every
 * container), and the booleans follow the interesting-state rule documented
 * in the module header.
 */
export interface UiTreeNode {
  /** Trailing segment of the `class` attribute, e.g. `android.widget.Button` → `Button`. */
  type: string
  /** Full `class` attribute, e.g. `android.widget.Button`, when non-empty. */
  className?: string
  /** `text` attribute, when non-empty. */
  text?: string
  /** `content-desc` attribute, when non-empty. */
  contentDesc?: string
  /** `resource-id` attribute, when non-empty. */
  resourceId?: string
  /** `package` attribute (the owning app), when non-empty. */
  packageName?: string
  bounds: UiBounds
  /** Present ONLY when the control is disabled (`enabled="false"`). */
  enabled?: boolean
  /** Present ONLY when true. */
  focused?: boolean
  /** Present ONLY when true. */
  clickable?: boolean
  /** Present ONLY when true. */
  scrollable?: boolean
  /**
   * Present ONLY when `password="true"`: a secure/password text input whose
   * `text`/content-desc value must be withheld from QA-facing surfaces.
   */
  password?: boolean
  children: UiTreeNode[]
}

// ── XML ──────────────────────────────────────────────────────────────────────

/** One parsed XML element (attribute-only dialect: text content is dropped). */
export interface XmlElement {
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
}

/**
 * Decode the five XML entities plus decimal/hex character references. An
 * unknown or malformed reference is left verbatim rather than dropped — a
 * literal `&` in a label must survive the round trip.
 */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

interface TagScan {
  name: string
  attributes: Record<string, string>
  selfClosing: boolean
  /** Index just past the closing `>`, or -1 when the tag is unterminated. */
  next: number
}

/**
 * Scan one start tag beginning at `start` (the character after `<`). The scan
 * is quote-aware: `>` inside an attribute value never ends the tag.
 */
function scanStartTag(source: string, start: number): TagScan {
  const length = source.length
  let index = start
  while (index < length && !isSpace(source[index]!) && source[index] !== '/' && source[index] !== '>') index += 1
  const name = source.slice(start, index)
  const attributes: Record<string, string> = {}
  let selfClosing = false
  for (;;) {
    while (index < length && isSpace(source[index]!)) index += 1
    if (index >= length) return { name, attributes, selfClosing, next: -1 }
    const char = source[index]!
    if (char === '/') {
      selfClosing = true
      index += 1
      continue
    }
    if (char === '>') return { name, attributes, selfClosing, next: index + 1 }
    const nameStart = index
    while (
      index < length
      && !isSpace(source[index]!)
      && source[index] !== '='
      && source[index] !== '/'
      && source[index] !== '>'
    ) index += 1
    const attributeName = source.slice(nameStart, index)
    while (index < length && isSpace(source[index]!)) index += 1
    let raw = ''
    if (source[index] === '=') {
      index += 1
      while (index < length && isSpace(source[index]!)) index += 1
      const quote = source[index]
      if (quote === '"' || quote === '\'') {
        index += 1
        const valueStart = index
        while (index < length && source[index] !== quote) index += 1
        raw = source.slice(valueStart, index)
        index += 1
      } else {
        const valueStart = index
        while (index < length && !isSpace(source[index]!) && source[index] !== '>') index += 1
        raw = source.slice(valueStart, index)
      }
    }
    if (attributeName !== '') attributes[attributeName] = decodeXmlEntities(raw)
    // A degenerate attribute name (nothing consumed) would spin forever.
    if (attributeName === '' && raw === '') index += 1
  }
}

/**
 * Parse an attribute-only XML document into its element forest. Prologs,
 * comments, doctypes and CDATA are skipped; character data between elements is
 * ignored (uiautomator emits none). Mismatched close tags unwind to the
 * nearest matching ancestor instead of throwing — a truncated dump still
 * yields the part that arrived.
 */
export function parseXmlElements(source: string): XmlElement[] {
  const roots: XmlElement[] = []
  const stack: XmlElement[] = []
  const length = source.length
  let index = 0
  while (index < length) {
    const open = source.indexOf('<', index)
    if (open < 0) break
    index = open + 1
    if (index >= length) break
    if (source.startsWith('!--', index)) {
      const end = source.indexOf('-->', index)
      index = end < 0 ? length : end + 3
      continue
    }
    if (source.startsWith('![CDATA[', index)) {
      const end = source.indexOf(']]>', index)
      index = end < 0 ? length : end + 3
      continue
    }
    if (source[index] === '?' || source[index] === '!') {
      const end = source.indexOf('>', index)
      index = end < 0 ? length : end + 1
      continue
    }
    if (source[index] === '/') {
      const end = source.indexOf('>', index)
      if (end < 0) break
      const name = source.slice(index + 1, end).trim()
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]!.name === name) {
          stack.length = depth
          break
        }
      }
      index = end + 1
      continue
    }
    const tag = scanStartTag(source, index)
    if (tag.next < 0) break
    index = tag.next
    if (tag.name === '') continue
    const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [] }
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(element)
    else parent.children.push(element)
    if (!tag.selfClosing) stack.push(element)
  }
  return roots
}

// ── uiautomator hierarchy → UiTreeNode ───────────────────────────────────────

const BOUNDS_PATTERN = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

/** Parse `bounds="[l,t][r,b]"` into an origin+size box; unparseable → undefined. */
export function parseBounds(raw: string | undefined): UiBounds | undefined {
  if (raw === undefined) return undefined
  const match = BOUNDS_PATTERN.exec(raw.trim())
  if (match === null) return undefined
  const left = Number(match[1])
  const top = Number(match[2])
  const right = Number(match[3])
  const bottom = Number(match[4])
  if (![left, top, right, bottom].every(Number.isFinite)) return undefined
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** `android.widget.FrameLayout` → `FrameLayout`; empty class → `Node`. */
export function classTail(className: string | undefined): string {
  const trimmed = (className ?? '').trim()
  if (trimmed === '') return 'Node'
  const tail = trimmed.slice(trimmed.lastIndexOf('.') + 1)
  return tail === '' ? trimmed : tail
}

function attributeText(attributes: Record<string, string>, key: string): string | undefined {
  const value = attributes[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : value
}

function isTrue(attributes: Record<string, string>, key: string): boolean {
  return attributes[key] === 'true'
}

function toUiTreeNode(element: XmlElement): UiTreeNode {
  const attributes = element.attributes
  const node: UiTreeNode = {
    type: classTail(attributes.class),
    bounds: parseBounds(attributes.bounds) ?? { x: 0, y: 0, w: 0, h: 0 },
    children: [],
  }
  const className = attributeText(attributes, 'class')
  if (className !== undefined) node.className = className
  const text = attributeText(attributes, 'text')
  if (text !== undefined) node.text = text
  const contentDesc = attributeText(attributes, 'content-desc')
  if (contentDesc !== undefined) node.contentDesc = contentDesc
  const resourceId = attributeText(attributes, 'resource-id')
  if (resourceId !== undefined) node.resourceId = resourceId
  const packageName = attributeText(attributes, 'package')
  if (packageName !== undefined) node.packageName = packageName
  // Interesting state only: absent means enabled / not focused / not
  // clickable / not scrollable (see the module header). The password flag is
  // preserved so QA-facing surfaces can withhold the field's value.
  if (attributes.enabled === 'false') node.enabled = false
  if (isTrue(attributes, 'focused')) node.focused = true
  if (isTrue(attributes, 'clickable')) node.clickable = true
  if (isTrue(attributes, 'scrollable')) node.scrollable = true
  if (isTrue(attributes, 'password')) node.password = true
  for (const child of element.children) {
    if (child.name === 'node') node.children.push(toUiTreeNode(child))
  }
  return node
}

/** One parsed hierarchy: the window roots plus the display rotation it reported. */
export interface ParsedUiTree {
  roots: UiTreeNode[]
  /** `hierarchy rotation` (Surface.ROTATION_0..3), when the dump carried it. */
  rotation?: number
}

/**
 * Convert one uiautomator XML document into the compact node forest. The
 * `<hierarchy>` wrapper is unwrapped (its `node` children are the window
 * roots); a dump without it falls back to any top-level `node` elements so a
 * hand-trimmed fixture still parses.
 */
export function parseUiTree(xml: string): ParsedUiTree {
  const elements = parseXmlElements(xml)
  const hierarchy = elements.find(element => element.name === 'hierarchy')
  const source = hierarchy?.children ?? elements
  const roots = source.filter(element => element.name === 'node').map(toUiTreeNode)
  const rotationRaw = hierarchy?.attributes.rotation
  const rotation = rotationRaw === undefined ? undefined : Number(rotationRaw)
  return {
    roots,
    ...(rotation !== undefined && Number.isInteger(rotation) ? { rotation } : {}),
  }
}

/**
 * Strip everything around the hierarchy document. `uiautomator dump /dev/tty`
 * writes the XML and then its own confirmation line ("UI hierchary dumped to:
 * /dev/tty" — the typo is upstream's) onto the SAME stream, and a tty may
 * translate `\n` into `\r\n` on the way out.
 *
 * The document is anchored on its `<hierarchy` open tag, NOT on the first `<`
 * in the buffer: vendor images write their own noise to that same stream
 * BEFORE the XML, and that noise can itself contain a `<`. MIUI/HyperOS is the
 * measured case — `ThemeCompatibilityLoader` fails to open
 * /data/system/theme_config/theme_compatibility.xml and dumps a Java stack
 * trace whose frames read `java.io.FileInputStream.<init>(...)`; slicing from
 * the first `<` there prepends ~2 KB of stack trace to the document and the
 * parser yields zero nodes (reported as an empty tree at 0x0).
 */
export function extractHierarchyXml(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n')
  const end = text.lastIndexOf('</hierarchy>')
  if (end >= 0) {
    const start = text.indexOf('<hierarchy')
    if (start >= 0 && start < end) return text.slice(start, end + '</hierarchy>'.length)
    // Closing tag but no open tag: hand the parser the loosest plausible
    // document rather than nothing, so a malformed-but-recoverable dump still
    // has a chance (and a truly broken one surfaces as a zero-node tree).
    const looseStart = text.indexOf('<')
    return text.slice(looseStart < 0 ? 0 : looseStart, end + '</hierarchy>'.length)
  }
  // A self-closed or empty hierarchy still counts as a valid (if useless) dump.
  const empty = /<hierarchy\b[^>]*\/>/.exec(text)
  if (empty !== null) return empty[0]
  const snippet = text.trim().slice(0, 200)
  throw new Error(
    'the uiautomator dump did not contain a <hierarchy> document'
    + `${snippet === '' ? ' (the device produced no output)' : `: ${snippet}`}`,
  )
}

/** Everything one dump needs from the adb toolchain (the smoke fakes this). */
export interface UiTreeToolchain {
  execOut: AdbToolchain['execOut']
  shell: AdbToolchain['shell']
  /**
   * Optional fast path: the on-device bridge (an AccessibilityService reached
   * over a socket). Present only when the caller wired one up; `dump` resolves
   * `undefined` whenever the bridge is unavailable, which is the signal to use
   * uiautomator instead. Absent entirely in the smoke fakes, which then exercise
   * the classic path exactly as before.
   */
  bridge?: { dump(serial: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | undefined> }
}

/**
 * Dump the frontmost window hierarchy of `serial`.
 *
 * Primary path: `adb exec-out uiautomator dump /dev/tty` — one round trip, no
 * device-side file, and binary-safe so a CRLF-translating tty cannot corrupt
 * the payload. Some vendor images refuse `/dev/tty` (permission denied, or an
 * empty stream); the fallback writes `/sdcard/window_dump.xml`, cats it back,
 * and removes it again so nothing is left behind.
 */
export async function dumpUiTreeXml(
  toolchain: UiTreeToolchain,
  serial: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    /** Called once with the path that produced the XML, for diagnostics. */
    onSource?: (source: UiTreeSource) => void
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DUMP_TIMEOUT_MS
  const execOptions = { timeoutMs, maxBuffer: DUMP_MAX_BUFFER, ...(options.signal === undefined ? {} : { signal: options.signal }) }

  // FAST PATH: the on-device bridge, when one is installed AND enabled.
  //
  // Measured on a Xiaomi Pad 5: uiautomator costs 2.43 s (0.51 s JVM start plus
  // 1.16 s class loading, paid per call because the CLI is a fresh process every
  // time), while the bridge — a system-managed AccessibilityService that stays
  // alive — answers in 25-56 ms. That is the ~7x-50x this whole path exists for.
  //
  // It is tried FIRST but is strictly optional: `dump` returns undefined for a
  // missing APK, a revoked accessibility grant, a screen that is off, or any
  // transport error, and the uiautomator path below then runs unchanged. So a
  // device without the bridge behaves exactly as it always did, just slower —
  // and no caller can tell the difference except by the clock.
  if (toolchain.bridge !== undefined) {
    const throughBridge = await toolchain.bridge
      .dump(serial, { timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      .catch(() => undefined)
    if (throughBridge !== undefined) {
      options.onSource?.('bridge')
      return extractHierarchyXml(throughBridge)
    }
  }
  options.onSource?.('uiautomator')

  let primaryFailure: string | undefined
  // "could not get idle state" earns at most one retry after a short pause: a
  // transient animation (screen-on ripple, app launch) settles in well under a
  // second, while a CONTINUOUSLY animating foreground (a web page with a
  // spinner is the classic case) will fail again — and then the error below
  // routes the caller to OCR instead of a retry loop.
  //
  // Cost note (measured on a 1536x2560 device): one dump is ~2.4 s and the
  // worst case — two primary attempts, the 800 ms pause, then the /sdcard
  // fallback — is ~8.1 s, i.e. 3.4x the happy path. The retry is therefore
  // GATED rather than blind: a ~130 ms screen fingerprint decides whether the
  // screen actually moved while we waited. If it did not move, the same
  // foreground is animating the same way and a second 2.4 s dump is provably
  // wasted, so we go straight to the fallback (which writes a file and reads
  // it back — a genuinely different code path, not a repeat).
  const beforeRetry = await screenFingerprint(toolchain, serial)
  // Whether the primary was actually RE-attempted after the settle. Only a real
  // second failure proves the foreground never idles; a gate-skipped retry
  // proves nothing, so the fallback (a different path) must still be tried.
  let retried = false
  let skippedRedundantRetry = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const buffer = await toolchain.execOut(serial, ['uiautomator', 'dump', '/dev/tty'], execOptions)
      return extractHierarchyXml(buffer.toString('utf8'))
    } catch (error) {
      primaryFailure = error instanceof Error ? error.message : String(error)
      if (attempt === 0 && /could not get idle state/i.test(primaryFailure)) {
        await new Promise(resolve => setTimeout(resolve, 800))
        const after = await screenFingerprint(toolchain, serial)
        // Unknown digest (fingerprint unavailable) must NOT be read as
        // "unchanged": retry, because the cheap signal failed, not the screen.
        if (after.digest === '' || after.digest !== beforeRetry.digest) {
          retried = true
          continue
        }
        skippedRedundantRetry = true
        primaryFailure = `${primaryFailure} (the screen did not change during the 800 ms settle, so a `
          + 'second identical dump was skipped)'
        break
      }
      break
    }
  }
  if (retried && primaryFailure !== undefined && /could not get idle state/i.test(primaryFailure)) {
    // TWO full primary attempts both failed on idle: this foreground genuinely
    // never idles, so the /sdcard fallback would run the same dump and fail the
    // same way — paying its ~2.4 s to prove that helps nobody.
    throw new Error(
      `uiautomator could not dump the window hierarchy of ${serial} (${primaryFailure}). `
      + 'The foreground app is continuously animating (web pages in a browser are the classic case), '
      + 'so uiautomator can never reach its idle state — do not retry this tool; read the screen with '
      + 'android_find_text and tap with android_tap_text instead (OCR reads pixels and needs no idle).',
    )
  }
  const remotePath = '/sdcard/window_dump.xml'
  try {
    const notice = await toolchain.shell(serial, ['uiautomator', 'dump', remotePath], execOptions)
    const buffer = await toolchain.execOut(serial, ['cat', remotePath], execOptions)
    const xml = extractHierarchyXml(buffer.toString('utf8'))
    await toolchain.shell(serial, ['rm', '-f', remotePath], execOptions).catch(() => {})
    if (xml.trim() === '') throw new Error(notice.trim())
    return xml
  } catch (error) {
    await toolchain.shell(serial, ['rm', '-f', remotePath], execOptions).catch(() => {})
    const fallbackFailure = error instanceof Error ? error.message : String(error)
    const idleStarved = /could not get idle state/i.test(`${primaryFailure} ${fallbackFailure}`)
    const skippedNote = skippedRedundantRetry
      ? ' NOTE: the second primary dump was skipped after the cheap screen fingerprint showed the screen had '
        + 'not moved; the /sdcard fallback is a genuinely different path, so it was still attempted.'
      : ''
    throw new Error(
      `uiautomator could not dump the window hierarchy of ${serial} `
      + `(exec-out /dev/tty: ${primaryFailure}; ${remotePath} fallback: ${fallbackFailure}). `
      + (idleStarved
        // Already retried once above: a foreground that STILL never idles is
        // continuously animating, and no number of dump retries will land.
        ? 'The foreground app is continuously animating (web pages in a browser are the classic case), '
          + 'so uiautomator can never reach its idle state — do not retry this tool; read the screen with '
          + 'android_find_text and tap with android_tap_text instead (OCR reads pixels and needs no idle).'
        : 'uiautomator needs the screen ON and an idle window — wake the device (android_interact with '
          + 'button "wake"), wait for animations to settle, and retry; if it keeps failing the screen is '
          + 'likely secure (FLAG_SECURE) and only android_find_text can read it.')
      + skippedNote,
    )
  }
}

/** Dump and parse in one step. */
export async function readUiTree(
  toolchain: UiTreeToolchain,
  serial: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ParsedUiTree> {
  return parseUiTree(await dumpUiTreeXml(toolchain, serial, options))
}

/**
 * Which path produced a tree: the on-device bridge, or uiautomator.
 *
 * Reported because both are CORRECT and differ only in speed -- measured 71 ms
 * against ~3500 ms. Nothing in a result used to distinguish them, so a session
 * paying 50x could not notice, and a user asking "why is this slow" had no
 * answer anywhere in the output.
 */
export type UiTreeSource = 'bridge' | 'uiautomator'

/**
 * {@link readUiTree} plus the source it came from.
 *
 * Kept as a separate entry point so no existing caller changes: the plain
 * `readUiTree` still returns just the tree.
 */
export async function readUiTreeWithSource(
  toolchain: UiTreeToolchain,
  serial: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ tree: ParsedUiTree; source: UiTreeSource }> {
  let source: UiTreeSource = 'uiautomator'
  const tree = parseUiTree(await dumpUiTreeXml(toolchain, serial, {
    ...options,
    onSource: (value) => { source = value },
  }))
  return { tree, source }
}

// ── tree shaping ─────────────────────────────────────────────────────────────

/** Screen bounds in display pixels, taken from the widest/tallest root. */
export function screenBoundsOf(roots: readonly UiTreeNode[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const root of roots) {
    width = Math.max(width, root.bounds.x + root.bounds.w)
    height = Math.max(height, root.bounds.y + root.bounds.h)
  }
  if (width <= 0 || height <= 0) {
    const fallback = roots.length > 0 ? roots[0]!.bounds : { w: 0, h: 0 }
    width = fallback.w
    height = fallback.h
  }
  return { width, height }
}

/**
 * The display space the `input` command actually uses.
 *
 * MEASURED DIVERGENCE (Xiaomi Pad 5, MIUI 14, landscape):
 *   `uiautomator dump` root bounds  = 2560 x 1500   <- the APP frame
 *   `wm size` / `screencap` PNG     = 2560 x 1536   <- the FULL display
 *
 * The two spaces share an ORIGIN (both start at 0,0) and differ only in extent:
 * the app frame is the display minus the system bars, which are at the far edge.
 * Verified on the device — a tap sent at the tree's own pixel lands correctly,
 * so no coordinate translation is needed, only the right denominator.
 *
 * The bug this documents: tap tools normalized with the TREE height (1500) while
 * the host multiplied the result back by the LIVE FRAME height (1536). A
 * mismatched denominator pair scales every tap by 1536/1500 = 1.024, so a target
 * at y=1418 was tapped at 1452 — 34 px low, and anything within ~35 px of the
 * app-frame's bottom edge fell outside the app frame, where the system gesture
 * strip swallowed it (observed as "the tap silently did nothing").
 */
export interface InputSpace {
  /** The display size `input` uses (full display, orientation-aware). */
  width: number
  height: number
}

/**
 * A pixel from a UI-tree node → normalized 0..1 of the `input` space.
 *
 * The pixel itself is NOT rescaled: the tree's pixel grid and the input grid
 * share an origin and a scale (verified: tapping the tree's own pixels works).
 * Only the denominator must be the input space, because that is what the host
 * multiplies by to get back to pixels.
 */
export function treePixelToInput(
  pixel: { x: number; y: number },
  input: InputSpace,
  round: (value: number) => number,
): { x: number; y: number } {
  return {
    x: round(pixel.x / input.width),
    y: round(pixel.y / input.height),
  }
}

/**
 * True when `bounds` lies ENTIRELY outside the screen. uiautomator keeps
 * scrolled-out rows in the dump with their real (off-screen) coordinates and
 * exposes no visibility flag, so geometry is the only signal — the same
 * predicate the AXe path used in dsh-ios.
 */
export function isOffscreenBounds(bounds: UiBounds, screen: { width: number; height: number }): boolean {
  if (screen.width <= 0 || screen.height <= 0) return false
  // A zero-AREA box can never be tapped, so it counts as off-screen too. This
  // has to be checked on its own, not inferred from the bounds test below: a
  // box with w=0 or h=0 at a real position is INSIDE the screen, and its
  // 'center' is a degenerate point on its own edge.
  //
  // This is the shape MIUI reports for a recycled or collapsed RecyclerView
  // row -- bounds like [x,1000][x+200,1000]. Measured: such a node passed the
  // gate, was tapped at that edge point, and the tap landed on whatever
  // actually occupied it. The observer reasonably concluded their aim was off
  // and retried four times, when the real problem was that the target had no
  // area to hit. The comment below already stated the rule; only the
  // out-of-screen half of it was implemented.
  if (bounds.w <= 0 || bounds.h <= 0) return true
  return bounds.x + bounds.w <= 0
    || bounds.y + bounds.h <= 0
    || bounds.x >= screen.width
    || bounds.y >= screen.height
}

/** Case-insensitive substring match over text, content-desc, resource-id and type. */
export function nodeMatchesFilter(node: UiTreeNode, needle: string): boolean {
  const haystacks = [node.type, node.text, node.contentDesc, node.resourceId]
  return haystacks.some(value => value !== undefined && value.toLowerCase().includes(needle))
}

function copyNode(node: UiTreeNode): UiTreeNode {
  const copy: UiTreeNode = { type: node.type, bounds: { ...node.bounds }, children: [] }
  if (node.className !== undefined) copy.className = node.className
  if (node.text !== undefined) copy.text = node.text
  if (node.contentDesc !== undefined) copy.contentDesc = node.contentDesc
  if (node.resourceId !== undefined) copy.resourceId = node.resourceId
  if (node.packageName !== undefined) copy.packageName = node.packageName
  if (node.enabled !== undefined) copy.enabled = node.enabled
  if (node.focused !== undefined) copy.focused = node.focused
  if (node.clickable !== undefined) copy.clickable = node.clickable
  if (node.scrollable !== undefined) copy.scrollable = node.scrollable
  if (node.password !== undefined) copy.password = node.password
  return copy
}

/**
 * Build the output tree: an optional case-insensitive substring filter (a node
 * survives when it or any descendant matches — ancestors of matches are kept
 * so the tree stays connected) and an optional nesting depth cap.
 */
export function buildCompactTree(
  roots: readonly UiTreeNode[],
  maxDepth?: number,
  filter?: string,
): { tree: UiTreeNode[]; count: number } {
  const needle = filter !== undefined && filter.trim() !== '' ? filter.trim().toLowerCase() : undefined
  let count = 0
  const walk = (node: UiTreeNode, depth: number): UiTreeNode | undefined => {
    const selfMatches = needle === undefined || nodeMatchesFilter(node, needle)
    const children: UiTreeNode[] = []
    if (maxDepth === undefined || depth < maxDepth) {
      for (const child of node.children) {
        const compact = walk(child, depth + 1)
        if (compact !== undefined) children.push(compact)
      }
    }
    if (!selfMatches && children.length === 0) return undefined
    const copy = copyNode(node)
    copy.children = children
    count += 1
    return copy
  }
  const tree: UiTreeNode[] = []
  for (const root of roots) {
    const compact = walk(root, 0)
    if (compact !== undefined) tree.push(compact)
  }
  return { tree, count }
}

/** Count nodes of an already-built compact tree (the node itself included). */
export function countNodes(node: UiTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
}

function treeDepth(nodes: readonly UiTreeNode[]): number {
  let depth = 0
  for (const node of nodes) {
    if (node.children.length > 0) depth = Math.max(depth, 1 + treeDepth(node.children))
  }
  return depth
}

function pruneDeepestLevel(nodes: readonly UiTreeNode[]): void {
  const depth = treeDepth(nodes)
  if (depth === 0) return
  const pruneAt = (list: readonly UiTreeNode[], level: number): void => {
    for (const node of list) {
      if (level === depth - 1) node.children = []
      else pruneAt(node.children, level + 1)
    }
  }
  pruneAt(nodes, 0)
}

function treeBytes(nodes: readonly UiTreeNode[]): number {
  return Buffer.byteLength(JSON.stringify(nodes), 'utf8')
}

/**
 * Fit a compact tree under `capBytes` by pruning the deepest levels first —
 * the same strategy the `max_depth` hint offers interactively. Mutates the
 * nodes it is handed (they are already the tool's private copies).
 */
export function capTreeToBytes(
  tree: UiTreeNode[],
  capBytes: number = UI_TREE_CAP_BYTES,
): { tree: UiTreeNode[]; truncated: boolean } {
  let truncated = treeBytes(tree) > capBytes
  while (treeBytes(tree) > capBytes && treeDepth(tree) > 0) {
    pruneDeepestLevel(tree)
  }
  if (!truncated) truncated = treeBytes(tree) > capBytes
  return { tree, truncated }
}

/**
 * Fit a compact tree under `capBytes` WITHOUT silently deleting information.
 *
 * The old strategy pruned the deepest level outright, which is the worst choice
 * twice over: that level holds the MOST SPECIFIC controls (the button inside the
 * row), and the caller received a tree that LOOKS complete while an arbitrary set
 * of controls had vanished. The hint said \"deepest levels were pruned\" but never
 * which ones, so a model could act on an incomplete picture without knowing it.
 *
 * This SHRINKS instead of severing: it keeps as many siblings per level as fit,
 * preferring ADDRESSABLE ones, and records exactly what it dropped so the caller
 * knows the tree is a sample and where the gaps are.
 *
 * Mutates the nodes it is handed (they are already the tool's private copies).
 */
export function capTreeToBytesSafely(
  tree: UiTreeNode[],
  capBytes: number = UI_TREE_CAP_BYTES,
): { tree: UiTreeNode[]; truncated: boolean; elisions: string[] } {
  const elisions: string[] = []
  const bytes = (): number => Buffer.byteLength(JSON.stringify(tree), 'utf8')
  if (bytes() <= capBytes) return { tree, truncated: false, elisions }
  const addressable = (node: UiTreeNode): boolean =>
    (node.text !== undefined && node.text !== '')
    || (node.contentDesc !== undefined && node.contentDesc !== '')
    || (node.resourceId !== undefined && node.resourceId !== '')
    || node.clickable === true

  // Thin sibling lists deepest-first, keeping addressable siblings ahead of
  // scaffolding, until the tree fits or no container has anything left to cut.
  const containers: UiTreeNode[] = []
  const collect = (nodes: readonly UiTreeNode[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0) containers.push(node)
      collect(node.children)
    }
  }
  collect(tree)
  // Deepest first: cutting there removes the least structure per byte saved.
  const depthOf = (node: UiTreeNode, from: readonly UiTreeNode[], d: number): number => {
    for (const n of from) {
      if (n === node) return d
      const found = depthOf(node, n.children, d + 1)
      if (found >= 0) return found
    }
    return -1
  }
  containers.sort((a, b) => depthOf(b, tree, 0) - depthOf(a, tree, 0))
  for (const container of containers) {
    if (bytes() <= capBytes) break
    while (container.children.length > 1 && bytes() > capBytes) {
      const ranked = [...container.children].sort(
        (a, b) => Number(addressable(a)) - Number(addressable(b)),
      )
      const victim = ranked[0]!
      const at = container.children.indexOf(victim)
      if (at < 0) break
      container.children.splice(at, 1)
      const label = container.type
        + (container.resourceId === undefined ? '' : ' (' + container.resourceId + ')')
      elisions.push(
        1 + ' node under ' + label
        + (addressable(victim) ? ' (addressable)' : '') + ' was omitted.',
      )
    }
  }
  const truncated = bytes() > capBytes
  if (truncated) {
    elisions.push('The hierarchy is still above the output budget; narrow it with filter or max_depth.')
  }
  return { tree, truncated: truncated || elisions.length > 0, elisions }
}

/**
 * Render elisions as a SHORT grouped summary.
 *
 * Reporting what was dropped is right; reporting it once per dropped subtree is
 * not — a dense calendar screen produced 102 near-identical lines and 10.6 KB of
 * hint, a third of the budget it was describing and exactly the bloat this work
 * is meant to remove. Grouping by container turns that into a few lines.
 */
export function summarizeElisions(elisions: readonly string[], maxGroups = 4): string {
  if (elisions.length === 0) return ''
  const counts = new Map<string, number>()
  let other = 0
  for (const line of elisions) {
    const m = /^1 node under ([^(]+?)(?: \(([^)]+)\))?( \(addressable\))? was omitted\.$/.exec(line)
    if (m === null) { other += 1; continue }
    const key = m[1]!.trim() + (m[2] === undefined ? '' : ' (' + m[2] + ')')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxGroups)
  const parts = top.map(([key, n]) => n + ' under ' + key)
  const rest = counts.size - top.length + other
  return 'Omitted: ' + parts.join('; ')
    + (rest > 0 ? '; and ' + rest + ' other container(s)' : '') + '.'
}
/**
 * True when a node carries something an agent can ACT on or decide WITH.
 *
 * A node with no text, no content-desc and no resource-id is not addressable:
 * the agent cannot name it, cannot ask for it, and cannot tell it apart from its
 * siblings. Those are what make a full dump expensive without adding a handle.
 * Measured on one 188-node screen: 160 nodes had a label, 3 were
 * clickable-but-unlabeled, and the rest were structural scaffolding.
 */
function isActionable(node: UiTreeNode): boolean {
  return (node.text !== undefined && node.text !== '')
    || (node.contentDesc !== undefined && node.contentDesc !== '')
    || (node.resourceId !== undefined && node.resourceId !== '')
    || node.clickable === true
    || node.scrollable === true
}

/**
 * Collapse the tree to addressable nodes, keeping each one's original depth.
 *
 * An unlabeled single-child chain is pure pass-through: it has no handle and its
 * one child occupies the same place, so promoting the child loses nothing.
 * Nodes with SEVERAL children are kept even when unlabeled, because they carry
 * the grouping an agent needs to tell which control belongs to which row.
 *
 * Depth is returned rather than nested children: the braces and the repeated
 * 'children' key are most of what makes the nested form large.
 */
export function buildActionableView(roots: readonly UiTreeNode[]): {
  nodes: Array<{ depth: number; node: UiTreeNode }>
  kept: number
  dropped: number
} {
  const nodes: Array<{ depth: number; node: UiTreeNode }> = []
  let kept = 0
  let dropped = 0
  const visit = (start: UiTreeNode, startDepth: number): void => {
    let current = start
    let depth = startDepth
    while (!isActionable(current) && (current.children?.length ?? 0) === 1) {
      dropped += 1
      current = current.children![0]!
      depth += 1
    }
    if (isActionable(current)) {
      kept += 1
      nodes.push({ depth, node: current })
    } else {
      dropped += 1
    }
    for (const child of current.children ?? []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  return { nodes, kept, dropped }
}
/** True when the tree carries at least one labeled node (text or content-desc). */
export function hasLabeledNode(nodes: readonly UiTreeNode[]): boolean {
  for (const node of nodes) {
    if (node.text !== undefined || node.contentDesc !== undefined) return true
    if (hasLabeledNode(node.children)) return true
  }
  return false
}

// ── selector resolution ──────────────────────────────────────────────────────

/** Flattened node used for selector resolution (depth carries the specificity). */
export interface FlatUiNode extends UiTreeNode {
  depth: number
}

/** Depth-first flatten, roots first. */
export function flattenNodes(roots: readonly UiTreeNode[]): FlatUiNode[] {
  const flat: FlatUiNode[] = []
  const walk = (node: UiTreeNode, depth: number): void => {
    flat.push({ ...node, depth })
    for (const child of node.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return flat
}

/** Tolerance (pixels) for containment checks — rounding, not layout, slack. */
const BOUNDS_EPSILON = 1

/** True when `outer` (approximately) contains `inner`. */
export function containsBounds(outer: UiBounds, inner: UiBounds): boolean {
  return outer.x <= inner.x + BOUNDS_EPSILON
    && outer.y <= inner.y + BOUNDS_EPSILON
    && outer.x + outer.w >= inner.x + inner.w - BOUNDS_EPSILON
    && outer.y + outer.h >= inner.y + inner.h - BOUNDS_EPSILON
}

/** True when two boxes are the same box (mutual containment). */
/**
 * A seek bar's tap point for a fraction of its track.
 *
 * Measured against a real MIUI dialog (Scene's SWAP page): three SeekBars of
 * 1410x45 px, each with its value in an adjacent TextView. Two things that
 * shaped this:
 *
 * 1. `input swipe` DOES NOT WORK on them. Reproduced on the device -- a drag
 *    across the track left the value unchanged AND dismissed the dialog, because
 *    the gesture was read by the parent as a dismiss. A TAP on the track sets
 *    the value, which is what a person's finger does too.
 * 2. The MAXIMUM is not in the hierarchy. A uiautomator dump reports bounds and
 *    the current text, never the range, so an absolute value cannot be converted
 *    to a position. A FRACTION can: it needs only the bounds.
 *
 * The point is inset from both ends by half the widget height. Thumb travel
 * usually spans the full width, but a tap exactly on the boundary can land
 * outside the widget's touch region, so the extremes are pulled in just enough
 * to stay inside without meaningfully shifting the value.
 */
/**
 * Label text lying on the same visual ROW as a widget, read back after a tap.
 *
 * A SeekBar does not expose its value: the number lives in a sibling TextView.
 * On MIUI's SWAP dialog the slider is 1410x45 at y=1151 and its value ("50") is
 * a separate node at y=1070. "Same row" therefore means vertically near the
 * widget's centre line, within one widget height -- which is how these dialogs
 * lay a value out beside or just above its control.
 *
 * Returns at most a handful of strings, deduped, so the result stays small and a
 * before/after comparison is meaningful.
 */
export function nearbyLabelText(roots: readonly UiTreeNode[], bounds: UiBounds): string[] {
  const flat = flattenNodes(roots)
  // The band must reach the row ABOVE the widget, not just its own line:
  // measured on MIUI's SWAP dialog the slider is at y=1151 h=45 (centre 1173.5)
  // while its value "50" sits at y=1070 h=44 (centre 1092) -- 81 px away, so a
  // one-height band misses the very label the caller needs to confirm the set.
  const centre = bounds.y + bounds.h / 2
  const slack = Math.max(bounds.h * 2, 64)
  const texts: string[] = []
  for (const node of flat) {
    const value = node.text ?? node.contentDesc
    if (value === undefined || value.trim() === '') continue
    const nodeCentre = node.bounds.y + node.bounds.h / 2
    if (Math.abs(nodeCentre - centre) > slack) continue
    texts.push(value.trim())
    if (texts.length >= 6) break
  }
  return [...new Set(texts)]
}
export function seekBarTapPoint(
  bounds: UiBounds,
  fraction: number,
  round: (value: number) => number = Math.round,
): { x: number; y: number } {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`dsh-android: seekbar fraction must be within 0..1, got ${String(fraction)}`)
  }
  const inset = Math.min(bounds.h / 2, bounds.w / 4)
  return {
    x: round(bounds.x + inset + fraction * (bounds.w - 2 * inset)),
    y: round(bounds.y + bounds.h / 2),
  }
}
export function sameBounds(a: UiBounds, b: UiBounds): boolean {
  return containsBounds(a, b) && containsBounds(b, a)
}

/**
 * Widget classes that ARE controls even when the platform did not mark them
 * clickable (a disabled Button reports clickable="false"). `clickable=true`
 * remains the primary signal; this set only rescues the chain-folding step.
 */
const CONTROL_TYPES = new Set([
  'Button', 'ImageButton', 'CompoundButton', 'CheckBox', 'CheckedTextView',
  'RadioButton', 'Switch', 'SwitchCompat', 'ToggleButton', 'MaterialButton',
  'EditText', 'AutoCompleteTextView', 'SearchView', 'SeekBar', 'RatingBar',
  'Spinner', 'TabWidget', 'ActionMenuItemView', 'MenuItem', 'Chip',
  'FloatingActionButton', 'BottomNavigationItemView', 'NavigationMenuItemView',
])

function isControl(node: UiTreeNode): boolean {
  return node.clickable === true || CONTROL_TYPES.has(node.type)
}

/** How a selector matched. */
export type UiMatchMode = 'exact' | 'contains'

/** One resolved tap target. */
export interface ResolvedUiTarget {
  node: FlatUiNode
  matchedBy: UiMatchMode
}

/** Selector fields: `identifier` is the resource-id, `label` is text OR content-desc. */
export interface UiSelector {
  identifier?: string
  label?: string
}

export interface ResolveTapOptions {
  /** Tap a node whose bounds lie outside the screen (default false). */
  allowOffscreen?: boolean
  /** Tool name used in the thrown messages (default `android_tap_element`). */
  tool?: string
}

function describeCandidate(node: FlatUiNode, index: number): string {
  const text = node.text === undefined ? '' : ` text=${JSON.stringify(node.text)}`
  const desc = node.contentDesc === undefined ? '' : ` content-desc=${JSON.stringify(node.contentDesc)}`
  const id = node.resourceId === undefined ? '' : ` resource-id=${JSON.stringify(node.resourceId)}`
  // The false flags are the ones that explain a skip; true is the normal
  // state and stays implicit.
  const flags = node.enabled === false ? ' enabled=false' : ''
  const bounds = `bounds={x:${node.bounds.x},y:${node.bounds.y},w:${node.bounds.w},h:${node.bounds.h}}`
  return `${index}) type=${node.type}${text}${desc}${id}${flags} ${bounds}`
}

/** Actionable refusal when every selector match is off-screen or disabled. */
function tapGateFailure(
  tool: string,
  representatives: readonly FlatUiNode[],
  screen: { width: number; height: number },
  wanted: string,
  allowOffscreen: boolean,
): never {
  const offscreen = representatives.filter(node => isOffscreenBounds(node.bounds, screen))
  const disabled = representatives.filter(node => node.enabled === false)
  const hint = allowOffscreen ? ' (allow_offscreen=true bypasses only the off-screen check — disabled stays refused)' : ''
  if (offscreen.length > 0 && disabled.length > 0) {
    throw new Error(
      `${tool}: ${wanted} matched ${representatives.length} node(s) that are off-screen or disabled`
      + ` — scroll the off-screen ones into view first and enable the disabled ones${hint}`,
    )
  }
  if (offscreen.length > 0) {
    const noun = representatives.length === 1
      ? 'matched an off-screen node'
      : `matched ${representatives.length} off-screen nodes`
    throw new Error(
      `${tool}: ${wanted} ${noun} — scroll it into view first (android_interact with a scroll action), `
      + 'then re-run android_ui_tree so the fresh dump re-locates it'
      + `; pass allow_offscreen=true to tap the recorded coordinates anyway${hint}`,
    )
  }
  const noun = representatives.length === 1 ? 'matched a disabled node' : `matched ${representatives.length} disabled nodes`
  throw new Error(
    `${tool}: ${wanted} ${noun} — the control is disabled, so a tap would do nothing; enable it first${hint}`,
  )
}

/**
 * Resolve one node from a selector.
 *
 * `identifier` matches the resource-id; `label` matches the text OR the
 * content-desc (Android splits what iOS merged into one accessibility label,
 * so one selector field covers both). Exact (case-sensitive) equality wins;
 * otherwise case-insensitive substring. When both fields are given both must
 * match.
 *
 * Nested duplicates — a list row mirrors its text onto a child TextView, and
 * the clickable container wraps them both — collapse into ONE chain by bounds
 * containment; the chain's outermost control (clickable, or a control widget
 * class) is the tap target, falling back to the deepest, most specific node
 * when the chain contains no control at all.
 *
 * Safety gate: matches that are off-screen (bounds entirely outside the
 * screen) or disabled (`enabled="false"`) are NOT tappable. When every match
 * fails the gate the resolver throws an actionable error naming the fix;
 * `allowOffscreen` skips only the off-screen half — a disabled node always
 * refuses. Distinct nodes that all survive the gate raise an ambiguity error
 * listing up to 8 candidates with their text, id, bounds and false flags, so
 * the model can see why a candidate was skipped.
 */
export function resolveTapTarget(
  roots: readonly UiTreeNode[],
  selector: UiSelector,
  options: ResolveTapOptions = {},
): ResolvedUiTarget {
  const tool = options.tool ?? 'android_tap_element'
  const identifier = selector.identifier !== undefined && selector.identifier.trim() !== ''
    ? selector.identifier.trim()
    : undefined
  const label = selector.label !== undefined && selector.label.trim() !== '' ? selector.label.trim() : undefined
  if (identifier === undefined && label === undefined) {
    throw new Error(
      `${tool} requires an element selector: identifier (the resource-id) and/or label `
      + '(the text or content-desc). Run android_ui_tree to see what the screen exposes.',
    )
  }
  const flat = flattenNodes(roots)
  const matchesValue = (actual: string | undefined, wantedValue: string, mode: UiMatchMode): boolean => {
    if (actual === undefined) return false
    return mode === 'exact' ? actual === wantedValue : actual.toLowerCase().includes(wantedValue.toLowerCase())
  }
  const matchesNode = (node: FlatUiNode, mode: UiMatchMode): boolean => {
    if (identifier !== undefined && !matchesValue(node.resourceId, identifier, mode)) return false
    if (label !== undefined
      && !matchesValue(node.text, label, mode)
      && !matchesValue(node.contentDesc, label, mode)) return false
    return true
  }
  let candidates = flat.filter(node => matchesNode(node, 'exact'))
  let matchedBy: UiMatchMode = 'exact'
  if (candidates.length === 0) {
    candidates = flat.filter(node => matchesNode(node, 'contains'))
    matchedBy = 'contains'
  }
  const wantedParts: string[] = []
  if (identifier !== undefined) wantedParts.push(`identifier ${JSON.stringify(identifier)}`)
  if (label !== undefined) wantedParts.push(`label ${JSON.stringify(label)}`)
  const wanted = wantedParts.join(' and ')
  if (candidates.length === 0) {
    throw new Error(
      `${tool}: no node matches ${wanted} on the current screen — run android_ui_tree to inspect what is `
      + 'actually there, or android_find_text to OCR labels the view hierarchy does not carry '
      + '(Compose/Flutter/WebView/game canvases often expose none).',
    )
  }
  // Drop exact box duplicates of the same class (a wrapper listed twice).
  const unique = candidates.filter((node, index) => !candidates
    .slice(0, index)
    .some(other => other.type === node.type && sameBounds(other.bounds, node.bounds)))
  // Group containment chains: an ancestor that mirrors its child's text is
  // the same row, not an ambiguity.
  const chains: FlatUiNode[][] = []
  for (const node of unique) {
    const chain = chains.find(group => group.some(other =>
      !sameBounds(node.bounds, other.bounds)
      && (containsBounds(node.bounds, other.bounds) || containsBounds(other.bounds, node.bounds)),
    ))
    if (chain === undefined) chains.push([node])
    else chain.push(node)
  }
  const representatives = chains.map(chain => {
    const controls = chain.filter(isControl)
    if (controls.length > 0) {
      // Outermost control of the chain: not contained in another control.
      const outer = controls.find(node => !controls.some(other =>
        other !== node && containsBounds(other.bounds, node.bounds) && !sameBounds(other.bounds, node.bounds),
      ))
      return outer ?? controls[0]!
    }
    // No control in the chain: the deepest (most specific) node it is.
    return chain.reduce((deepest, node) => (node.depth > deepest.depth ? node : deepest), chain[0]!)
  })
  const screen = screenBoundsOf(roots)
  const allowOffscreen = options.allowOffscreen === true
  const viable = representatives.filter(node =>
    node.enabled !== false && (allowOffscreen || !isOffscreenBounds(node.bounds, screen)),
  )
  if (viable.length === 0) tapGateFailure(tool, representatives, screen, wanted, allowOffscreen)
  if (viable.length > 1) {
    const skipped = representatives.length - viable.length
    const skippedSentence = skipped > 0 ? ` (${skipped} skipped: off-screen or disabled)` : ''
    const shown = representatives.slice(0, 8)
    const more = representatives.length - shown.length
    throw new Error(
      `${tool}: ${representatives.length} nodes match ${wanted}${skippedSentence} — use a more specific `
      + 'selector (an exact label, a resource-id, or android_ui_tree to disambiguate). Candidates:\n'
      + shown.map((node, index) => `  ${describeCandidate(node, index + 1)}`).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''),
    )
  }
  return { node: viable[0]!, matchedBy }
}

/** Center of a box in display pixels (integers: `input tap` takes pixels). */
export function boundsCenter(bounds: UiBounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.w / 2),
    y: Math.round(bounds.y + bounds.h / 2),
  }
}
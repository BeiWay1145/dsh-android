/**
 * Tesseract OCR backend — the non-macOS half of the OCR seam.
 *
 * WHY THIS EXISTS
 * The bundled Vision helper needs macOS (Vision is an Apple framework), which
 * left android_find_text / android_tap_text / android_wait_for COMPLETELY
 * unavailable on Windows and Linux. That is a large hole: OCR is the only way to
 * read a screen whose accessibility tree is empty (Unity, Flutter-impeller,
 * game canvases, video surfaces) or whose text is drawn rather than built
 * (badge counts, prices in an image). Tesseract is a plain executable that is
 * widely installed and reads CJK well enough to use.
 *
 * THE PART THAT IS NOT OBVIOUS: CJK TOKENISATION
 * Tesseract's TSV emits WORD-level rows, and for Chinese it segments per
 * CHARACTER — "设置" arrives as "设" and "置" as two separate items. The plugin's
 * matcher (ocrTextPresent) is exact-then-substring, so against raw word rows
 * every multi-character Chinese query silently fails to match:
 *
 *     query "设置"  ->  NO MATCH   (the items are "设" and "置")
 *     query "WLAN" ->  MATCH
 *
 * So this backend re-groups the words by Tesseract's own block/paragraph/line
 * columns and emits ONE item per LINE. Measured on a real 1536x2560 screenshot,
 * that turns the queries above into hits at 0.92-0.96 confidence with correct
 * pixel boxes.
 *
 * Note the TSV's line rows (level 4) carry NO text of their own — the grouping
 * has to be done here, from the words, not read off the file.
 *
 * @module @zseven-w/dsh-android/ocr-tesseract
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { OcrItem } from './ocr-backend.js'

/** Environment override for the Tesseract executable. */
export const TESSERACT_ENV = 'DSHPLUGIN_ANDROID_TESSERACT'

/** Environment override for extra recognition languages, e.g. "chi_sim+eng+jpn". */
export const TESSERACT_LANGS_ENV = 'DSHPLUGIN_ANDROID_TESSERACT_LANGS'

/** Well-known Windows install locations, probed when PATH is trimmed. */
const WINDOWS_TESSERACT_CANDIDATES = [
  'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
  'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
]

/**
 * Recognition languages, most useful first.
 *
 * Tesseract tolerates a language that is not installed by warning and skipping
 * it, so listing several is safe on a machine that has only some of them. The
 * default favours the plugin's audience (zh-Hans + English); override with
 * TESSERACT_LANGS_ENV when a device needs something else.
 */
export const DEFAULT_TESSERACT_LANGS = 'chi_sim+eng'

const OCR_EXEC_TIMEOUT_MS = 120_000
const OCR_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** One resolved Tesseract executable. */
export interface TesseractBinary {
  available: boolean
  command?: string
  reason?: string
}

/**
 * Find the Tesseract executable.
 *
 * Resolution order: the explicit env override, then PATH, then the well-known
 * install locations. The env var pointing at a missing file is reported as
 * such rather than silently falling through — an override that does not work is
 * worth telling the user about.
 */
export function resolveTesseract(): TesseractBinary {
  const explicit = process.env[TESSERACT_ENV]
  if (explicit !== undefined && explicit.trim() !== '') {
    const path = explicit.trim()
    if (existsSync(path)) return { available: true, command: path }
    return {
      available: false,
      reason: `${TESSERACT_ENV} points at a missing file: ${path}`,
    }
  }
  const onPath = findOnPath(process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
  if (onPath !== undefined) return { available: true, command: onPath }
  if (process.platform === 'win32') {
    const known = WINDOWS_TESSERACT_CANDIDATES.find(candidate => existsSync(candidate))
    if (known !== undefined) return { available: true, command: known }
  }
  return {
    available: false,
    reason: 'tesseract was not found (looked on PATH and in the usual install locations)',
  }
}

/** Probe PATH for an executable, honouring PATHEXT on Windows. */
function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (dir === '') continue
    const candidate = dir.endsWith('/') || dir.endsWith('\\')
      ? `${dir}${name}`
      : `${dir}${process.platform === 'win32' ? '\\' : '/'}${name}`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The language string to recognise with. */
export function tesseractLanguages(): string {
  const override = process.env[TESSERACT_LANGS_ENV]
  return override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_TESSERACT_LANGS
}

/**
 * Run Tesseract over one PNG and return its TSV rows.
 *
 * \`--psm 11\` (sparse text) is the mode that suits screens: UI text is not a
 * paragraph, and the default page-segmentation invents columns that do not
 * exist. Measured ~1.2 s per 1536x2560 frame on a desktop CPU.
 */
export function execTesseractTsv(
  binary: TesseractBinary,
  imagePath: string,
  signal?: AbortSignal,
  timeoutMs = OCR_EXEC_TIMEOUT_MS,
): Promise<string> {
  if (!binary.available || binary.command === undefined) {
    return Promise.reject(new Error(`tesseract is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}`))
  }
  // "stdout" as the output base makes Tesseract write to stdout with no file on
  // disk, which keeps this usable from a read-only working directory.
  const args = [imagePath, 'stdout', '-l', tesseractLanguages(), '--psm', '11', 'tsv']
  return new Promise((resolve, reject) => {
    execFile(binary.command!, args, {
      timeout: timeoutMs,
      maxBuffer: OCR_MAX_BUFFER_BYTES,
      signal,
      // Tesseract writes its progress and "no best words" chatter to stderr;
      // a non-zero exit is the only thing worth failing on.
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null && (stdout ?? '').trim() === '') {
        const detail = (stderr ?? '').trim()
        reject(new Error(`tesseract failed${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      resolve(stdout ?? '')
    })
  })
}

/**
 * Parse Tesseract TSV into line-level OCR items.
 *
 * Column layout (0-based), stable across Tesseract 4 and 5:
 *   0 level · 1 page · 2 block · 3 par · 4 line · 5 word
 *   6 left · 7 top · 8 width · 9 height · 10 conf · 11 text
 *
 * Words (level 5) are grouped by page/block/par/line, concatenated in reading
 * order, and their boxes unioned. Grouping is what makes CJK matchable — see
 * the module comment. Confidence is the mean of the group's words.
 *
 * Rows with an empty text or a negative confidence are dropped: Tesseract uses
 * -1 for structural rows that carry no recognition.
 */
export function parseTesseractTsv(tsv: string): OcrItem[] {
  const groups = new Map<string, { words: Array<{ text: string; conf: number; left: number; top: number; width: number; height: number }> }>()
  const order: string[] = []
  for (const line of tsv.split('\n')) {
    if (line === '') continue
    const f = line.split('\t')
    if (f.length < 12) continue
    if (f[0] !== '5') continue
    const text = (f[11] ?? '').trim()
    if (text === '') continue
    const conf = Number(f[10])
    if (!Number.isFinite(conf) || conf < 0) continue
    const key = `${f[1]}/${f[2]}/${f[3]}/${f[4]}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { words: [] }
      groups.set(key, group)
      order.push(key)
    }
    group.words.push({
      text,
      conf,
      left: Number(f[6]) || 0,
      top: Number(f[7]) || 0,
      width: Number(f[8]) || 0,
      height: Number(f[9]) || 0,
    })
  }
  const items: OcrItem[] = []
  for (const key of order) {
    const words = groups.get(key)!.words
    if (words.length === 0) continue
    const left = Math.min(...words.map(w => w.left))
    const top = Math.min(...words.map(w => w.top))
    const right = Math.max(...words.map(w => w.left + w.width))
    const bottom = Math.max(...words.map(w => w.top + w.height))
    // Tesseract reports confidence 0..100; this module speaks 0..1 like Vision.
    const confidence = words.reduce((sum, w) => sum + w.conf, 0) / words.length / 100
    items.push({
      // CJK needs no separator; Latin words do.
      text: joinWords(words.map(w => w.text)),
      confidence,
      rect: { x: left, y: top, w: right - left, h: bottom - top },
    })
  }
  items.sort((a, b) => b.confidence - a.confidence)
  return items
}

/**
 * Join a line's words.
 *
 * Tesseract splits Latin on spaces but CJK per character, so a single rule is
 * wrong for one of them: inserting a space between every CJK character would
 * break "设置" into "设 置" and defeat the matcher again. A space is inserted
 * only when the boundary looks like Latin-to-Latin.
 */
export function joinWords(words: readonly string[]): string {
  let out = ''
  for (const word of words) {
    if (out === '') {
      out = word
      continue
    }
    const prev = out[out.length - 1]!
    const next = word[0]!
    out += needsSpace(prev, next) ? ` ${word}` : word
  }
  return out
}

/** True when two adjacent characters are both Latin-ish and need a separator. */
function needsSpace(prev: string, next: string): boolean {
  const latin = (c: string): boolean => /[0-9A-Za-z]/.test(c)
  return latin(prev) && latin(next)
}

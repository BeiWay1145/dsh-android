/**
 * Regression smoke for the cross-platform OCR seam.
 *
 * The Vision helper needs macOS, which left android_find_text / android_tap_text /
 * android_wait_for completely unavailable on Windows and Linux. Tesseract closes
 * that, but it does NOT drop in: its TSV segments Chinese per CHARACTER, so
 * against raw word rows every multi-character query fails the plugin's
 * exact-then-substring matcher ('设置' arrives as '设' and '置').
 *
 * What must stay true:
 *   1. the seam resolves a backend on ANY platform instead of gating on darwin
 *   2. Tesseract's words are re-grouped by line, so CJK queries match
 *   3. confidence is rescaled 0..100 -> 0..1 like Vision's
 *   4. structural rows (conf -1, empty text) never become items
 *   5. Vision's JSON parsing is untouched
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ocr = await import(pathToFileURL(join(root, 'lib', 'ocr-backend.js')).href)
const tess = await import(pathToFileURL(join(root, 'lib', 'ocr-tesseract.js')).href)

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

// A REAL tesseract TSV excerpt: the header plus the word rows for the labels
// '设置' and 'WLAN', which is exactly the shape that broke matching.
const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
const W = (b, p, l, w, x, y, ww, hh, c, t) => [String(5), '1', String(b), String(p), String(l), String(w), String(x), String(y), String(ww), String(hh), String(c), t].join('\t')
const TSV = [
  HEADER,
  // structural rows that carry no recognition: must be ignored
  ['1','1','0','0','0','0','0','0','1536','2560','-1',''].join('\t'),
  ['4','1','1','1','1','0','57','196','125','82','-1',''].join('\t'),
  W(1, 1, 1, 1, 57, 196, 40, 82, 94.1, '设'),
  W(1, 1, 1, 2, 100, 196, 40, 82, 94.0, '置'),
  W(1, 2, 1, 1, 149, 1174, 55, 29, 96.3, 'WLAN'),
  // a Latin pair that must keep its space
  W(1, 3, 1, 1, 200, 300, 40, 20, 90.0, 'Signal'),
  W(1, 3, 1, 2, 245, 300, 40, 20, 90.0, 'strength'),
].join('\r\n')

const items = tess.parseTesseractTsv(TSV)
const byText = (t) => items.find(i => i.text === t)

step('structural rows are dropped', items.length === 3, `got ${items.length} items`)
step('per-character CJK is re-grouped into one item', byText('设置') !== undefined,
  'without this, every multi-character Chinese query fails the matcher')
step('the grouped CJK box is the UNION of its characters',
  byText('设置')?.rect.x === 57 && byText('设置')?.rect.w === 83,
  JSON.stringify(byText('设置')?.rect))
step('the grouped confidence is the mean of the characters',
  Math.abs((byText('设置')?.confidence ?? 0) - 0.9405) < 0.001,
  String(byText('设置')?.confidence))
step('confidence is rescaled to 0..1 like Vision',
  items.every(i => i.confidence >= 0 && i.confidence <= 1))
step('Latin words keep a separator', byText('Signal strength') !== undefined,
  JSON.stringify(items.map(i => i.text)))
step('CJK gains NO separator', byText('设 置') === undefined)
step('items are sorted by confidence, highest first',
  items.every((item, i) => i === 0 || items[i - 1].confidence >= item.confidence))
step('an empty document yields no items', tess.parseTesseractTsv(HEADER).length === 0)
step('a malformed line is skipped, not fatal', tess.parseTesseractTsv('garbage\n' + HEADER).length === 0)

// The matcher the tools actually use, against the grouped output.
const found = items.find(i => i.text === '设置') ?? items.find(i => i.text.includes('设置'))
step('the plugin matcher FINDS a grouped CJK label', found !== undefined)

// The seam resolves on this platform rather than refusing.
const resolved = ocr.resolveOcrBinary()
step('resolveOcrBinary does not gate on darwin',
  !/macOS host/.test(resolved.reason ?? ''),
  'the old gate made every OCR tool unavailable off macOS')
if (resolved.available) {
  step('an available backend is labelled for parsing', resolved.backend !== undefined,
    'backend=' + String(resolved.backend))
} else {
  step('when unavailable the reason names BOTH options',
    /Vision/.test(resolved.reason ?? '') && /Tesseract/.test(resolved.reason ?? ''),
    String(resolved.reason))
}

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
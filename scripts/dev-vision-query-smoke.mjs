/**
 * Static smoke for the semantic-reading tools (android_query / android_assert).
 *
 * PURELY STATIC — no device, no adb, no model. It drives the tool definitions
 * through a fake host + fake vision services and asserts the behaviour that
 * matters: the image is attached on an image-capable route, and the tool
 * REFUSES with the remedy (rather than returning something ungrounded) when the
 * route cannot accept an image or no attachment store is mounted.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// pathToFileURL, NOT the bare join(): on Windows a bare "C:\\..." path is
// rejected by the ESM loader ("Received protocol 'c:'"), which is what makes
// the sibling suites SKIP on Windows today.
const { createAndroidVisionQueryTools } = await import(
  pathToFileURL(join(root, 'lib', 'tool-vision-query.js')).href
)

let pass = 0
let fail = 0
function step(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function makeHost() {
  return {
    toolchain: {
      binary: { available: true, command: 'adb', source: 'fake' },
      async deviceDetails() { return { model: 'Fake', androidVersion: '14' } },
    },
    available: true,
    async resolveTarget() { return { serial: 'FAKE123', state: 'device', model: 'Fake' } },
    async screenshot() {
      return { png: PNG, width: 1080, height: 2400 }
    },
  }
}

const deviceSummary = { serial: 'FAKE123', name: 'Fake', androidVersion: '14', state: 'device' }

function makeVision({ withStore = true, imageCapable = true } = {}) {
  const saved = []
  return {
    saved,
    services: {
      ...(withStore ? { attachments: { async saveImage(i) { saved.push(i); return {
        attachmentId: 'sha256:abc', mediaType: i.mediaType, bytes: i.data.byteLength, width: 1080, height: 2400,
      } } } } : {}),
      llm: { async resolveModelInfo() { return imageCapable ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] } } },
    },
    exec: { agent: { options: { provider: 'buddy', model: 'deepseek-v4.1-flash' } } },
  }
}

// ── 1. the tools construct and expose the documented names ──────────────────
{
  const v = makeVision()
  const tools = createAndroidVisionQueryTools(makeHost(), { vision: v.services })
  step('android_query is defined with the expected name', tools.androidQuery?.name === 'android_query', tools.androidQuery?.name)
  step('android_assert is defined with the expected name', tools.androidAssert?.name === 'android_assert', tools.androidAssert?.name)
}

// ── 2. image-capable route: the screenshot is attached ──────────────────────
{
  const v = makeVision({ withStore: true, imageCapable: true })
  const tools = createAndroidVisionQueryTools(makeHost(), { vision: v.services })
  const res = await tools.androidQuery.execute({ fields: ['a', 'b'] }, v.exec)
  step('query attaches the image on an image-capable route', res.image !== undefined && res.image.mediaType === 'image/png')
  step('query returns an instruction restating the fields', typeof res.instructions === 'string' && res.instructions.includes('["a","b"]'), String(res.instructions).slice(0, 70))
  step('query wrote one screenshot to the store', res.path.endsWith('.png') && v.saved.length === 1)
}

// ── 3. text-only route: REFUSE with the remedy (never a silent text result) ──
{
  const v = makeVision({ withStore: true, imageCapable: false })
  const tools = createAndroidVisionQueryTools(makeHost(), { vision: v.services })
  let err
  try { await tools.androidQuery.execute({ fields: ['a'] }, v.exec) } catch (e) { err = e }
  step('query REFUSES on a text-only route', err !== undefined)
  step('query refusal names the remedy (image-capable model + android_ui_tree)',
    err !== undefined && /image-capable model/.test(err.message) && /android_ui_tree/.test(err.message))
  step('query refusal did NOT save an attachment', v.saved.length === 0)
}

// ── 4. no attachment store: refuse with the text-reader remedy ──────────────
{
  const v = makeVision({ withStore: false })
  const tools = createAndroidVisionQueryTools(makeHost(), { vision: v.services })
  let err
  try { await tools.androidAssert.execute({ claim: 'the dialog is gone' }, v.exec) } catch (e) { err = e }
  step('assert REFUSES without an attachment store', err !== undefined)
  step('assert refusal points at the text readers', err !== undefined && /android_ui_tree/.test(err.message))
}

// ── 5. android_assert validates its claim ───────────────────────────────────
{
  const v = makeVision()
  const tools = createAndroidVisionQueryTools(makeHost(), { vision: v.services })
  let err
  try { await tools.androidAssert.execute({ claim: '   ' }, v.exec) } catch (e) { err = e }
  step('assert rejects a blank claim', err !== undefined && /claim/.test(err.message))

  const res = await tools.androidAssert.execute({ claim: 'an error is visible' }, v.exec)
  step('assert restates the claim for the model',
    typeof res.claim === 'string' && res.claim.includes('an error is visible') && /TRUE or FALSE/.test(res.claim))
  step('assert attaches the image', res.image !== undefined)
}

console.log(`\n${pass}/${pass + fail} steps passed`)
process.exit(fail === 0 ? 0 : 1)

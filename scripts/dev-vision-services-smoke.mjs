/**
 * Regression smoke for the vision seam's service resolution.
 *
 * Reproduces the real failure: cordis' ctx.get(name) returns undefined while the
 * PROVIDING fiber is inactive, so a resolver that samples once at plugin
 * apply() time captures "no attachments" and disables image delivery for the
 * whole process. The lazy resolver must pick the service up once it appears.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { resolveVisionServices } = await import(pathToFileURL(join(root, 'lib', 'vision.js')).href)

let pass = 0
let fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`) }

// A cordis-like ctx whose 'attachments' appears only AFTER first read.
function lateCtx({ withSaveImage = false } = {}) {
  const store = {
    async saveImages(inputs) { return inputs.map(() => ({ attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 })) },
  }
  if (withSaveImage) store.saveImage = async () => ({ attachmentId: 'sha256:y', mediaType: 'image/png', bytes: 1, width: 1, height: 1 })
  let active = false
  return {
    activate() { active = true },
    get(name) {
      if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } }
      if (name === 'attachments') return active ? store : undefined
      return undefined
    },
  }
}

// 1. the core regression: sampling early must NOT freeze the answer
{
  const ctx = lateCtx()
  const vision = resolveVisionServices(ctx)
  const before = vision.attachments
  ctx.activate()
  const after = vision.attachments
  step('attachments is undefined before the provider activates', before === undefined)
  step('attachments becomes visible after activation (lazy re-read)', after !== undefined)
}

// 2. a store exposing only saveImage is still accepted
{
  const ctx = lateCtx({ withSaveImage: true })
  ctx.activate()
  const vision = resolveVisionServices(ctx)
  step('a store with only saveImage is accepted', vision.attachments !== undefined)
}

// 3. a ctx with no get() at all stays text-only instead of throwing
{
  const vision = resolveVisionServices({})
  step('ctx without get() yields no services (no throw)', vision.attachments === undefined && vision.llm === undefined)
}

// 4. a store with neither entry is rejected
{
  const ctx = { get: (n) => n === 'attachments' ? {} : undefined }
  const vision = resolveVisionServices(ctx)
  step('a store with no image entry is rejected', vision.attachments === undefined)
}

console.log(`\n${pass}/${pass + fail} steps passed`)
process.exit(fail === 0 ? 0 : 1)

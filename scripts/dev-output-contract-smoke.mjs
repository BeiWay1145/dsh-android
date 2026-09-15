/**
 * Output-contract smoke: a tool's declared output schema must cover its result.
 *
 * WHY THIS EXISTS. Tools here declare `output.schema` with
 * `additionalProperties: false`, and the HOST validates against it. Adding a
 * field to a result without adding it to the schema therefore does not degrade
 * the tool -- the tool returns 'invalid output' and fails outright.
 *
 * That happened. `display` was added to AndroidUiTreeResult and NOT to the
 * schema, so every android_ui_tree call on every device began failing with:
 *   'value.display is not a declared property (additionalProperties: false)'
 *
 * It reached a user. The existing suites missed it because they drive tools
 * through a fake host and inspect the returned object directly -- none of them
 * asked whether that object would survive the schema the host enforces.
 *
 * This suite closes the hole structurally and without a device: it reads the
 * RESULT INTERFACES out of the TypeScript source (the thing the implementation
 * must satisfy) and requires each closed output schema to declare every field
 * of the matching interface. No hand-maintained field list to go stale.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

let pass = 0, fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`) }

/**
 * Field names of every `export interface X { ... }` in a source file.
 * Only the TOP-LEVEL property names are needed, so a brace-depth scan is
 * enough -- no TypeScript parser required (and none is available here).
 */
function interfaceFields(source) {
  const out = new Map()
  const lines = source.split('\n')
  let current = null
  let depth = 0
  for (const line of lines) {
    if (current === null) {
      const m = /^export interface (\w+)/.exec(line)
      if (m === null) continue
      current = m[1]
      out.set(current, [])
      depth = 0
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (current !== null && depth >= 1) {
      // A top-level property: `  name?: type` or `  name: type`
      const m = /^  (\w+)\??\s*:/.exec(line)
      if (m !== null) out.get(current).push(m[1])
    }
    if (current !== null && depth <= 0) current = null
  }
  return out
}

// Every interface declared anywhere in src/.
const interfaces = new Map()
for (const file of readdirSync(srcDir)) {
  if (!file.endsWith('.ts')) continue
  const found = interfaceFields(readFileSync(join(srcDir, file), 'utf8'))
  for (const [name, fields] of found) interfaces.set(name, { fields, file })
}
step('result interfaces were parsed from the source', interfaces.size > 20, `${interfaces.size} interfaces`)

// The tools, loaded from the build.
const ui = await import(pathToFileURL(join(root, 'lib', 'tool-uitree.js')).href)
const rows = await import(pathToFileURL(join(root, 'lib', 'tool-list-rows.js')).href)
const ocr = await import(pathToFileURL(join(root, 'lib', 'tool-ocr.js')).href)
const apps = await import(pathToFileURL(join(root, 'lib', 'tool-apps.js')).href)
const base = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const { AndroidHostController } = await import(pathToFileURL(join(root, 'lib', 'android-host.js')).href)

const deadHost = new AndroidHostController({
  async execOut() { throw new Error('never executed') },
  async shell() { throw new Error('never executed') },
})
const tools = [
  ...Object.values(ui.createAndroidUiTools(deadHost, {})),
  ...Object.values(rows.createAndroidRowTools(deadHost, {})),
  ...Object.values(ocr.createAndroidOcrTools(deadHost, {})),
  ...Object.values(apps.createAndroidAppTools(deadHost)),
  ...Object.values(base.createAndroidTools(deadHost, {})),
].filter(t => t !== null && typeof t === 'object' && typeof t.name === 'string')

/** The result interface a tool's schema is meant to describe. */
function resultInterfaceFor(toolName) {
  const camel = toolName.replace(/^android_/, '').split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  // Both the ui- and row-prefixed spellings are used in this codebase.
  return [`Android${camel}Result`, `AndroidUi${camel}Result`, `AndroidRow${camel}Result`]
    .find(candidate => interfaces.has(candidate))
}

let compared = 0
for (const tool of tools) {
  const schema = tool.output?.schema
  if (schema === undefined || schema?.additionalProperties !== false) continue
  const declared = new Set(Object.keys(schema.properties ?? {}))
  const ifaceName = resultInterfaceFor(tool.name)
  if (ifaceName === undefined) continue
  compared++
  const { fields } = interfaces.get(ifaceName)
  // Fields ending in `?` are optional but STILL must be declared if returned.
  const missing = fields.filter(field => !declared.has(field))
  step(
    `${tool.name}: schema covers ${ifaceName}`,
    missing.length === 0,
    missing.length === 0
      ? undefined
      : `NOT DECLARED: ${missing.join(', ')} -- the host rejects the whole result (additionalProperties: false)`,
  )
}

// The specific regression, pinned by name so it cannot come back unnoticed.
step(
  'android_ui_tree declares display (the field whose omission broke every call)',
  (() => {
    const tool = tools.find(t => t.name === 'android_ui_tree')
    return tool?.output?.schema?.properties?.display !== undefined
  })(),
  'schema must declare every field the result carries',
)

console.log('')
console.log(`${pass}/${pass + fail} steps passed${fail === 0 ? '' : ` (${fail} FAILED)`}`)
process.exit(fail === 0 ? 0 : 1)
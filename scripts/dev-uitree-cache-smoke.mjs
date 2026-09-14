/**
 * Static smoke for android_ui_tree's opt-in if_moved cache.
 *
 * The cache exists because a uiautomator dump costs ~2.4 s and ~61% of that is
 * its own JVM startup, which no flag removes — so the only lever is dumping
 * LESS. These steps drive the real tool through the DI seam with a fake host
 * whose dump is counted, and assert that a second if_moved read of an unmoved
 * screen spends NO dump, while every case where the cheap signal is unusable or
 * the shape differs still dumps.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createAndroidUiTools, invalidateTreeCache } = await import(
  pathToFileURL(join(root, 'lib', 'tool-uitree.js')).href,
)

let pass = 0
let fail = 0
const step = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`) }

const XML = '<?xml version="1.0"?><hierarchy rotation="0">'
  + '<node index="0" text="WLAN" resource-id="p:id/title" class="android.widget.TextView" bounds="[10,10][100,40]"/>'
  + '</hierarchy>'

/** A host whose dump count is observable and whose fingerprint can be pinned. */
function makeHost() {
  const calls = { dump: 0, window: 0 }
  let focus = 'A'
  const toolchain = {
    async execOut(_s, args) {
      if (args.join(' ').includes('uiautomator')) { calls.dump++; return Buffer.from(XML) }
      return Buffer.from('')
    },
    async shell(_s, args) {
      const cmd = args.join(' ')
      if (cmd.startsWith('dumpsys window')) {
        calls.window++
        return `  mCurrentFocus=Window{1 u0 com.example/${focus}}\n  Frames: frame=[0,0][10,10]\n`
      }
      return ''
    },
  }
  return {
    calls,
    setFocus(v) { focus = v },
    toolchain,
    async resolveTarget() { return { serial: 'FAKE', state: 'device', model: 'Fake' } },
    async screenshot() { return { png: Buffer.from(''), width: 10, height: 10 } },
    async tap() {},
    async type() {},
    async button() {},
    async drag() {},
  }
}

// 1. two reads, nothing moved -> the second spends NO dump
{
  invalidateTreeCache()
  const host = makeHost()
  const tools = createAndroidUiTools(host)
  const a = await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  const afterFirst = host.calls.dump
  const b = await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  step('first if_moved read dumps once', afterFirst === 1, `dump=${afterFirst}`)
  step('second if_moved read spends NO dump', host.calls.dump === 1, `dump=${host.calls.dump}`)
  step('the cache hit is marked cached:true', b.cached === true)
  step('the cache hit returns the same node count', b.nodeCount === a.nodeCount, `${a.nodeCount}/${b.nodeCount}`)
  step('the cache hit explains itself in the hint', typeof b.hint === 'string' && /CACHE HIT/.test(b.hint))
}

// 2. a moved screen must NOT be served from cache
{
  invalidateTreeCache()
  const host = makeHost()
  const tools = createAndroidUiTools(host)
  await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  host.setFocus('B')
  const b = await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  step('a moved screen dumps again', host.calls.dump === 2, `dump=${host.calls.dump}`)
  step('a fresh read is not marked cached', b.cached === undefined)
}

// 3. without if_moved the tool always dumps (default behaviour unchanged)
{
  invalidateTreeCache()
  const host = makeHost()
  const tools = createAndroidUiTools(host)
  await tools.androidUiTree.execute({ serial: 'FAKE' }, {})
  await tools.androidUiTree.execute({ serial: 'FAKE' }, {})
  step('default reads always dump', host.calls.dump === 2, `dump=${host.calls.dump}`)
}

// 4. a different filter shape must not reuse another shape's tree
{
  invalidateTreeCache()
  const host = makeHost()
  const tools = createAndroidUiTools(host)
  await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  const b = await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true, filter: 'WLAN' }, {})
  step('a different filter shape dumps again', host.calls.dump === 2, `dump=${host.calls.dump}`)
  step('the differently-shaped read is not a cache hit', b.cached === undefined)
}

// 5. an unusable fingerprint must not masquerade as "unchanged"
{
  invalidateTreeCache()
  const host = makeHost()
  const orig = host.toolchain.shell.bind(host.toolchain)
  host.toolchain.shell = async (s, a) => {
    if (a.join(' ').startsWith('dumpsys window')) throw new Error('unavailable')
    return orig(s, a)
  }
  const tools = createAndroidUiTools(host)
  await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  await tools.androidUiTree.execute({ serial: 'FAKE', if_moved: true }, {})
  step('an unavailable fingerprint still dumps', host.calls.dump === 2, `dump=${host.calls.dump}`)
}

console.log(`\n${pass}/${pass + fail} steps passed`)
process.exit(fail === 0 ? 0 : 1)

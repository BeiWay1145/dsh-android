// Live check of screenFingerprint against a real device via the real toolchain.
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { screenFingerprint } = await import(pathToFileURL(join(root, 'lib', 'screen-fingerprint.js')).href)
const { AdbToolchain } = await import(pathToFileURL(join(root, 'lib', 'adb.js')).href)

const serial = process.argv[2]
if (!serial) { console.log('usage: node dev-fingerprint-live.mjs <serial>'); process.exit(0) }

const toolchain = new AdbToolchain()
console.log('adb:', toolchain.binary.available ? toolchain.binary.command : 'UNAVAILABLE')

const a = await screenFingerprint(toolchain, serial)
console.log(`idle#1 digest=${a.digest} focus="${a.focus.slice(0, 60)}" ${a.elapsedMs}ms`)
const b = await screenFingerprint(toolchain, serial)
console.log(`idle#2 digest=${b.digest} ${b.elapsedMs}ms  -> stable: ${a.digest === b.digest}`)

await toolchain.shell(serial, ['input', 'keyevent', 'KEYCODE_HOME'])
await new Promise(r => setTimeout(r, 2000))
const c = await screenFingerprint(toolchain, serial)
console.log(`home   digest=${c.digest} ${c.elapsedMs}ms  -> changed: ${b.digest !== c.digest}`)

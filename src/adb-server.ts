/**
 * A direct client for the adb SERVER, bypassing the `adb` executable.
 *
 * WHY THIS EXISTS
 * Measured on this machine, `adb version` — which only spawns adb.exe and
 * handshakes the server, without touching a device — costs ~51 ms, while a full
 * `adb devices -l` costs ~59 ms. Enumerating devices is therefore only ~6 ms of
 * that; the rest is process creation. Caching the RESULT saves almost nothing,
 * because the expensive part is starting the process at all.
 *
 * Talking to the server over its own socket removes the process: measured
 * 0-1 ms for `host:devices-l`, versus 59 ms through the CLI, with byte-identical
 * output.
 *
 * PROTOCOL (as implemented by the AOSP adb server)
 * A request is a 4-character lowercase-hex length prefix followed by the service
 * string, e.g. `0012host:devices-l`. The server answers `OKAY` or `FAIL`
 * followed by a 4-character hex length and that many bytes of payload.
 *
 * DELIBERATELY NARROW
 * This is not a general adb replacement — only the one host service this plugin
 * needs is implemented, and every failure path returns `undefined` so callers
 * fall back to the CLI. Being unable to reach the server must never make a tool
 * fail; it must only make it slower.
 */

import { createConnection } from 'node:net'

/** The adb server's default port; overridable by the same env var adb honours. */
export const DEFAULT_ADB_SERVER_PORT = 5037

/** Env var the Android tools use to relocate the server. */
export const ADB_SERVER_PORT_ENV = 'ANDROID_ADB_SERVER_PORT'

/**
 * How long one server request may take.
 *
 * Generous for a loopback round trip (measured sub-millisecond) but short enough
 * that an unreachable or wedged server costs one tool call rather than stalling
 * it — the caller then uses the CLI path, which has its own timeout.
 */
export const ADB_SERVER_TIMEOUT_MS = 2_000

/** Up to this many bytes of a listed payload are read before giving up. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

/** The port to reach the adb server on, honouring the environment override. */
export function adbServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ADB_SERVER_PORT_ENV]
  if (raw !== undefined) {
    const port = Number(raw)
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return DEFAULT_ADB_SERVER_PORT
}

/**
 * Ask the adb server one host service and return its payload.
 *
 * Resolves `undefined` for EVERY failure — connection refused, timeout, a FAIL
 * response, a malformed frame. The caller cannot distinguish the reasons and
 * does not need to: the only correct reaction to all of them is to fall back.
 */
export async function adbServerRequest(
  service: string,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const port = options.port ?? adbServerPort()
  const timeoutMs = options.timeoutMs ?? ADB_SERVER_TIMEOUT_MS
  return new Promise<string | undefined>((resolve) => {
    let settled = false
    let socket: ReturnType<typeof createConnection> | undefined
    let buffered = Buffer.alloc(0)
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        // Already gone; nothing to release.
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)

    try {
      socket = createConnection({ host: '127.0.0.1', port })
    } catch {
      finish(undefined)
      return
    }
    socket.setNoDelay(true)
    socket.on('connect', () => {
      const payload = Buffer.from(service, 'utf8')
      // 4-char hex length, lowercase, zero padded — exactly what adb sends.
      const header = Buffer.from(payload.length.toString(16).padStart(4, '0'), 'ascii')
      socket?.write(Buffer.concat([header, payload]))
    })
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > MAX_PAYLOAD_BYTES) {
        finish(undefined)
        return
      }
      if (buffered.length < 4) return
      const status = buffered.subarray(0, 4).toString('ascii')
      if (status !== 'OKAY' && status !== 'FAIL') {
        // Protocol desync: treat as unavailable rather than guess.
        finish(undefined)
        return
      }
      if (buffered.length < 8) return
      const length = Number.parseInt(buffered.subarray(4, 8).toString('ascii'), 16)
      if (!Number.isInteger(length) || length < 0) {
        finish(undefined)
        return
      }
      if (buffered.length < 8 + length) return
      const body = buffered.subarray(8, 8 + length).toString('utf8')
      // A FAIL carries the reason instead of data; either way the caller's only
      // sensible reaction is the CLI fallback.
      finish(status === 'OKAY' ? body : undefined)
    })
    socket.on('error', () => finish(undefined))
    socket.on('close', () => finish(undefined))
  })
}

/**
 * `host:devices-l` output, or `undefined` when the server is unreachable.
 *
 * The payload is the SAME text the CLI prints minus its "List of devices
 * attached" header, so it can be handed to the existing line parser unchanged —
 * that header is already skipped there. Verified byte-for-byte against
 * `adb devices -l` on a real device.
 */
export async function adbServerDevices(
  options: { port?: number; timeoutMs?: number } = {},
): Promise<string | undefined> {
  return adbServerRequest('host:devices-l', options)
}

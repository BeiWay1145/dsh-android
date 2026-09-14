/**
 * Client for the on-device DSH bridge (proposal 1).
 *
 * WHAT THIS IS FOR
 * `uiautomator dump` costs ~2.43 s on a real device and ~85% of that is pure
 * process startup (measured: 0.51 s JVM + 1.16 s class loading), paid again on
 * EVERY call because the CLI tool is a fresh process each time. The bridge is an
 * AccessibilityService that the system starts once and keeps alive; a dump then
 * costs only the tree walk plus serialization (measured 25-56 ms).
 *
 * WHY IT IS OPTIONAL
 * The bridge needs an APK installed and an accessibility grant — neither of
 * which this plugin can do for the user, and neither of which should be required
 * to use the plugin at all. Every entry point here therefore DEGRADES rather
 * than fails: if the service is missing, disabled, or slow, the caller falls
 * back to `uiautomator` and the tool behaves exactly as before, just slower.
 * That keeps the upstream contract intact and makes this a pure optimisation.
 *
 * TRANSPORT
 * An abstract-namespace local socket on the device, reached through
 * `adb forward` to a loopback TCP port on this host. The forward is set up once
 * per device and reused, so a dump is ONE connection round trip with no adb
 * process spawn at all.
 */

import { createConnection, type Socket } from 'node:net'
import type { AdbToolchain } from './adb.js'

/** The device-side socket name; must match SocketServer.SOCKET_NAME. */
export const BRIDGE_SOCKET_NAME = 'dsh_bridge'

/** Protocol version this client speaks; must match the service's VERSION. */
export const BRIDGE_PROTOCOL_VERSION = '1'

/** How long to wait for the service to answer one request. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 5_000

/**
 * How long a NEGATIVE probe result is trusted before re-probing.
 *
 * Probing costs an `adb forward` round trip, so an uninstalled bridge must not
 * pay it on every dump. A positive result is cached until the connection
 * actually fails (the service can be disabled at any moment); a negative one
 * expires so that installing the APK later starts working without a restart.
 */
export const BRIDGE_NEGATIVE_TTL_MS = 60_000

/** One bridge reply. */
interface BridgeReply {
  ok: boolean
  xml?: string
  error?: string
  pong?: boolean
  version?: string
  /** Content revision the device reported with this reply. */
  revision?: number
  /** True when the device skipped the tree because nothing changed. */
  unchanged?: boolean
}

/**
 * What the bridge client needs from the toolchain.
 *
 * `forward` is not part of `AdbToolchain` today; taking it structurally keeps
 * the smoke able to inject a fake without a device (the same DI seam the rest
 * of the tools use for the host).
 */
export interface BridgeToolchain {
  execOut: AdbToolchain['execOut']
  /** Establish a host→device socket forward; returns the local port. */
  forward(serial: string, remote: string): Promise<number>
  /** Tear down a previously established forward (best effort). */
  unforward?(serial: string, localPort: number): Promise<void>
}

/** Per-serial cached state. */
interface BridgeState {
  /** The local port that reaches this device's bridge socket. */
  port?: number
  /** Set once a request has succeeded; cleared when a request fails. */
  healthy: boolean
  /** When a failed probe may be retried. */
  retryAfter: number
  /** Content revision the cached tree was dumped at. */
  revision?: number
  /** The cached tree itself (proposal 2: reuse it while the revision holds). */
  tree?: string
}

/**
 * Owns the connection state for every device.
 *
 * One instance per plugin (not per call) so the port and the health flag survive
 * across tool invocations — re-forwarding on every dump would trade a 2.4 s JVM
 * start for an adb round trip, which is better but still wasteful.
 */
export class BridgeClient {
  #state = new Map<string, BridgeState>()
  #toolchain: BridgeToolchain

  constructor(toolchain: BridgeToolchain) {
    this.#toolchain = toolchain
  }

  /** Test/diagnostic hook: forget everything about one device. */
  reset(serial?: string): void {
    if (serial === undefined) this.#state.clear()
    else this.#state.delete(serial)
  }

  /**
   * Dump the hierarchy through the bridge.
   *
   * Returns the SAME XML dialect the caller already parses, or `undefined` when
   * the bridge is unavailable for any reason — never throws. A `undefined`
   * return is the caller's signal to use the uiautomator path.
   */
  async dump(serial: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | undefined> {
    const state = this.#stateOf(serial)
    const timeoutMs = options.timeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS

    if (!state.healthy && Date.now() < state.retryAfter) return undefined

    let freshPort = false
    if (state.port === undefined) {
      const port = await this.#connect(serial)
      if (port === undefined) return undefined
      state.port = port
      freshPort = true
    }

    // PROPOSAL 2: ask the device whether anything changed since the revision we
    // already hold. An unchanged counter is answered WITHOUT a tree walk or any
    // XML on the wire, so a repeat read of an idle screen costs one tiny round
    // trip. The device is the right place for this test — it is already
    // subscribed to the accessibility events that prove a change happened, so
    // the answer is cheaper AND more accurate than the host-side fingerprint.
    const request: Record<string, unknown> = state.revision === undefined
      ? { id: 1, cmd: 'dump' }
      : { id: 1, cmd: 'dump_if_changed', known: state.revision }

    let reply: BridgeReply
    try {
      reply = await this.#request(state.port, request, timeoutMs, options.signal)
    } catch {
      // MEASURED: the FIRST connection through a fresh `adb forward` can stall
      // (the adb server establishes the device-side socket lazily) while the
      // next answers in ~9 ms. `#connect` warms the socket to absorb that, but a
      // retry here keeps a one-off stall from disabling the fast path for a
      // whole TTL.
      if (freshPort && options.signal?.aborted !== true) {
        try {
          reply = await this.#request(state.port, request, timeoutMs, options.signal)
        } catch {
          await this.#drop(serial, state)
          return undefined
        }
      } else {
        // The forward may be stale (adb restarted, service toggled). Drop it so
        // the next call re-establishes, and let the caller fall back this time.
        await this.#drop(serial, state)
        return undefined
      }
    }

    if (reply.ok !== true) {
      // A reachable service that cannot dump (screen off, no active window) is a
      // transient device state, not a broken bridge: keep the port, but report
      // unavailable so the caller can try uiautomator, which may know better.
      return undefined
    }

    state.healthy = true

    // Unchanged: serve the tree we already have. The device deliberately sent no
    // XML, so this is the cheap path.
    if (reply.unchanged === true) return state.tree

    if (typeof reply.xml !== 'string' || reply.xml === '') return undefined
    state.tree = reply.xml
    if (typeof reply.revision === 'number') state.revision = reply.revision
    return reply.xml
  }

  /** True when the service answers a ping. Diagnostics and tests only. */
  async ping(serial: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const state = this.#stateOf(serial)
    if (state.port === undefined) {
      const port = await this.#connect(serial)
      if (port === undefined) return false
      state.port = port
    }
    try {
      const reply = await this.#request(
        state.port,
        { id: 1, cmd: 'ping' },
        options.timeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS,
        options.signal,
      )
      return reply.ok === true && reply.pong === true
    } catch {
      await this.#drop(serial, state)
      return false
    }
  }

  #stateOf(serial: string): BridgeState {
    const existing = this.#state.get(serial)
    if (existing !== undefined) return existing
    const fresh: BridgeState = { healthy: false, retryAfter: 0 }
    this.#state.set(serial, fresh)
    return fresh
  }

  async #drop(serial: string, state: BridgeState): Promise<void> {
    const port = state.port
    state.port = undefined
    state.healthy = false
    state.retryAfter = Date.now() + BRIDGE_NEGATIVE_TTL_MS
    if (port !== undefined && this.#toolchain.unforward !== undefined) {
      await this.#toolchain.unforward(serial, port).catch(() => {})
    }
  }

  /** Establish the forward, or `undefined` when the device/socket is absent. */
  async #connect(serial: string): Promise<number | undefined> {
    const state = this.#stateOf(serial)
    try {
      const port = await this.#toolchain.forward(serial, `localabstract:${BRIDGE_SOCKET_NAME}`)
      if (!Number.isInteger(port) || port <= 0) {
        state.retryAfter = Date.now() + BRIDGE_NEGATIVE_TTL_MS
        return undefined
      }
      // WARM-UP: `adb forward` establishes the device-side socket LAZILY — the
      // first connection through a fresh forward can stall for seconds (measured
      // ~2.4-4 s once, ~40 ms when the service is already warm) while the next
      // answers in ~9 ms. Probing here moves that one-off cost to connect time,
      // where it is paid once per session, instead of landing on the first
      // android_ui_tree the user runs. A failed probe is not fatal on its own:
      // the query that follows reports the real outcome.
      await this.#request(port, { id: 0, cmd: 'ping' }, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => undefined)
      return port
    } catch {
      state.retryAfter = Date.now() + BRIDGE_NEGATIVE_TTL_MS
      return undefined
    }
  }

  /** Send one request and resolve its reply. Rejects on timeout/close. */
  #request(
    port: number,
    request: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BridgeReply> {
    return new Promise<BridgeReply>((resolve, reject) => {
      let socket: Socket | undefined
      let buffer = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          socket?.destroy()
        } catch {
          // Already closed; nothing to do.
        }
        fn()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error(`bridge request timed out after ${timeoutMs} ms`))),
        timeoutMs,
      )
      const onAbort = (): void => finish(() => reject(new Error('bridge request aborted')))
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        socket = createConnection({ host: '127.0.0.1', port })
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        return
      }
      socket.setNoDelay(true)
      socket.on('connect', () => socket?.write(`${JSON.stringify(request)}\n`))
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        finish(() => {
          try {
            resolve(JSON.parse(line) as BridgeReply)
          } catch (error) {
            reject(new Error(`bridge sent a malformed reply: ${line.slice(0, 120)}`))
          }
        })
      })
      socket.on('error', error => finish(() => reject(error)))
      socket.on('close', () => finish(() => reject(new Error('bridge closed the connection without answering'))))
    })
  }
}
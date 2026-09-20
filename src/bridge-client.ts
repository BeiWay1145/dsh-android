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
 * Budget for the connect-time PROBE, kept far below the request budget.
 *
 * The probe answers one question -- is the service actually serving, or merely
 * bound? -- and a hung bridge cannot answer it any faster than a timeout. At
 * 5 s the answer cost 10 s per call (two warm-up attempts) before any fallback
 * work started. Measured on a HarmonyOS device, the rebind window is a few
 * seconds at most, so a probe shorter than the window it is waiting out would
 * be counterproductive: 1.2 s is long enough for a healthy service (which
 * answers in single-digit milliseconds) and short enough that a hang costs
 * about a second instead of ten.
 */
export const BRIDGE_PROBE_TIMEOUT_MS = 1_200

/**
 * How long a NEGATIVE probe result is trusted before re-probing.
 *
 * Probing costs an `adb forward` round trip, so an uninstalled bridge must not
 * pay it on every dump. A positive result is cached until the connection
 * actually fails (the service can be disabled at any moment); a negative one
 * expires so that installing the APK later starts working without a restart.
 */
export const BRIDGE_NEGATIVE_TTL_MS = 60_000

/**
 * How long a failure is trusted when the bridge is KNOWN to be installed.
 *
 * Deliberately far shorter than {@link BRIDGE_NEGATIVE_TTL_MS}, because the
 * two cover different situations:
 *
 *   not installed        -- a lasting fact; re-probing every dump just pays an
 *                           `adb forward` round trip for nothing.
 *   installed but silent -- usually TRANSIENT. Reported from a real session:
 *                           ColorOS reclaimed the accessibility service in the
 *                           background (PID 20825 -> 23523) and the socket
 *                           showed leaving connections. The service rebinds
 *                           itself in seconds, but the old single 60 s penalty
 *                           kept the plugin on the slow path for a full minute
 *                           AFTER the device had recovered -- and because the
 *                           fallback is silent, the only symptom was 'it got
 *                           slow again'.
 *
 * 2 s is long enough to avoid hammering a genuinely dead socket on every call
 * and short enough that a recovered service is picked back up while the caller
 * is still on the same task.
 */
export const BRIDGE_TRANSIENT_TTL_MS = 2_000

/** The accessibility service's package, used to tell 'absent' from 'disabled'. */
export const BRIDGE_PACKAGE = 'com.beiway1145.dshbridge'

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
  /** Existing forwards for a device, so an orphan can be adopted. */
  listForwards?(serial: string): Promise<string[]>
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

  /**
   * Forget one device (or all) and release any forward this client created.
   *
   * Used by tests and by teardown. Adoption means a forward may predate us, so
   * removing it is best-effort and never fatal.
   */
  async reset(serial?: string): Promise<void> {
    const targets = serial === undefined ? [...this.#state.keys()] : [serial]
    for (const key of targets) {
      const state = this.#state.get(key)
      if (state?.port !== undefined && this.#toolchain.unforward !== undefined) {
        await this.#toolchain.unforward(key, state.port).catch(() => {})
      }
      this.#state.delete(key)
    }
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
          // Two attempts through a FRESH forward both failed, but the forward was
          // just created -- so this says nothing about whether the APK is
          // installed, only that the socket is not answering yet. Treat it as
          // transient, exactly like the stale-forward branch below.
          await this.#drop(serial, state, 'transient')
          return undefined
        }
      } else {
        // The forward may be stale (adb restarted, service toggled, or the
        // accessibility service was reclaimed and is rebinding). Drop it so the
        // next call re-establishes, and let the caller fall back this time --
        // but do NOT punish it with the long TTL: this exact case is how a
        // background kill turned into a silent minute of slowness.
        await this.#drop(serial, state, 'transient')
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


  /**
   * Whether the on-device service answers right now.
   *
   * Deliberately ONLY the socket question. Telling 'the APK is missing' from 'the
   * service is not enabled' needs to read the device's package list, and this
   * class takes a deliberately MINIMAL toolchain so tests can inject a fake --
   * widening that seam to answer a diagnostic would be the tail wagging the dog.
   * `AndroidHostController.bridgeStatus` owns the full three-way answer.
   */
  async answering(serial: string): Promise<boolean> {
    return await this.ping(serial).catch(() => false)
  }

  /**
   * Whether the service answers within a SHORT budget.
   *
   * Exists for diagnostics, which must never stall a caller for the ~10 s a cold
   * forward handshake can take. A timeout here means "did not answer promptly",
   * NOT "is broken" -- the caller decides what that implies.
   */
  async answeringWithin(serial: string, timeoutMs: number): Promise<boolean> {
    return await this.ping(serial, { timeoutMs }).catch(() => false)
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
      // 'Did not answer just now' is not 'not installed'. Keep the penalty short
      // so a service that is rebinding is picked back up promptly.
      await this.#drop(serial, state, 'transient')
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

  async #drop(serial: string, state: BridgeState, kind: 'transient' | 'absent' = 'absent'): Promise<void> {
    const port = state.port
    state.port = undefined
    state.healthy = false
    // A KNOWN-INSTALLED service that went quiet is usually restarting, so it is
    // retried soon; an absent one is not retried often, because re-probing a
    // device that cannot answer only pays for an `adb forward` round trip.
    state.retryAfter = Date.now() + (kind === 'transient' ? BRIDGE_TRANSIENT_TTL_MS : BRIDGE_NEGATIVE_TTL_MS)
    if (port !== undefined && this.#toolchain.unforward !== undefined) {
      await this.#toolchain.unforward(serial, port).catch(() => {})
    }
  }

  /** Establish the forward, or `undefined` when the device/socket is absent. */
  async #connect(serial: string): Promise<number | undefined> {
    const state = this.#stateOf(serial)
    try {
      // ADOPT an existing forward before creating one. `adb forward` state lives
      // in the adb SERVER, not this process, so a previous run of the plugin (or
      // another client) may already hold a mapping. Creating a fresh one every
      // time leaks a mapping per process — measured: 12 accumulated over one
      // session of test runs — and nothing ever cleans them up, because only a
      // FAILED request calls #drop.
      const adopted = await this.#adoptExisting(serial)
      if (adopted !== undefined) {
        await this.#request(adopted, { id: 0, cmd: 'ping' }, BRIDGE_REQUEST_TIMEOUT_MS).catch(() => undefined)
        return adopted
      }
      const port = await this.#toolchain.forward(serial, `localabstract:${BRIDGE_SOCKET_NAME}`)
      if (!Number.isInteger(port) || port <= 0) {
        // `adb forward` failing is about the transport, not the package: the APK
        // may be perfectly installed while adb itself is mid-restart. Retry soon.
        state.retryAfter = Date.now() + BRIDGE_TRANSIENT_TTL_MS
        return undefined
      }
      // WARM-UP, and it must SUCCEED. `adb forward` establishes the device-side
      // socket lazily: the first connection through a fresh forward can stall
      // while the next answers in single-digit milliseconds. Probing here moves
      // that one-off cost to connect time, where it is paid once per session.
      //
      // Swallowing a failed probe is NOT good enough — measured on a real
      // device, the flow was: probe stalls -> catch swallows it -> the caller's
      // real request stalls on the SAME unestablished handshake -> burns the
      // full 5 s timeout -> the forward is dropped as if broken -> the next
      // call builds a new one and succeeds instantly. The first read of every
      // process therefore cost 5 s AND discarded a working forward.
      //
      // Retrying the warm-up instead turns that into one retry here, after
      // which the forward is genuinely usable.
      // A PROBE budget, not the request budget. This is the whole point: when the
      // service is HUNG -- connected, accepted by nobody -- there is no fast
      // failure to observe. adb forward does not reset the connection when the
      // target socket is absent (measured: TCP connects in 4 ms and then stays
      // silent forever), so the ONLY signal is the timeout. Spending the full 5 s
      // twice here meant one tool call burned 10 s before it even began its
      // fallback, and the user experienced it as 'the fast path randomly is not'.
      const probe = Math.min(BRIDGE_PROBE_TIMEOUT_MS, BRIDGE_REQUEST_TIMEOUT_MS)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const warmed = await this.#request(port, { id: 0, cmd: 'ping' }, probe)
          .then(reply => reply.ok === true)
          .catch(() => false)
        if (warmed) return port
      }
      // Never warm after two tries: give up on this forward and let the caller
      // fall back, rather than making it wait again. The name is still held by the
      // hung instance, so this counts as TRANSIENT -- it is worth retrying soon,
      // because a rebind releases it within a second or so.
      await this.#toolchain.unforward?.(serial, port).catch(() => {})
      state.retryAfter = Date.now() + BRIDGE_TRANSIENT_TTL_MS
      return undefined
    } catch {
      // Same reasoning as the failed probe above: an exception here is about the
      // transport or a rebinding service, not about whether the APK is present.
      state.retryAfter = Date.now() + BRIDGE_TRANSIENT_TTL_MS
      return undefined
    }
  }

  /**
   * Find an existing host→device forward for our socket.
   *
   * `adb forward --list` output is "<serial> tcp:<port> localabstract:<name>".
   * Returns the port of the first match, or undefined when there is none (or the
   * toolchain cannot list them).
   */
  async #adoptExisting(serial: string): Promise<number | undefined> {
    const list = this.#toolchain.listForwards
    if (list === undefined) return undefined
    try {
      for (const line of await list(serial)) {
        if (!line.includes(`localabstract:${BRIDGE_SOCKET_NAME}`)) continue
        const match = / tcp:(\d+) /.exec(` ${line} `)
        if (match === null) continue
        const port = Number(match[1])
        if (Number.isInteger(port) && port > 0) return port
      }
    } catch {
      // Listing is best-effort; a failure just means we create our own.
    }
    return undefined
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
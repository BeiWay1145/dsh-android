/**
 * Cheap screen-change detection: a ~120 ms fingerprint that tells a caller
 * whether a 2.9 s uiautomator dump would return anything new.
 *
 * Why this exists: `uiautomator dump` costs ~2.4–3.0 s on a real device and
 * that cost is almost entirely its own JVM startup + idle-wait, NOT data
 * volume — measured on a 1536x2560 tablet, an empty screen and a full
 * Settings page both take ~2.4 s, while `adb shell echo` is 47 ms and
 * `dumpsys window` is ~100 ms. The dump is therefore the single most
 * expensive verb in this plugin, and a caller that reads the screen twice
 * without the UI having moved pays that price twice for identical data.
 *
 * The fingerprint deliberately reads `dumpsys window` (NOT the `windows`
 * sub-command): the sub-command omits `mCurrentFocus`, so a frames-only hash
 * COLLIDES across genuinely different screens — a bug this code was written
 * against after observing exactly that (launcher and Settings hashing equal).
 *
 * WARNING — this is a change DETECTOR, not a screen reader. Two different
 * screens can still hash equal if neither focus nor any window frame moved
 * (an in-place content update inside one window, e.g. a list refreshing).
 * Callers must treat a match as "likely unchanged" and stay free to dump
 * anyway; never gate a CORRECTNESS decision on it.
 * @module @zseven-w/dsh-android/screen-fingerprint
 */

import { createHash } from 'node:crypto'
import type { UiTreeToolchain } from './uitree.js'

/** Lines of `dumpsys window` worth hashing: focus plus every window frame. */
const FINGERPRINT_LINE = /mCurrentFocus=|mFocusedApp=|Frames:/

/** One screen fingerprint: the digest plus what it was taken from. */
export interface ScreenFingerprint {
  /** Stable digest of the focus + frame lines ('' digest when unavailable). */
  digest: string
  /** The current focus line, for logging/diagnostics. */
  focus: string
  /** Wall-clock cost of taking this fingerprint, in ms. */
  elapsedMs: number
}

/**
 * Take one cheap fingerprint of the device's current screen state.
 *
 * Returns a digest of the lines that actually move when the UI moves. On any
 * failure it answers with an empty digest, which callers must treat as
 * "unknown" — never as "unchanged".
 */
export async function screenFingerprint(
  toolchain: UiTreeToolchain,
  serial: string,
): Promise<ScreenFingerprint> {
  const started = Date.now()
  try {
    const raw = await toolchain.shell(serial, ['dumpsys', 'window'], { timeoutMs: 10_000 })
    const lines = raw.split('\n').filter(line => FINGERPRINT_LINE.test(line))
    const focusLine = lines.find(line => line.includes('mCurrentFocus=')) ?? ''
    const digest = lines.length === 0
      ? ''
      : createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
    return { digest, focus: focusLine.trim(), elapsedMs: Date.now() - started }
  }
  catch {
    return { digest: '', focus: '', elapsedMs: Date.now() - started }
  }
}

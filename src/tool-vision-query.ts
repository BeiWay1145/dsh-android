/**
 * Model-facing SEMANTIC reading tools: `android_query` extracts structured
 * data from the current screen and `android_assert` answers a yes/no question
 * about it — both by handing the screenshot to the CALLING model as an image
 * block, so the answer comes from the routed model itself rather than from a
 * second, hidden vision service.
 *
 * Why these exist (and why they are not a Midscene-style bolt-on):
 *
 * The plugin's text readers answer "what nodes are there" — `android_ui_tree`
 * and `android_ui_rows` return markup the model must then interpret. That is
 * the right primitive for FINDING a control to tap, but it is a poor one for
 * two questions that come up constantly in real automation:
 *
 *   1. "What does this screen SAY?" — read a price, a status, a list of
 *      results, a form's current values. The hierarchy costs ~10k tokens on a
 *      content screen (measured: 32,231 bytes on a 1536x2524 Settings page)
 *      and still has to be reasoned over; a screenshot costs one image.
 *   2. "Is this screen in the state I expected?" — verification. Node
 *      presence proves a control exists, never that the UI LOOKS right
 *      (a loading spinner, an error banner, a red validation tint are all
 *      invisible to a node-existence check).
 *
 * Both are answered natively by a model that declares `image` input. The
 * alternative — bundling a separate VLM agent — would add a ~35 MB dependency
 * tree, bill outside DSH's meter, and bypass the route's prefix cache. Here
 * the screenshot travels through the SAME attachment + image-block seam the
 * capture tools already use, so cost lands on the caller's own route and in
 * cost-meter, and the feature degrades to a clear explanation on a text-only
 * route instead of silently costing someone else's tokens.
 *
 * Degradation rule (mirrors the rest of the plugin, and is the opposite of
 * `read_image`'s refuse-on-text-only stance): these tools CANNOT work without
 * image input, so on a text-only route they fail LOUDLY with the remedy
 * (switch model / use android_ui_tree), rather than returning a result the
 * model would hallucinate from.
 * @module @zseven-w/dsh-android/tool-vision-query
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json-value.js'
import type { AndroidDevice } from './adb.js'
import type { AndroidHostController } from './android-host.js'
import {
  ScreenshotStore,
  deviceSchema,
  errorMessage,
  resolveTarget,
  screenshotMeta,
  type AndroidDeviceInfo,
  type AndroidScreenshotResult,
} from './tool-support.js'
import { screenshotDir } from './stream-access.js'
import {
  IMAGE_REF_SCHEMA,
  imageInputActive,
  renderJsonWithImage,
  saveScreenshotAttachment,
  type AndroidVisionServices,
  type VisionExecLike,
} from './vision.js'
import { basename, join } from 'node:path'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** Registered tool names, in registration order. */
export const ANDROID_VISION_QUERY_TOOL_NAMES = ['android_query', 'android_assert'] as const

/** Options for {@link createAndroidVisionQueryTools}. */
export interface AndroidVisionQueryToolsOptions {
  /** The optional vision services resolved from the plugin context. */
  vision?: AndroidVisionServices
  /** Plugin-owned cache root for screenshots (default `<tmp>/dsh-android`). */
  cacheDir?: string
}

/** The two semantic-reading tool definitions bound to one host controller. */
export interface AndroidVisionQueryTools {
  androidQuery: ToolDefinition
  androidAssert: ToolDefinition
}

/**
 * Human-readable remedy for a route that cannot accept an image. Kept in one
 * place because both tools fail through it.
 */
function textOnlyRemedy(tool: string, serial: string): string {
  return `${tool}: this tool needs the screenshot to reach the model, but the current route's model does not `
    + 'declare "image" input — there is nothing to read the picture with. Either switch to an image-capable '
    + `model (the screenshot is captured from ${serial} and attached to this result as an image block), or use `
    + 'android_ui_tree / android_ui_rows, which read the accessibility hierarchy as TEXT and work on every '
    + 'route. Refusing here is deliberate: returning a text summary instead would invite an answer the model '
    + 'cannot actually ground.'
}

/**
 * Capture + attach, refusing (not degrading) when no image can be delivered.
 *
 * `captureScreenshot` in tool-support.ts degrades on purpose because its JSON
 * summary is a useful result on its own. Here the image IS the result, so the
 * missing attachment is a hard error carrying the remedy.
 */
async function captureForReading(
  host: AndroidHostController,
  store: ScreenshotStore,
  tool: string,
  device: AndroidDevice,
  summary: AndroidDeviceInfo,
  vision: AndroidVisionServices | undefined,
  exec: VisionExecLike,
): Promise<AndroidScreenshotResult> {
  if (vision === undefined || vision.attachments === undefined) {
    throw new Error(
      `${tool}: no attachment store is mounted on this host, so a screenshot cannot be delivered to the `
      + 'model. Use android_ui_tree / android_ui_rows (pure text) instead.',
    )
  }
  if (!await imageInputActive(vision, exec)) throw new Error(textOnlyRemedy(tool, device.serial))

  let shot: { png: Buffer; width?: number; height?: number }
  try {
    shot = await host.screenshot(device.serial)
  } catch (error) {
    throw new Error(
      `${tool}: the screencap on ${device.serial} failed: ${errorMessage(error)}. The device itself is `
      + 'still reachable, so this is a DISPLAY problem, not a lost device. '
      + 'A lock-screen gesture is the measured cause: it leaves an empty capture for ~10 s. '
      + 'Wait or read the accessibility tree (android_ui_tree does not read the display). '
      + 'Do NOT run android_devices for this - it reports the device as healthy, because it is.'
      + await host.sleepingScreenNote(device.serial),
    )
  }
  const path = store.nextPath(device.serial)
  try {
    writeFileSync(path, shot.png)
  } catch (error) {
    throw new Error(`${tool}: could not write the screenshot to ${path}: ${errorMessage(error)}`)
  }
  const image = await saveScreenshotAttachment(vision, shot.png, basename(path))
  if (image === undefined) {
    throw new Error(
      `${tool}: the screenshot (${shot.png.byteLength} bytes) could not be admitted to the attachment store, so `
      + 'it cannot reach the model. Use android_ui_tree / android_ui_rows (pure text) instead.',
    )
  }
  return {
    path,
    bytes: statSync(path).size,
    ...(shot.width === undefined ? {} : { width: shot.width }),
    ...(shot.height === undefined ? {} : { height: shot.height }),
    device: summary,
    image,
  }
}
/** Create the two semantic-reading tools bound to one host. */
export function createAndroidVisionQueryTools(
  host: AndroidHostController,
  options: AndroidVisionQueryToolsOptions = {},
): AndroidVisionQueryTools {
  const vision = options.vision
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-android')
  // Same store layout as the capture tools: one directory, one numbering.
  const screenshots = new ScreenshotStore(
    options.cacheDir === undefined ? screenshotDir() : join(cacheDir, 'screenshots'),
  )

  const androidQuery = defineTool({
    name: 'android_query',
    description: 'Read STRUCTURED DATA off the current screen by looking at it, instead of parsing the '
      + 'accessibility tree. Captures the screen and attaches it to this result as an image, so the CALLING '
      + 'model extracts the fields itself. Use it for "what does this screen say" — a price, a status, a '
      + 'list of search results, the current values of a form, a table, anything rendered as text or '
      + 'graphics that the hierarchy either reports expensively (~10k tokens on a busy screen) or not at '
      + 'all (a Compose/Flutter/WebView surface, a canvas, text baked into an image). Pass `fields` as an '
      + 'array of names to get an object with exactly those keys, or as a natural-language string for '
      + 'free-form JSON. Requires an image-capable route: on a text-only model this tool FAILS with the '
      + 'remedy rather than guessing — use android_ui_tree or android_ui_rows there. To find a control to '
      + 'TAP, prefer android_ui_tree + android_tap_element (identity beats pixels).',
    parameters: {
      fields: {
        type: 'json',
        required: true,
        description: 'What to extract. Either an array of field names (e.g. '
          + '["wifi_name","signal_strength","ip_address"]) to get an object with exactly those keys, or a '
          + 'string describing the data in natural language (e.g. "each visible network with its signal '
          + 'strength and whether it is secured") to get free-form JSON.',
      },
      device: {
        type: 'string',
        description: 'Target adb serial. Defaults to the currently streamed device, else the only online '
          + 'one (with two or more attached, the serial is required).',
      },
      hint: {
        type: 'string',
        description: 'Optional short note about the app or screen (e.g. "this is the WLAN settings page '
          + 'of MIUI Settings") to disambiguate field meanings.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instructions: {
            type: 'string',
            required: true,
            description: 'The extraction task, restated for the model reading the attached image.',
          },
          hint: { type: 'string' },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          device: { ...deviceSchema, required: true },
          image: IMAGE_REF_SCHEMA,
        },
      },
      render: renderJsonWithImage,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => screenshotMeta(value),
    },
    timeoutMs: 120_000,
    async execute(args: { fields: JsonValue; device?: string; hint?: string }, exec) {
      const { device, summary } = await resolveTarget(host, 'android_query', args.device)
      const instructions = Array.isArray(args.fields)
        ? `Extract these fields from the attached screenshot: ${JSON.stringify(args.fields)}. `
          + 'Reply with a single JSON object using exactly those keys. Use null for a field that is not '
          + 'visible on this screen. Do not invent values.'
        : `Extract from the attached screenshot: ${String(args.fields)}. Reply with JSON only.`
      const capture = await captureForReading(
        host, screenshots, 'android_query', device, summary, vision, exec,
      )
      return {
        instructions,
        ...(args.hint === undefined ? {} : { hint: args.hint }),
        ...capture,
      } as never
    },
    presentCall: (args: { fields: JsonValue; device?: string }) => ({
      card: 'generic',
      title: args.device === undefined
        ? 'Query Android screen'
        : ('Query ' + args.device + ': ' + (Array.isArray(args.fields) ? args.fields.join(', ') : String(args.fields))),
      kind: 'read',
    }),
  })
  const androidAssert = defineTool({
    name: 'android_assert',
    description: 'Answer a yes/no question about the CURRENT screen by looking at it. Captures the screen '
      + 'and attaches it to this result as an image, so the CALLING model judges the claim itself. Use it '
      + 'to verify that an action actually produced the expected STATE — "the login form shows an error", '
      + '"the list is still loading", "the dialog is gone", "the total reads 42.00" — which a '
      + 'node-existence check cannot answer (spinners, banners, error tints and disabled styling are '
      + 'invisible to android_ui_tree). Phrase claim as a statement to be judged, not a question. '
      + 'Requires an image-capable route: on a text-only model this tool FAILS with the remedy rather '
      + 'than guessing. Not a substitute for android_tap_element expect_text, which verifies one tap '
      + 'in the same round trip and costs no image.',
    parameters: {
      claim: {
        type: 'string',
        required: true,
        description: 'A statement about the current screen to judge true or false, e.g. "the device is '
          + 'connected to a WiFi network" or "an error message is visible".',
      },
      device: {
        type: 'string',
        description: 'Target adb serial. Defaults to the currently streamed device, else the only online '
          + 'one (with two or more attached, the serial is required).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: {
            type: 'string',
            required: true,
            description: 'The claim, restated for the model reading the attached image.',
          },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          device: { ...deviceSchema, required: true },
          image: IMAGE_REF_SCHEMA,
        },
      },
      render: renderJsonWithImage,
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => screenshotMeta(value),
    },
    timeoutMs: 120_000,
    async execute(args: { claim: string; device?: string }, exec) {
      if (typeof args.claim !== 'string' || args.claim.trim() === '') {
        throw new Error('android_assert: "claim" must be a non-empty statement to judge against this screen')
      }
      const { device, summary } = await resolveTarget(host, 'android_assert', args.device)
      const capture = await captureForReading(
        host, screenshots, 'android_assert', device, summary, vision, exec,
      )
      return {
        claim: 'Judge whether this statement about the attached screenshot is TRUE or FALSE: "'
          + args.claim.trim()
          + '". Answer with JSON {"pass":true|false,"thought":"<short reason citing what you see>"}. '
          + 'Base the verdict only on what is visible.',
        ...capture,
      } as never
    },
    presentCall: (args: { claim: string; device?: string }) => ({
      card: 'generic',
      title: args.device === undefined
        ? ('Assert: ' + args.claim)
        : ('Assert on ' + args.device + ': ' + args.claim),
      kind: 'read',
    }),
  })

  return { androidQuery, androidAssert }
}

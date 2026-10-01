/**
 * Turn-completion notifications for the DeepSeek Harness host.
 *
 * One behavior: when a top-level Agent finishes a turn and returns to `idle`,
 * raise a Windows system notification (Toast) so the user learns their answer
 * landed even when the window is not in front of them.
 *
 * The plugin is Windows-only by construction — the transport is a PowerShell
 * shim that posts a Windows Runtime toast, falling back to BurntToast and then
 * to a self-closing message box. On other platforms the plugin loads, says so,
 * and does nothing.
 *
 * @module dsh-notify-completion
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { completionVariables, createCompletionDecider, encodePayload, renderToast } from './render.js'

/** Stable plugin id, matching the package name's short form. */
export const name = 'notify-completion'

/**
 * Services this plugin reads. Declared so the Loader keeps the fiber inactive
 * until they exist, rather than letting a status event arrive with no way to
 * resolve a session title.
 */
export const inject = ['agents', 'sessionTitle']

const Config = z.object({
  /** Master switch; turning it off leaves the plugin loaded and inert. */
  enabled: z.boolean().default(true),

  /** AppUserModelId the toast is posted under (registered under HKCU on use). */
  appId: z.string().default('DeepSeek.Harness.CompletionNotify'),

  /** Display name Windows shows as the notification's source. */
  appName: z.string().default('DeepSeek Harness'),

  /** Toast headline. Placeholders: see `PLACEHOLDERS` in `./render.js`. */
  titleTemplate: z.string().default('DSH 对话完成'),

  /**
   * Toast body. The default names the session (or its directory) and how long
   * the turn took — the information needed to decide whether to come back now.
   */
  messageTemplate: z.string().default('{{sessionTitle}}\n{{cwd}}\n用时 {{duration}}'),

  /** Also notify when a subagent finishes. Off: only top-level turns notify. */
  includeSubagents: z.boolean().default(false),

  /** Post the toast without its default sound. */
  silent: z.boolean().default(false),

  /** Seconds before the message-box fallback closes itself (0 = wait forever). */
  fallbackSeconds: z.number().step(1).min(0).default(10),

  /** Cap on `{{lastText}}`, in characters, so a long answer cannot fill the toast. */
  lastTextChars: z.number().step(1).min(0).default(120),

  /**
   * Minimum gap between two notifications, in milliseconds. Turns finishing
   * closer together than this are suppressed. 0 notifies on every turn.
   */
  throttleMs: z.number().step(1).min(0).default(1500),

  /**
   * PowerShell executable. When empty, a PowerShell 7 install is used if found,
   * else the always-present `powershell.exe` (Windows PowerShell 5.1).
   */
  powershellPath: z.string().default(''),

  /** Report each delivered notification's shim exit code to the host log. */
  debugLog: z.boolean().default(false),
})

/** Absolute path of the bundled PowerShell shim, derived from this module. */
const SHIM_PATH = fileURLToPath(new URL('./notify-windows.ps1', import.meta.url))

/**
 * Resolve the PowerShell executable to use.
 *
 * `pwsh` is preferred when actually installed (PowerShell 7 loads the WinRT
 * projection more reliably), but Windows PowerShell 5.1 ships with every
 * supported Windows version, so it is the dependable default rather than an
 * error case.
 *
 * @param configured - explicit `powershellPath`; wins when non-empty.
 * @returns the executable name or path to spawn.
 */
function resolvePowerShell(configured) {
  if (configured) return configured
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * Post one Windows notification by handing a base64 JSON payload to the shim.
 *
 * The child is detached with `stdio: 'ignore'` so the host neither blocks on a
 * notification nor captures its output; a pending toast must never keep the
 * host process alive.
 *
 * @param options - resolved notification request.
 * @param options.powershell - executable to spawn.
 * @param options.payload - payload object serialized into `-PayloadBase64`.
 * @param options.debugLog - whether to report the shim's exit code.
 */
function postNotification({ powershell, payload, debugLog }) {
  const encoded = encodePayload(payload)

  let child
  try {
    child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHIM_PATH, '-PayloadBase64', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
  } catch (error) {
    console.error('[notify-completion] failed to spawn PowerShell:', error)
    return
  }

  child.on('error', (error) => {
    console.error('[notify-completion] PowerShell could not be started:', error)
  })

  if (debugLog) {
    // 0 = a tier delivered, 1 = every tier failed, 2 = rejected payload.
    child.on('exit', (code) => {
      console.log(`[notify-completion] shim exit ${code}`)
    })
  }

  child.unref()
}

/**
 * Install the completion listener.
 *
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('notify-completion: Windows-only plugin; inactive on this platform')
    return
  }

  const powershell = resolvePowerShell(config.powershellPath)

  /**
   * Whether the agent is top-level.
   *
   * `agents.roots()` reports exactly the agents nobody owns — the same
   * distinction the host itself uses to tell a session from its subagents.
   */
  function isRoot(agent) {
    const agents = ctx.get('agents')
    if (!agents) return true
    try {
      return agents.roots().includes(agent)
    } catch {
      // A registry that cannot answer must not silently swallow notifications.
      return true
    }
  }

  const decider = createCompletionDecider({
    includeSubagents: config.includeSubagents,
    throttleMs: config.throttleMs,
    isRoot,
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (!config.enabled) return

    const completion = decider.note(agent, status)
    if (!completion) return

    const session = agent.session
    const variables = completionVariables({
      appName: config.appName,
      session,
      sessionTitle: ctx.get('sessionTitle')?.get(session)?.title ?? '',
      sessionId: agent.id,
      durationMs: completion.durationMs,
      lastTextChars: config.lastTextChars,
    })

    const { title, message } = renderToast({
      titleTemplate: config.titleTemplate,
      messageTemplate: config.messageTemplate,
      variables,
      appName: config.appName,
    })

    if (config.debugLog) {
      console.log(`[notify-completion] turn complete: ${JSON.stringify(title)} / ${JSON.stringify(message)}`)
    }

    postNotification({
      powershell,
      debugLog: config.debugLog,
      payload: {
        title,
        message,
        appId: config.appId,
        appName: config.appName,
        fallbackSeconds: config.fallbackSeconds,
        silent: config.silent,
      },
    })
  })
}

export { Config }

/**
 * Pure decision and rendering logic for the notify-completion plugin.
 *
 * Kept apart from the plugin entry so the turn-completion rule, the template
 * rendering, and the notification payload can be tested directly, with no
 * PowerShell process and no Cordis context involved.
 *
 * @module dsh-notify-completion/render
 */

/** Placeholders accepted in `titleTemplate` / `messageTemplate`. */
export const PLACEHOLDERS = Object.freeze([
  'appName',
  'sessionTitle',
  'sessionId',
  'cwd',
  'cwdName',
  'duration',
  'lastText',
])

/**
 * Substitute `{{name}}` placeholders in one template.
 *
 * Unknown placeholders are left verbatim rather than blanked: a typo in a
 * user's template stays visible in the toast instead of silently vanishing.
 *
 * @param template - template text.
 * @param variables - placeholder values, keyed by placeholder name.
 * @returns the rendered text.
 */
export function render(template, variables) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.hasOwn(variables, key) ? String(variables[key] ?? '') : whole,
  )
}

/**
 * Drop whitespace-only lines and trim each end, so a toast never shows empty
 * rows left behind by an unset placeholder.
 *
 * @param text - rendered text.
 * @returns the compacted text.
 */
export function compact(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Format a duration in milliseconds as a short human string.
 *
 * @param ms - elapsed milliseconds.
 * @returns e.g. `8 秒`, `2 分 5 秒`, `1 小时 3 分`; `—` for a non-finite input.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/**
 * Truncate text to a character budget, marking the omission.
 *
 * @param text - source text.
 * @param limit - maximum characters; 0 or less returns an empty string.
 * @returns the truncated text.
 */
export function truncate(text, limit) {
  const source = String(text ?? '')
  if (!limit || limit <= 0) return ''
  if (source.length <= limit) return source
  return `${source.slice(0, limit)}…`
}

/**
 * Extract the plain text of the last assistant message in a session log.
 *
 * The log is the only source of truth for what was actually said, so the
 * preview is derived from it rather than from a stream buffer.
 *
 * @param session - live session whose `events` are read; may be undefined.
 * @returns concatenated text blocks of the last assistant message, or ''.
 */
export function lastAssistantText(session) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const blocks = event.message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

/**
 * Collect the template variables for one completed turn.
 *
 * @param options - completion facts.
 * @param options.appName - configured display name.
 * @param options.session - the finished agent's session, if resolvable.
 * @param options.sessionTitle - folded title, if the service produced one.
 * @param options.sessionId - fallback identity when no session object exists.
 * @param options.durationMs - turn duration, or undefined when unmeasured.
 * @param options.lastTextChars - character cap for `{{lastText}}`.
 * @returns placeholder values keyed by placeholder name.
 */
export function completionVariables({ appName, session, sessionTitle, sessionId, durationMs, lastTextChars }) {
  const cwd = session?.header?.cwd ?? ''
  const cwdName = cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : ''

  return {
    appName,
    sessionTitle: sessionTitle || cwdName || '(未命名会话)',
    sessionId: String(session?.id ?? sessionId ?? ''),
    cwd,
    cwdName,
    duration: durationMs === undefined ? '—' : formatDuration(durationMs),
    lastText: truncate(lastAssistantText(session), lastTextChars),
  }
}

/**
 * Render the final toast title and body from a completion's variables.
 *
 * A template that renders to nothing but whitespace falls back to `appName`,
 * so an over-eager custom template cannot produce a blank notification.
 *
 * @param options - rendering inputs.
 * @param options.titleTemplate - headline template.
 * @param options.messageTemplate - body template.
 * @param options.variables - placeholder values from {@link completionVariables}.
 * @param options.appName - fallback headline and the configured source name.
 * @returns the compacted `{ title, message }`.
 */
export function renderToast({ titleTemplate, messageTemplate, variables, appName }) {
  return {
    title: compact(render(titleTemplate, variables)) || appName,
    message: compact(render(messageTemplate, variables)),
  }
}

/**
 * Build the base64 payload the PowerShell shim consumes.
 *
 * Base64 keeps the transport ASCII-only, so a session title containing quotes,
 * newlines, or non-Latin text cannot be misread as command-line syntax by the
 * shell that launches the shim.
 *
 * @param payload - notification fields.
 * @returns the base64-encoded UTF-8 JSON string.
 */
export function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/**
 * Create the stateful turn-completion rule.
 *
 * A notification is earned by a real `running → idle` edge: `idle` repeated
 * (which the loop may re-emit) notifies once, and an agent that never ran
 * never notifies. The throttle then collapses bursts of turns that finish
 * together.
 *
 * @param options - rule configuration.
 * @param options.includeSubagents - whether non-root agents may notify.
 * @param options.throttleMs - minimum gap between notifications; 0 disables it.
 * @param options.isRoot - predicate deciding whether an agent is top-level.
 * @param options.now - clock, injectable for tests.
 * @returns an object whose `note(agent, status)` returns the completion to
 *   notify for, or `null` when this transition earns no notification.
 */
export function createCompletionDecider({ includeSubagents, throttleMs, isRoot, now = Date.now }) {
  /** Last observed status per agent, so only the running → idle edge notifies. */
  const lastStatus = new WeakMap()
  /** When each agent's turn started, for the `{{duration}}` placeholder. */
  const turnStartedAt = new WeakMap()
  /** Wall clock of the last delivered notification, or null before the first. */
  let lastNotifiedAt = null

  return {
    /**
     * Record one status transition and decide whether it completes a turn.
     *
     * @param agent - the agent whose status changed.
     * @param status - the status just entered.
     * @returns `{ durationMs }` when this transition earns a notification, else `null`.
     */
    note(agent, status) {
      const previous = lastStatus.get(agent)
      lastStatus.set(agent, status)

      if (status === 'running') {
        turnStartedAt.set(agent, now())
        return null
      }
      if (status !== 'idle' || previous !== 'running') return null
      if (!includeSubagents && !isRoot(agent)) return null

      const current = now()
      if (throttleMs > 0 && lastNotifiedAt !== null && current - lastNotifiedAt < throttleMs) return null

      lastNotifiedAt = current
      const startedAt = turnStartedAt.get(agent)
      return { durationMs: startedAt === undefined ? undefined : current - startedAt }
    },
  }
}

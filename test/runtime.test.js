/**
 * Real-runtime tests: load the plugin into an actual Cordis Context and drive
 * turns through it.
 *
 * A fake context proves a listener was registered; only the real runtime proves
 * that `inject` resolves, the fiber activates, and an emitted `agent/status`
 * event actually reaches the plugin's handler.
 *
 * Delivery is observed without raising a notification: `powershellPath` is
 * pointed at an executable that cannot exist, so any attempt to notify fails
 * loudly with an `ENOENT` whose `spawnargs` carry the exact argv — including the
 * base64 payload the plugin built. That makes both directions assertable:
 * counting errors shows whether the plugin spawned at all, and the captured
 * argv shows exactly what it tried to send.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { Config, apply, inject, name } from '../lib/index.js'

/** A path that is guaranteed not to resolve to an executable. */
const MISSING_POWERSHELL = 'dsh-notify-completion-no-such-executable'

/** A session whose log carries one assistant message, as the plugin reads it. */
const SESSION = {
  id: 'session-test-1',
  header: { cwd: 'C:\\work\\proj' },
  events: [{ type: 'assistant/message', message: { content: [{ type: 'text', text: '搞定了' }] } }],
}

/**
 * Start capturing the spawn failures the plugin reports.
 *
 * @returns `{ errors, restore }` — the collected failures and a stop function.
 */
function captureSpawnErrors() {
  const errors = []
  const original = console.error
  console.error = (...args) => {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && arg.code === 'ENOENT' && Array.isArray(arg.spawnargs)) {
        errors.push(arg)
      }
    }
  }
  return { errors, restore: () => { console.error = original } }
}

/**
 * Wait until `predicate` holds, so a detached spawn has time to fail.
 *
 * @param predicate - condition to poll.
 * @param timeoutMs - maximum wait.
 * @returns whether the predicate became true.
 */
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/**
 * Build a Cordis context with the services the plugin injects.
 *
 * @param roots - agents reported as top-level.
 * @returns the context.
 */
function makeContext(roots) {
  const ctx = new Context()
  ctx.provide('agents', { roots: () => roots })
  ctx.provide('sessionTitle', { get: () => ({ title: '开发插件' }) })
  return ctx
}

test('the plugin activates in a real Cordis context and notifies a completed turn', async () => {
  const root = { id: SESSION.id, session: SESSION }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    // Cordis takes the SCHEMA on the plugin object and the raw config as the
    // second argument; it validates and fills defaults before `apply` runs.
    const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL })
    await pluginCtx

    // A running → idle edge is one completed turn.
    ctx.emit('agent/status', { agent: root, status: 'running' })
    ctx.emit('agent/status', { agent: root, status: 'idle' })

    assert.ok(await waitFor(() => capture.errors.length > 0), 'the plugin never attempted to notify')

    const { spawnargs } = capture.errors[0]
    assert.ok(spawnargs.includes('-PayloadBase64'), `unexpected argv: ${spawnargs.join(' ')}`)

    const encoded = spawnargs[spawnargs.indexOf('-PayloadBase64') + 1]
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))

    assert.equal(payload.title, 'DSH 对话完成')
    assert.match(payload.message, /开发插件/)
    assert.match(payload.message, /proj/)
    assert.equal(payload.appId, 'DeepSeek.Harness.CompletionNotify')
    assert.equal(payload.appName, 'DeepSeek Harness')
    assert.equal(payload.silent, false)

    await pluginCtx.dispose()
  } finally {
    capture.restore()
  }
})

test('a repeated idle does not notify a second time', async () => {
  const root = { id: SESSION.id, session: SESSION }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL })
    await pluginCtx

    ctx.emit('agent/status', { agent: root, status: 'running' })
    ctx.emit('agent/status', { agent: root, status: 'idle' })
    assert.ok(await waitFor(() => capture.errors.length === 1))

    // The loop may re-emit idle; that is not a new completed turn.
    ctx.emit('agent/status', { agent: root, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(capture.errors.length, 1, 'a repeated idle must not notify again')

    await pluginCtx.dispose()
  } finally {
    capture.restore()
  }
})

test('a subagent completion stays silent under the default configuration', async () => {
  const root = { id: 'root', session: { ...SESSION, id: 'root' } }
  const child = { id: 'child', session: { ...SESSION, id: 'child' } }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL })
    await pluginCtx

    // A spawn attempt against a missing executable always reports ENOENT, so
    // "no error" conclusively means "no notification was ever attempted".
    ctx.emit('agent/status', { agent: child, status: 'running' })
    ctx.emit('agent/status', { agent: child, status: 'idle' })

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(capture.errors.length, 0, 'a subagent turn must not notify by default')

    await pluginCtx.dispose()
  } finally {
    capture.restore()
  }
})

test('includeSubagents lets a subagent turn notify', async () => {
  const root = { id: 'root', session: { ...SESSION, id: 'root' } }
  const child = { id: 'child', session: { ...SESSION, id: 'child' } }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    const pluginCtx = ctx.plugin(
      { name, inject, apply, Config },
      { powershellPath: MISSING_POWERSHELL, includeSubagents: true },
    )
    await pluginCtx

    ctx.emit('agent/status', { agent: child, status: 'running' })
    ctx.emit('agent/status', { agent: child, status: 'idle' })

    assert.ok(await waitFor(() => capture.errors.length > 0), 'includeSubagents should allow a subagent to notify')

    await pluginCtx.dispose()
  } finally {
    capture.restore()
  }
})

test('disposing the plugin stops delivery', async () => {
  const root = { id: SESSION.id, session: SESSION }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL })
    await pluginCtx
    await pluginCtx.dispose()

    ctx.emit('agent/status', { agent: root, status: 'running' })
    ctx.emit('agent/status', { agent: root, status: 'idle' })

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(capture.errors.length, 0, 'a disposed plugin must not notify')
  } finally {
    capture.restore()
  }
})

test('enabled: false leaves a loaded plugin inert', async () => {
  const root = { id: SESSION.id, session: SESSION }
  const ctx = makeContext([root])
  const capture = captureSpawnErrors()

  try {
    const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL, enabled: false })
    await pluginCtx

    ctx.emit('agent/status', { agent: root, status: 'running' })
    ctx.emit('agent/status', { agent: root, status: 'idle' })

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(capture.errors.length, 0, 'a disabled plugin must not notify')

    await pluginCtx.dispose()
  } finally {
    capture.restore()
  }
})

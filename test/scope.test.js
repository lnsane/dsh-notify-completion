/**
 * Scope-routing test: the gap the other suites miss.
 *
 * `runtime.test.js` drives the plugin with `ctx.emit('agent/status', …)`, an
 * UNSCOPED dispatch. The real agent loop never does that: it dispatches through
 * a scope carrier (`scopeTarget(agent, agent)`) built by `agentEvents()` in
 * `@deepseek-ai/dsh-agent`, so the event carries a scope key that Cordis uses to
 * filter listeners.
 *
 * This suite reproduces the production topology — the plugin mounted as a
 * sibling plugin fiber, the scope created from the loop's own context, and the
 * event dispatched through the agent carrier — so a listener that silently
 * receives nothing fails here instead of in the user's live session.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget, scopeOf } from '@deepseek-ai/dsh-scope'

import { Config, apply, inject, name } from '../lib/index.js'

const MISSING_POWERSHELL = 'dsh-notify-completion-no-such-executable'

const SESSION = {
  id: 'session-scoped-1',
  header: { cwd: 'C:\\work\\proj' },
  events: [{ type: 'assistant/message', message: { content: [{ type: 'text', text: '搞定了' }] } }],
}

/** Capture the spawn failures the plugin reports, as in runtime.test.js. */
function captureSpawnErrors() {
  const errors = []
  const original = console.error
  console.error = (...args) => {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && arg.code === 'ENOENT' && Array.isArray(arg.spawnargs)) errors.push(arg)
    }
  }
  return { errors, restore: () => { console.error = original } }
}

/** Poll until `predicate` holds, giving a detached spawn time to fail. */
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/**
 * Build the production-shaped tree: plugin and loop as sibling plugin fibers.
 *
 * @param options - `roots` for the agents service, and plugin config overrides.
 * @returns the root context, the agents array, and a `dispatch` helper that
 *   emits through the agent's scope carrier exactly as the loop does.
 */
async function makeScopedTree({ roots = [], config = {} } = {}) {
  const root = new Context()
  root.provide('agents', { roots: () => roots })
  root.provide('sessionTitle', { get: () => ({ title: '开发插件' }) })

  // The plugin, mounted the way the Loader mounts it.
  const pluginFiber = root.plugin({ name, inject, apply, Config }, { powershellPath: MISSING_POWERSHELL, ...config })
  await pluginFiber

  return {
    root,
    pluginFiber,
    /**
     * Emit one status through the agent's scope carrier.
     *
     * @param agent - subject agent; also the scope key.
     * @param status - the status to publish.
     * @param via - context whose scope hosts the agent (the "loop").
     */
    dispatch(agent, status, via) {
      const carrier = scopeTarget(agent, agent)
      const args = [carrier, 'agent/status', { status, agent }]
      const callbacks = via.events.dispatch('emit', args)
      for (const callback of callbacks) callback(...args)
      return callbacks.length
    },
  }
}

test('a scope-routed agent/status reaches the plugin from a sibling fiber', async () => {
  const agent = { id: SESSION.id, session: SESSION }
  const tree = await makeScopedTree({ roots: [agent] })
  const capture = captureSpawnErrors()

  try {
    let matched = 0
    // The loop owns the agent scope, exactly as ReactLoopAgent does.
    const loop = tree.root.plugin({
      name: 'loop',
      apply(ctx) {
        const scope = createScope(ctx, agent)
        assert.ok(scopeOf(scope.ctx), 'the agent scope must be keyed by the agent')
        matched = tree.dispatch(agent, 'running', ctx)
        tree.dispatch(agent, 'idle', ctx)
      },
    })
    await loop

    assert.ok(matched > 0, 'no listener matched the scoped dispatch at all')

    assert.ok(
      await waitFor(() => capture.errors.length > 0),
      'the scoped running→idle turn never reached the plugin',
    )

    const { spawnargs } = capture.errors[0]
    const payload = JSON.parse(
      Buffer.from(spawnargs[spawnargs.indexOf('-PayloadBase64') + 1], 'base64').toString('utf8'),
    )
    assert.equal(payload.title, 'DSH 对话完成')
    assert.match(payload.message, /开发插件/)

    await tree.pluginFiber.dispose()
  } finally {
    capture.restore()
  }
})

test('a scope-routed subagent turn stays silent by default', async () => {
  const rootAgent = { id: 'root', session: { ...SESSION, id: 'root' } }
  const childAgent = { id: 'child', session: { ...SESSION, id: 'child' } }
  const tree = await makeScopedTree({ roots: [rootAgent] })
  const capture = captureSpawnErrors()

  try {
    const loop = tree.root.plugin({
      name: 'loop',
      apply(ctx) {
        const rootScope = createScope(ctx, rootAgent)
        // A nested scope under the root agent's scope: the subagent topology.
        createScope(rootScope.ctx, childAgent)
        tree.dispatch(childAgent, 'running', ctx)
        tree.dispatch(childAgent, 'idle', ctx)
      },
    })
    await loop

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(capture.errors.length, 0, 'a subagent turn must not notify by default')

    await tree.pluginFiber.dispose()
  } finally {
    capture.restore()
  }
})

test('the plugin sees events for an agent it did not create', async () => {
  // Regression guard for the reported symptom: sessions other than the one that
  // loaded the plugin are exactly the ones whose turns must still notify.
  const otherSession = { id: 'session-other-42', session: { ...SESSION, id: 'session-other-42' } }
  const tree = await makeScopedTree({ roots: [otherSession] })
  const capture = captureSpawnErrors()

  try {
    const loop = tree.root.plugin({
      name: 'loop',
      apply(ctx) {
        createScope(ctx, otherSession)
        tree.dispatch(otherSession, 'running', ctx)
        tree.dispatch(otherSession, 'idle', ctx)
      },
    })
    await loop

    assert.ok(
      await waitFor(() => capture.errors.length > 0),
      'an unrelated session must still notify',
    )

    await tree.pluginFiber.dispose()
  } finally {
    capture.restore()
  }
})

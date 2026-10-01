/**
 * Delivery regression test: a spawn that "succeeds" but shows nothing.
 *
 * The bug this guards against is invisible to every other suite: the plugin
 * spawned PowerShell with `detached: true`, the shim exited 0, and the logs said
 * "delivered" — while Windows displayed nothing. The shim's exit code cannot
 * detect it, because the WinRT call genuinely does not throw; the toast is
 * simply never shown.
 *
 * The only honest check is the one Windows itself keeps: the per-AppUserModelId
 * `LastNotificationAddedTime` under
 * `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AUMID>`,
 * which changes only when a notification is actually recorded. This suite drives
 * real turns through the real plugin and asserts that timestamp moves.
 *
 * These tests raise real notifications, which is the point: a mock cannot tell
 * "the API did not throw" from "the user saw something".
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'

import { Config, apply, inject, name } from '../lib/index.js'

const AUMID = 'DeepSeek.Harness.CompletionNotify'
const REG_KEY = `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`

/**
 * Read Windows' record of the newest notification for this AppUserModelId.
 *
 * Returned as the raw hex token: comparing strings avoids decoding FILETIME's
 * byte order, which is easy to get wrong and would make the test lie.
 *
 * @returns the raw `0x…` token, or '' when the key or value is absent.
 */
function notificationStamp() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'LastNotificationAddedTime'], { encoding: 'utf8' })
    return (out.match(/0x[0-9a-f]+/i) ?? [''])[0]
  } catch {
    return ''
  }
}

const SESSION = {
  id: 'session-delivery-check',
  header: { cwd: 'C:\\work\\proj' },
  events: [{ type: 'assistant/message', message: { content: [{ type: 'text', text: '搞定' }] } }],
}

/**
 * Whether this process has an interactive desktop session where a toast can be
 * shown.
 *
 * A service/CI session has no window station to display a toast on, and Windows
 * drops it silently while every API still reports success. `SESSIONNAME` is set
 * only for an interactive logon (e.g. `Console`, `RDP-Tcp#12`), which is exactly
 * the distinction needed — and unlike shelling out to `query session`, it needs
 * no tool on PATH.
 *
 * @returns whether an interactive session is present.
 */
function hasInteractiveDesktop() {
  return Boolean(process.env.SESSIONNAME)
}

/**
 * Drive one completed turn through the real plugin and report whether Windows
 * recorded a notification.
 *
 * @param config - plugin config overrides.
 * @returns whether the notification stamp advanced.
 */
async function runRealTurn(config = {}) {
  const agent = { id: SESSION.id, session: SESSION }

  const ctx = new Context()
  ctx.provide('agents', { roots: () => [agent] })
  ctx.provide('sessionTitle', { get: () => ({ title: '投递校验' }) })

  const fiber = ctx.plugin({ name, inject, apply, Config }, config)
  await fiber

  const before = notificationStamp()

  const loop = ctx.plugin({
    name: 'loop',
    apply(loopCtx) {
      createScope(loopCtx, agent)
      const carrier = scopeTarget(agent, agent)
      for (const status of ['running', 'idle']) {
        const args = [carrier, 'agent/status', { status, agent }]
        for (const callback of loopCtx.events.dispatch('emit', args)) callback(...args)
      }
    },
  })
  await loop

  // The shim runs as a short subprocess; give it time to be recorded.
  await new Promise((resolve) => setTimeout(resolve, 6_000))

  const after = notificationStamp()
  await fiber.dispose()

  return { before, after, delivered: Boolean(after) && after !== before }
}

test(
  'a completed turn actually records a Windows notification',
  { skip: process.platform !== 'win32' },
  async () => {
    const { before, after, delivered } = await runRealTurn({ debugLog: true })

    // A CI runner has no interactive desktop session, so Windows silently drops
    // toasts there while the API still reports success. Detect that case and skip
    // rather than fail: the honest check runs on a real desktop (see the README).
    if (!delivered && !hasInteractiveDesktop()) {
      console.log('skipping delivery assertion: no interactive desktop session (headless CI)')
      return
    }

    assert.ok(
      delivered,
      `Windows recorded no notification (stamp stayed ${before}). The shim may have exited 0 ` +
        'while nothing was displayed — check the spawn options in postNotification().',
    )
    assert.notEqual(after, before)
  },
)

test(
  'the plugin does not spawn PowerShell detached',
  { skip: process.platform !== 'win32' },
  async () => {
    // The measured root cause of the missing notification: a detached child has
    // no console/session association, so the WinRT toast is silently dropped.
    // Reading the source is deterministic where a timing-based check is not.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'),
    )

    // Strip comments so the explanatory prose about `detached` cannot trip this.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    assert.ok(
      !/\bdetached\s*:/.test(code),
      'postNotification() must not pass `detached` to spawn: it silently suppresses the toast',
    )
  },
)

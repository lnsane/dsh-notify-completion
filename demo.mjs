/**
 * End-to-end demonstration: load the plugin into a real Cordis context and let
 * it raise an actual Windows notification, exactly as a completed DSH turn
 * would.
 *
 * Run it to see the notification on screen:
 *
 *     node demo.mjs
 *
 * It differs from the test suite in one way: `powershellPath` is left at its
 * default, so the real shim runs and a real toast appears.
 */
import { setTimeout as delay } from 'node:timers/promises'

import { Context } from '@deepseek-ai/cordis'

import { Config, apply, inject, name } from './lib/index.js'

// A session shaped like a live one: a cwd, a title, and the assistant's answer.
const session = {
  id: 'session-demo-0001',
  header: { cwd: 'C:\\Users\\me\\Desktop\\easyCode' },
  events: [
    { type: 'turn/start', turn: 1 },
    {
      type: 'assistant/message',
      step: 1,
      turn: 1,
      message: {
        content: [
          { type: 'text', text: '插件已经写好，测试全部通过，我把改动提交到你的仓库了。' },
        ],
      },
    },
    { type: 'turn/end', turn: 1, reason: 'completed' },
  ],
}

const agent = { id: session.id, session }

const ctx = new Context()
ctx.provide('agents', { roots: () => [agent] })
ctx.provide('sessionTitle', { get: () => ({ title: '开发 DSH 通知插件' }) })

const pluginCtx = ctx.plugin({ name, inject, apply, Config }, { debugLog: true })
await pluginCtx
console.log('plugin active — emitting a completed turn…')

// One turn: running opens it, idle closes it and raises the notification.
ctx.emit('agent/status', { agent, status: 'running' })
await delay(2_000) // stand in for the model working
ctx.emit('agent/status', { agent, status: 'idle' })

// Give the detached shim time to post the toast before the process exits.
await delay(3_000)
await pluginCtx.dispose()
console.log('done — a Windows notification should have appeared.')

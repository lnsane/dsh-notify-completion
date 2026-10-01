/**
 * Tests for the pure logic: turn-completion rule, rendering, and payload.
 *
 * Run with `node --test test/` from the package root.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  compact,
  completionVariables,
  createCompletionDecider,
  encodePayload,
  formatDuration,
  lastAssistantText,
  render,
  truncate,
} from '../lib/render.js'

// ---------------------------------------------------------------------------
// render / compact / truncate / formatDuration
// ---------------------------------------------------------------------------

test('render substitutes known placeholders and keeps unknown ones verbatim', () => {
  const variables = { sessionTitle: '修复登录', cwd: 'C:\\work' }
  assert.equal(render('{{sessionTitle}} @ {{cwd}}', variables), '修复登录 @ C:\\work')
  // A typo must stay visible rather than silently blanking the user's template.
  assert.equal(render('{{nope}}', variables), '{{nope}}')
})

test('render treats an empty placeholder value as empty, not as unknown', () => {
  assert.equal(render('[{{cwd}}]', { cwd: '' }), '[]')
})

test('compact drops blank and whitespace-only lines', () => {
  assert.equal(compact('a\n\n   \nb\n'), 'a\nb')
})

test('compact trims each line so template indentation never reaches the toast', () => {
  assert.equal(compact('  a  \n  b  '), 'a\nb')
})

test('truncate marks omission only past the limit and honors a zero budget', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(truncate('abcdef', 0), '')
})

test('formatDuration scales from seconds to hours', () => {
  assert.equal(formatDuration(8_400), '8 秒')
  assert.equal(formatDuration(60_000), '1 分钟')
  assert.equal(formatDuration(125_000), '2 分 5 秒')
  assert.equal(formatDuration(3_780_000), '1 小时 3 分')
  assert.equal(formatDuration(Number.NaN), '—')
})

// ---------------------------------------------------------------------------
// lastAssistantText
// ---------------------------------------------------------------------------

test('lastAssistantText reads the LAST assistant message, ignoring later events', () => {
  const session = {
    events: [
      { type: 'assistant/message', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant/message', message: { content: [{ type: 'text', text: 'second' }] } },
      { type: 'turn/end', turn: 1, reason: 'completed' },
    ],
  }
  assert.equal(lastAssistantText(session), 'second')
})

test('lastAssistantText joins text blocks and skips non-text blocks', () => {
  const session = {
    events: [
      {
        type: 'assistant/message',
        message: {
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'hello' },
            { type: 'tool-call', name: 'read' },
            { type: 'text', text: 'world' },
          ],
        },
      },
    ],
  }
  assert.equal(lastAssistantText(session), 'hello world')
})

test('lastAssistantText collapses newlines so the toast body stays one line', () => {
  const session = {
    events: [{ type: 'assistant/message', message: { content: [{ type: 'text', text: 'a\n\nb   c' }] } }],
  }
  assert.equal(lastAssistantText(session), 'a b c')
})

test('lastAssistantText tolerates a missing session and a log with no assistant message', () => {
  assert.equal(lastAssistantText(undefined), '')
  assert.equal(lastAssistantText({ events: [] }), '')
  assert.equal(lastAssistantText({ events: [{ type: 'turn/end' }] }), '')
  assert.equal(lastAssistantText({}), '')
})

// ---------------------------------------------------------------------------
// completionVariables
// ---------------------------------------------------------------------------

test('completionVariables derives cwdName from a trailing-separator path', () => {
  const variables = completionVariables({
    appName: 'DSH',
    session: { id: 's1', header: { cwd: 'C:\\Users\\me\\easyCode\\' }, events: [] },
    sessionTitle: '开发插件',
    durationMs: 2_000,
    lastTextChars: 120,
  })
  assert.equal(variables.cwdName, 'easyCode')
  assert.equal(variables.sessionTitle, '开发插件')
  assert.equal(variables.duration, '2 秒')
})

test('completionVariables falls back to the directory name, then to a placeholder title', () => {
  const withCwd = completionVariables({
    appName: 'DSH',
    session: { id: 's1', header: { cwd: 'C:\\work\\proj' }, events: [] },
    sessionTitle: '',
    durationMs: 1_000,
    lastTextChars: 120,
  })
  assert.equal(withCwd.sessionTitle, 'proj')

  const bare = completionVariables({
    appName: 'DSH',
    session: { id: 's2', header: {}, events: [] },
    sessionTitle: '',
    durationMs: 1_000,
    lastTextChars: 120,
  })
  assert.equal(bare.sessionTitle, '(未命名会话)')
})

test('completionVariables uses the explicit sessionId when no session object exists', () => {
  const variables = completionVariables({
    appName: 'DSH',
    session: undefined,
    sessionTitle: '',
    sessionId: 'agent-42',
    durationMs: undefined,
    lastTextChars: 120,
  })
  assert.equal(variables.sessionId, 'agent-42')
  assert.equal(variables.duration, '—')
  assert.equal(variables.cwd, '')
})

// ---------------------------------------------------------------------------
// encodePayload
// ---------------------------------------------------------------------------

test('encodePayload round-trips non-Latin text and quotes intact', () => {
  const payload = { title: '对话“完成”', message: '第一行\n第二行', silent: false }
  const decoded = JSON.parse(Buffer.from(encodePayload(payload), 'base64').toString('utf8'))
  assert.deepEqual(decoded, payload)
})

test('encodePayload emits ASCII only, so no shell metacharacter can survive it', () => {
  const encoded = encodePayload({ title: 'a"b& c | d > e', message: '\n\t' })
  // eslint-disable-next-line no-control-regex
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/)
})

// ---------------------------------------------------------------------------
// createCompletionDecider — the turn-completion rule
// ---------------------------------------------------------------------------

/** Build a decider over a fake clock and a root predicate. */
function makeDecider({ includeSubagents = false, throttleMs = 0, roots = () => true, clock } = {}) {
  let current = 0
  const now = clock ? clock : () => current
  const decider = createCompletionDecider({
    includeSubagents,
    throttleMs,
    isRoot: roots,
    now,
  })
  return {
    decider,
    advance(ms) {
      current += ms
    },
  }
}

test('a running → idle edge notifies once and reports the turn duration', () => {
  const { decider, advance } = makeDecider()
  const agent = { id: 'a' }

  assert.equal(decider.note(agent, 'running'), null)
  advance(4_000)
  assert.deepEqual(decider.note(agent, 'idle'), { durationMs: 4_000 })
})

test('repeated idle with no intervening running does NOT notify again', () => {
  const { decider } = makeDecider()
  const agent = { id: 'a' }

  decider.note(agent, 'running')
  assert.ok(decider.note(agent, 'idle'))
  // The loop may re-emit idle; that is not a new completed turn.
  assert.equal(decider.note(agent, 'idle'), null)
  assert.equal(decider.note(agent, 'idle'), null)
})

test('an agent that never ran never notifies', () => {
  const { decider } = makeDecider()
  assert.equal(decider.note({ id: 'a' }, 'idle'), null)
})

test('a second turn notifies again after the throttle window', () => {
  const { decider, advance } = makeDecider({ throttleMs: 1_000 })
  const agent = { id: 'a' }

  decider.note(agent, 'running')
  assert.ok(decider.note(agent, 'idle'))

  advance(2_000)
  decider.note(agent, 'running')
  advance(500)
  assert.deepEqual(decider.note(agent, 'idle'), { durationMs: 500 })
})

test('the throttle suppresses a turn that finishes too soon, and does not bank it', () => {
  const { decider, advance } = makeDecider({ throttleMs: 1_000 })
  const agent = { id: 'a' }

  decider.note(agent, 'running')
  assert.ok(decider.note(agent, 'idle'))

  // Second turn finishes 200 ms later: suppressed.
  advance(200)
  decider.note(agent, 'running')
  decider.note(agent, 'idle')
  assert.equal(decider.note(agent, 'idle'), null, 'a suppressed turn must not be reported')
})

test('subagent turns are silent unless includeSubagents is set', () => {
  const isRoot = (agent) => agent.id === 'root'
  const excluded = makeDecider({ roots: isRoot })
  const included = makeDecider({ roots: isRoot, includeSubagents: true })

  const child = { id: 'child' }
  excluded.decider.note(child, 'running')
  assert.equal(excluded.decider.note(child, 'idle'), null)

  included.decider.note(child, 'running')
  assert.ok(included.decider.note(child, 'idle'))
})

test('each agent keeps its own status and turn clock', () => {
  const { decider, advance } = makeDecider()
  const a = { id: 'a' }
  const b = { id: 'b' }

  decider.note(a, 'running')
  advance(1_000)
  decider.note(b, 'running')
  advance(2_000)

  // b completes first, and its duration is measured from b's own start.
  assert.deepEqual(decider.note(b, 'idle'), { durationMs: 2_000 })
  assert.deepEqual(decider.note(a, 'idle'), { durationMs: 3_000 })
})

test('an idle agent going straight back to running starts a fresh duration', () => {
  const { decider, advance } = makeDecider()
  const agent = { id: 'a' }

  decider.note(agent, 'running')
  advance(5_000)
  assert.ok(decider.note(agent, 'idle'))

  advance(1_000)
  decider.note(agent, 'running')
  advance(7_000)
  assert.deepEqual(decider.note(agent, 'idle'), { durationMs: 7_000 })
})

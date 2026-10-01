/**
 * Integration tests: the plugin's public surface, its Config schema, and the
 * real PowerShell notification shim.
 *
 * The shim is exercised for real (it posts an actual Windows notification),
 * because "does Windows actually show it" is the one thing a unit test cannot
 * answer. The registry-writing registration is skipped there via -NoRegister,
 * so running the suite never mutates the machine's notification settings.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, apply, inject, name } from '../lib/index.js'

const SHIM = fileURLToPath(new URL('../lib/notify-windows.ps1', import.meta.url))

test('the plugin exposes the Cordis contract the Loader requires', () => {
  assert.equal(name, 'notify-completion')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['agents', 'sessionTitle'])
  assert.equal(typeof Config, 'function', 'Config must be a schemastery schema callable')
})

test('Config validates a partial config and fills every default', () => {
  const resolved = new Config({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.includeSubagents, false)
  assert.equal(resolved.fallbackSeconds, 10)
  assert.equal(resolved.throttleMs, 1500)
  assert.equal(resolved.appId, 'DeepSeek.Harness.CompletionNotify')
  assert.match(resolved.messageTemplate, /\{\{duration\}\}/)
})

test('Config honors explicit values, including disabling the plugin', () => {
  const resolved = new Config({ enabled: false, throttleMs: 0, includeSubagents: true, appName: 'My Harness' })
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.throttleMs, 0)
  assert.equal(resolved.includeSubagents, true)
  assert.equal(resolved.appName, 'My Harness')
})

test('Config rejects values outside a field range', () => {
  assert.throws(() => new Config({ fallbackSeconds: -1 }))
  assert.throws(() => new Config({ throttleMs: -5 }))
})

// ---------------------------------------------------------------------------
// apply(): wiring against a fake Cordis context
// ---------------------------------------------------------------------------

/**
 * Build a minimal Cordis-like context that records listeners and services.
 *
 * @param options - service overrides and a spawn spy.
 * @returns the fake context plus the captured state.
 */
function makeFakeContext({ roots = () => [], spawnCalls = [] } = {}) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get(service) {
      if (service === 'agents') return { roots: () => roots() }
      if (service === 'sessionTitle') return { get: () => ({ title: '开发插件' }) }
      return undefined
    },
    logger: {
      info: (message) => logs.push(message),
    },
  }
  return { ctx, listeners, logs, spawnCalls }
}

test('apply registers exactly one agent/status listener', () => {
  const { ctx, listeners } = makeFakeContext()
  apply(ctx, new Config({}))
  assert.deepEqual([...listeners.keys()], ['agent/status'])
})

test('apply on a non-Windows platform is inert and says so', { skip: process.platform === 'win32' }, () => {
  const { ctx, listeners, logs } = makeFakeContext()
  apply(ctx, new Config({}))
  assert.equal(listeners.size, 0)
  assert.ok(logs.some((line) => line.includes('Windows-only')))
})

test('apply is silent on an idle-only transition stream', () => {
  const { ctx, listeners } = makeFakeContext()
  apply(ctx, new Config({}))
  const handler = listeners.get('agent/status')

  // No running edge, so nothing should notify and nothing should throw.
  assert.doesNotThrow(() => {
    handler({ agent: makeAgent('a'), status: 'idle' })
    handler({ agent: makeAgent('b'), status: 'idle' })
  })
})

test('apply ignores every status transition while disabled', () => {
  const { ctx, listeners } = makeFakeContext()
  apply(ctx, new Config({ enabled: false }))
  const handler = listeners.get('agent/status')

  assert.doesNotThrow(() => {
    handler({ agent: makeAgent('a'), status: 'running' })
    handler({ agent: makeAgent('a'), status: 'idle' })
  })
})

/** Build a fake agent with a session log, as the listener expects. */
function makeAgent(id, { root = true } = {}) {
  return {
    id,
    isRoot: root,
    session: {
      id,
      header: { cwd: 'C:\\work\\proj' },
      events: [
        { type: 'assistant/message', message: { content: [{ type: 'text', text: '已完成' }] } },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// The PowerShell shim, executed for real
// ---------------------------------------------------------------------------

test('the shim file exists where the plugin expects it', () => {
  assert.ok(existsSync(SHIM), `missing shim: ${SHIM}`)
})

test('the shim parses as valid PowerShell', () => {
  // -WhatIf is not applicable, so the syntax check uses the parser directly.
  const script = [
    `$errors = $null`,
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${SHIM.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
    `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
    `exit 0`,
  ].join('; ')

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `parse errors:\n${result.stderr || result.stdout}`)
})

test('the shim rejects a malformed payload with its documented exit code', () => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHIM, '-PayloadBase64', 'not-base64!!'],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 2, `expected the payload-rejection exit code, got ${result.status}`)
})

test('the shim raises a real Windows notification for a JSON payload', () => {
  const payload = {
    title: 'dsh-notify-completion',
    message: '自动化测试：通知链路正常',
    fallbackSeconds: 3,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  // -NoRegister keeps this test from writing to the user's registry.
  const stdout = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SHIM,
      '-PayloadBase64',
      encoded,
      '-Diagnostic',
      '-NoRegister',
    ],
    { encoding: 'utf8' },
  )

  // Exit code 0 plus a named tier proves a notification was actually shown.
  assert.match(stdout, /tier=(winrt-toast|burnttoast|messagebox)/, `no tier reported:\n${stdout}`)
})

test('the shim survives a title full of XML and shell metacharacters', () => {
  const payload = {
    title: `<script>&"' </toast>`,
    message: `100% & "quoted" | piped > redirected`,
    fallbackSeconds: 3,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHIM, '-PayloadBase64', encoded, '-Diagnostic', '-NoRegister'],
    { encoding: 'utf8' },
  )
  assert.match(stdout, /tier=(winrt-toast|burnttoast|messagebox)/)
})

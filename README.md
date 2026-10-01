# dsh-notify-completion

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that raises a **Windows system notification when an agent finishes a turn**. Run a long task, switch to another window, and Windows tells you the answer landed instead of leaving you to poll the tab.

## What it does

One behavior, and nothing else: when a top-level agent's status goes `running → idle` — the exact moment a turn completes — the plugin posts a Windows toast:

```
┌──────────────────────────────────────────┐
│ DeepSeek Harness                         │
│ DSH 对话完成                              │
│ 开发插件                                   │
│ C:\Users\me\easyCode                     │
│ 用时 2 分 5 秒                             │
└──────────────────────────────────────────┘
```

It adds no tool, never touches the model's context, and never vetoes or rewrites anything. It is a pure observer of an event the host already emits.

## Requirements

- **Windows 10/11.** The plugin is Windows-only by construction; on other platforms it loads, logs that it is inactive, and does nothing.
- **DeepSeek Harness** with a Host that loads Cordis plugins (`@deepseek-ai/dsh-base` ≥ 0.2.0).
- **PowerShell.** Windows PowerShell 5.1 — present on every supported Windows version — is enough. PowerShell 7 is used automatically when it is installed.

No extra PowerShell module is required: the toast is posted through the Windows Runtime API directly. If that path is unavailable the plugin falls back to the [BurntToast](https://github.com/Windos/BurntToast) module when installed, then to a self-closing message box.

## Install

The plugin ships as a DSH **bundle**: a package whose `cordis.patch.yml` inserts its plugin row into the profile. Installing the package and registering the bundle are therefore one step — DSH's own plugin manager does both.

### The supported way

```powershell
dsh plugin --profile desktop add git+https://github.com/lnsane/dsh-notify-completion.git
```

This adds the dependency to `$DSH_PROFILE_DIR\package.json` **and** appends `dsh-notify-completion` to its `dsh.profile.bundles` list. Restart DSH and the plugin is live.

Swap `desktop` for whichever profile you run (`dsh plugin --profile web add …`, and so on).

> **Use `git+https://…`, not the `github:owner/repo` shorthand.** DSH installs with pnpm, which happily resolves the shorthand over HTTPS — but if you ever install the package with plain `npm`, the `github:` shorthand resolves to **SSH** (`git+ssh://git@github.com/…`) and fails on a machine without a GitHub SSH key. The explicit `git+https://` URL works under both package managers.

### By hand

If you would rather not use the plugin manager, install the package into the profile and register the bundle yourself:

```powershell
cd $env:DSH_PROFILE_DIR          # e.g. C:\Users\<you>\.dsh\profiles\desktop
pnpm add git+https://github.com/lnsane/dsh-notify-completion.git
```

Then add the bundle name to `$env:DSH_PROFILE_DIR\package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-notify-completion"
      ]
    }
  }
}
```

Restart DSH. The row is inserted automatically; no `cordis.patch.yml` edit is required.

### Verifying the installation

```powershell
dsh plugin --profile desktop list
```

That lists the profile's installed plugin packages:

```
dsh-profile-desktop C:\Users\<you>\.dsh\profiles\desktop (PRIVATE)
│
│   dependencies:
└── dsh-notify-completion@0.1.0
```

The plugin's Loader row is named `notify-completion`. For a non-Electron profile you can also inspect the composed tree directly:

```powershell
dsh --profile web --dump-config     # look for "- id: notify-completion"
```

> The `desktop` profile is owned exclusively by the Electron app, so `dsh --profile desktop` refuses to boot or dump it outside Electron. `dsh plugin --profile desktop …` and the running app itself are the ways in.

If you would rather not restart, add the row by hand to `$env:DSH_PROFILE_DIR\cordis.patch.yml` instead:

```yaml
- insert:
    - id: notify-completion
      name: 'dsh-notify-completion'
```

### Confirming Windows can show the toast

The plugin registers its AppUserModelId under `HKCU` on first use (per-user, no elevation). To check the notification path on its own, without DSH:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File lib\notify-windows.ps1 `
  -Title "dsh-notify-completion" -Message "Notification shim self-test" `
  -Diagnostic -FallbackSeconds 5
```

It prints the tier that delivered (`tier=winrt-toast`, `tier=burnttoast`, or `tier=messagebox`) and exits 0. A `tier=none` with exit code 1 means every path failed.

## Config

Set these under the `notify-completion` row. A patch replaces a row's whole `config`, so restate every key you want to keep:

```yaml
- id: notify-completion
  name: 'dsh-notify-completion'
  config:
    enabled: true
    appId: DeepSeek.Harness.CompletionNotify
    appName: DeepSeek Harness
    titleTemplate: DSH 对话完成
    messageTemplate: |-
      {{sessionTitle}}
      {{cwd}}
      用时 {{duration}}
    includeSubagents: false
    silent: false
    fallbackSeconds: 10
    lastTextChars: 120
    throttleMs: 1500
    powershellPath: ''
    debugLog: false
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` leaves the plugin loaded but inert. |
| `appId` | `DeepSeek.Harness.CompletionNotify` | AppUserModelId the toast is posted under; registered under `HKCU` on use. |
| `appName` | `DeepSeek Harness` | Name Windows shows as the notification's source. |
| `titleTemplate` | `DSH 对话完成` | Toast headline. Placeholders below. |
| `messageTemplate` | see above | Toast body. Placeholders below. |
| `includeSubagents` | `false` | Also notify when a subagent finishes. Off notifies only top-level turns. |
| `silent` | `false` | Post the toast without its default sound. |
| `fallbackSeconds` | `10` | Seconds before the message-box fallback closes itself; `0` waits forever. |
| `lastTextChars` | `120` | Character cap for `{{lastText}}`. `0` removes the placeholder's text. |
| `throttleMs` | `1500` | Minimum gap between notifications. Turns finishing closer together are suppressed. `0` notifies on every turn. |
| `powershellPath` | `''` | PowerShell executable. Empty auto-detects PowerShell 7, else `powershell.exe`. |
| `debugLog` | `false` | Report each turn and the shim's exit code to the host log. |

### Placeholders

| Placeholder | Expands to |
| --- | --- |
| `{{appName}}` | The configured `appName`. |
| `{{sessionTitle}}` | The session's folded title; falls back to the directory name, then to `(未命名会话)`. |
| `{{sessionId}}` | The session id. |
| `{{cwd}}` | The session's full working directory. |
| `{{cwdName}}` | Just the last path segment of `{{cwd}}`. |
| `{{duration}}` | How long the turn took, e.g. `8 秒`, `2 分 5 秒`, `1 小时 3 分`. |
| `{{lastText}}` | The last assistant message's text, whitespace-collapsed and capped by `lastTextChars`. |

A **unknown** placeholder is left verbatim rather than blanked, so a typo stays visible in the toast instead of silently vanishing. Lines that render empty are dropped, so an unset `{{cwd}}` never leaves a blank row.

Examples:

```yaml
# Minimal — just the answer is ready.
titleTemplate: DSH 对话完成
messageTemplate: '{{sessionTitle}}'

# Name the answer's opening words.
messageTemplate: |-
  {{sessionTitle}}
  {{lastText}}
```

## How it decides to notify

The rule is deliberately narrow, because a notification that fires at the wrong time is worse than none:

- **A real `running → idle` edge notifies.** `idle` repeated with no intervening `running` — which the loop may re-emit — notifies once. An agent that never ran never notifies.
- **Subagents are silent by default.** `agents.roots()` reports exactly the agents nobody owns, which is the same distinction the host uses to tell a session from its subagents. Set `includeSubagents: true` to hear about them too.
- **The turn clock is per agent.** Each agent's `{{duration}}` is measured from its own `running` edge, so concurrent sessions never contaminate each other.
- **A burst is throttled.** Several turns finishing within `throttleMs` produce one notification. A suppressed turn is not banked: it does not fire late.
- **PowerShell never blocks the host.** The shim is spawned detached with `stdio: 'ignore'` and unref'd, so a pending toast cannot stall a turn or keep the host alive.

## Design notes

**Why a PowerShell shim rather than a Node module.** Posting a Windows toast needs the WinRT projection, which Node does not expose. A short PowerShell process is the one delivery route that needs no native build step and no extra module install, so the plugin stays a plain copy-in package.

**Why the payload is base64.** The shim receives `-PayloadBase64`, never a raw string. A session title containing quotes, newlines, or non-Latin text would otherwise be at the mercy of command-line quoting; base64 makes the transport ASCII-only by construction, and the shim decodes it as UTF-8.

**Why three tiers.** The WinRT toast is the real thing but depends on a registered AppUserModelId and an available WinRT projection; BurntToast is a common but optional install; the message box always works. The fallback chain means a notification still appears on a machine where the nicer paths are unavailable, and `-Diagnostic` always reports which one ran.

**Escaping is not hand-rolled.** Toast XML goes through `[System.Security.SecurityElement]::Escape`, which is the exact inverse of the entity forms the toast schema accepts, so a title like `<script>&"` cannot break the XML it is embedded in. A test covers this.

## Development

```powershell
npm install
npm test               # 42 tests: pure logic, the shim, and a real Cordis runtime
node demo.mjs          # load the plugin and raise one real Windows notification
npm run test:notify    # exercise the notification shim alone
```

`demo.mjs` is the end-to-end check: it builds a Cordis context with the two services the plugin injects, emits a `running → idle` turn, and leaves `powershellPath` at its default so the real shim runs and a real toast appears.

The suite covers three layers:

- **`test/render.test.js`** — the turn-completion rule, template rendering, duration formatting, and payload encoding, all against a fake clock.
- **`test/integration.test.js`** — the plugin's public contract (`name` / `inject` / `apply` / `Config`), plus the real `notify-windows.ps1`: it parses as valid PowerShell, rejects a malformed payload with its documented exit code, actually delivers a notification, and survives a title full of XML and shell metacharacters.
- **`test/runtime.test.js`** — the plugin loaded into a real `@deepseek-ai/cordis` context, with events emitted through it. Delivery is observed by pointing `powershellPath` at an executable that cannot exist: the resulting `ENOENT` carries the exact argv, so both "did it notify" and "what did it send" are assertable without raising a toast on every test run.

The shim tests run with `-NoRegister`, so the suite never writes to your registry.

## Known limitations

- **Windows only.** There is no macOS or Linux backend; the plugin is inert elsewhere.
- **Focus is not checked.** A notification fires even when the DSH window is already in front. Suppressing it while focused would need the host's window state, which this plugin deliberately does not reach into; use `throttleMs` or `enabled` if that bothers you.
- **A toast is not clickable-through to the session.** `activationType="protocol"` is set, but no protocol handler is registered, so clicking the toast only dismisses it.
- **`{{lastText}}` reads the last assistant message, not the turn's whole output.** In a turn that ends with tool calls, the preview reflects the last assistant message's text blocks.
- **Notifications are not replayed.** A turn that completes while the host is shutting down may not notify.

## License

[MIT](LICENSE)

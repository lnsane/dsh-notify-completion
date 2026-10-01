# dsh-notify-completion

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：**每当 agent（智能体）跑完一轮回答，就在 Windows 上弹出系统通知**。让它跑长任务，你切去别的窗口干活，任务完成时 Windows 会告诉你结果已经出来了，不用一直盯着页面。

## 它做什么

只做一件事：当顶层 agent 的状态从 `running` 变为 `idle`——也就是一轮回答刚刚结束的那一刻——插件弹出一条 Windows Toast 通知：

```
┌──────────────────────────────────────────┐
│ DeepSeek Harness                         │
│ DSH 对话完成                              │
│ 开发插件                                   │
│ C:\Users\me\easyCode                     │
│ 用时 2 分 5 秒                             │
└──────────────────────────────────────────┘
```

它不注册任何工具，不碰模型的上下文，也不否决或改写任何调用——只是安静地观察宿主本来就会发出的事件。

## 环境要求

- **Windows 10/11。** 插件在设计上就是 Windows 专用的；在其它平台它会正常加载、记录一条「未激活」日志，然后什么都不做。
- **DeepSeek Harness**，且宿主能加载 Cordis 插件（`@deepseek-ai/dsh-base` ≥ 0.2.0）。
- **PowerShell。** Windows PowerShell 5.1 就够——每个受支持的 Windows 版本都自带。若装了 PowerShell 7，会自动优先使用。

不需要额外安装任何 PowerShell 模块：通知直接走 Windows Runtime API。若该路径不可用，会依次回退到 [BurntToast](https://github.com/Windos/BurntToast) 模块（若已安装），再回退到一个会自己关闭的消息框。

## 安装

插件以 DSH **bundle** 的形式分发：包内的 `cordis.patch.yml` 会把插件行插入 profile。因此「装包」和「注册 bundle」其实是同一步——用 DSH 自带的插件管理器一次完成。

### 推荐方式

```powershell
dsh plugin --profile desktop add git+https://github.com/lnsane/dsh-notify-completion.git
```

这条命令会把依赖写进 `$DSH_PROFILE_DIR\package.json`，**并**把 `dsh-notify-completion` 追加到其中的 `dsh.profile.bundles` 列表。重启 DSH 即生效。

把 `desktop` 换成你实际使用的 profile 即可（例如 `dsh plugin --profile web add …`）。

> **请用 `git+https://…`，不要用 `github:owner/repo` 简写。** DSH 底层用 pnpm 安装，pnpm 能把该简写正常解析成 HTTPS；但如果你哪天改用普通的 `npm` 安装，`github:` 简写会被解析成 **SSH**（`git+ssh://git@github.com/…`），在没有配置 GitHub SSH key 的机器上会直接失败。显式写 `git+https://` 则两种包管理器都能用。

### 手动安装

不想用插件管理器的话，把包装进 profile 并自行注册 bundle：

```powershell
cd $env:DSH_PROFILE_DIR          # 例如 C:\Users\<你>\.dsh\profiles\desktop
pnpm add git+https://github.com/lnsane/dsh-notify-completion.git
```

然后把 bundle 名加进 `$env:DSH_PROFILE_DIR\package.json`：

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

重启 DSH 即可。插件行会自动插入，**不需要**手改 `cordis.patch.yml`。

### 验证是否装上

```powershell
dsh plugin --profile desktop list
```

它会列出该 profile 已安装的插件包：

```
dsh-profile-desktop C:\Users\<你>\.dsh\profiles\desktop (PRIVATE)
│
│   dependencies:
└── dsh-notify-completion@0.1.0
```

插件的 Loader 条目名为 `notify-completion`。如果用的是非 Electron 管理的 profile，还可以直接查看组装后的插件树：

```powershell
dsh --profile web --dump-config     # 找 "- id: notify-completion" 这一行
```

> `desktop` profile 由 Electron 应用独占管理，所以在 Electron 之外 `dsh --profile desktop` 会拒绝启动或 dump 它。要用 `dsh plugin --profile desktop …`，或者直接在运行中的应用里看。

如果不想重启，也可以直接手动往 `$env:DSH_PROFILE_DIR\cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: notify-completion
      name: 'dsh-notify-completion'
```

### 单独确认 Windows 能弹出通知

插件首次使用时会把自己的 AppUserModelId 注册到 `HKCU`（仅当前用户，无需管理员权限）。想绕开 DSH 单独验证通知链路：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File lib\notify-windows.ps1 `
  -Title "dsh-notify-completion" -Message "通知链路自检" `
  -Diagnostic -FallbackSeconds 5
```

它会打印实际生效的通道（`tier=winrt-toast`、`tier=burnttoast` 或 `tier=messagebox`）并以 0 退出。若打印 `tier=none` 且退出码为 1，说明所有通道都失败了。

## 配置

在 `notify-completion` 这一行下配置。注意：patch 会**整体替换**该行的 `config`，所以要把想保留的键全部写出来：

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

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时插件仍加载但不动作。 |
| `appId` | `DeepSeek.Harness.CompletionNotify` | 通知所用的 AppUserModelId，使用时注册到 `HKCU`。 |
| `appName` | `DeepSeek Harness` | Windows 显示的通知来源名称。 |
| `titleTemplate` | `DSH 对话完成` | 通知标题。支持下方占位符。 |
| `messageTemplate` | 见上方 | 通知正文。支持下方占位符。 |
| `includeSubagents` | `false` | 子代理跑完是否也通知。默认只通知顶层会话。 |
| `silent` | `false` | 静音弹出，不播放默认提示音。 |
| `fallbackSeconds` | `10` | 回退消息框自动关闭的秒数；`0` 表示一直等待。 |
| `lastTextChars` | `120` | `{{lastText}}` 的字符上限。`0` 表示该占位符输出空。 |
| `throttleMs` | `1500` | 两条通知之间的最小间隔，毫秒。间隔内完成的轮次会被抑制。`0` 表示每轮都通知。 |
| `powershellPath` | `''` | PowerShell 可执行文件。留空则自动探测 PowerShell 7，否则用 `powershell.exe`。 |
| `debugLog` | `false` | 把每轮完成情况和 shim 的退出码写进宿主日志。 |

### 占位符

| 占位符 | 展开为 |
| --- | --- |
| `{{appName}}` | 配置的 `appName`。 |
| `{{sessionTitle}}` | 会话标题；取不到时退化为目录名，再退化为 `(未命名会话)`。 |
| `{{sessionId}}` | 会话 id。 |
| `{{cwd}}` | 会话的完整工作目录。 |
| `{{cwdName}}` | `{{cwd}}` 的最后一段路径。 |
| `{{duration}}` | 本轮耗时，例如 `8 秒`、`2 分 5 秒`、`1 小时 3 分`。 |
| `{{lastText}}` | 最后一条助手消息的文本，已折叠空白并按 `lastTextChars` 截断。 |

**未知**占位符会原样保留而不是清空——这样模板里的笔误会直接显示在通知上，而不是悄悄消失。渲染后为空的行会被丢弃，所以 `{{cwd}}` 取不到值时不会留下空行。

示例：

```yaml
# 极简：只告诉你「答案好了」
titleTemplate: DSH 对话完成
messageTemplate: '{{sessionTitle}}'

# 顺带带上回答的开头
messageTemplate: |-
  {{sessionTitle}}
  {{lastText}}
```

## 通知的判定规则

规则刻意收得很窄——在不该打扰的时候弹通知，比不弹更糟：

- **只有真实的 `running → idle` 边沿才通知。** 中间没有 `running` 的重复 `idle`（循环可能重发）只通知一次；从没跑过的 agent 不会通知。
- **子代理默认静默。** `agents.roots()` 给出的正是「无人拥有」的 agent，与宿主区分会话和子代理用的是同一判据。想要子代理也提醒，把 `includeSubagents` 设为 `true`。
- **计时按 agent 隔离。** 每个 agent 的 `{{duration}}` 都从它自己的 `running` 边沿算起，多个会话并发也不会互相污染。
- **突发会被节流。** 在 `throttleMs` 内完成的多个轮次只弹一条通知；被抑制的轮次不会被"补发"。
- **绝不阻塞宿主。** shim 以 detached + `stdio: 'ignore'` 启动并 `unref()`，所以待发的通知既不会拖慢一轮回答，也不会让宿主进程无法退出。

## 设计说明

**为什么用 PowerShell 脚本而不是 Node 模块。** 弹 Windows Toast 需要 WinRT 投影，而 Node 并不暴露它。一段短小的 PowerShell 进程是唯一既不需要原生编译、又不需要额外安装模块的投递方式，因此这个插件能保持"拷进去就能用"的形态。

**为什么载荷用 base64。** shim 收到的是 `-PayloadBase64`，而不是原始字符串。会话标题里若含引号、换行或非拉丁文字，否则就得听凭命令行转义规则的摆布；base64 让传输内容在构造上就是纯 ASCII，由 shim 再按 UTF-8 解码还原。

**为什么有三级回退。** WinRT Toast 是正牌方案，但依赖已注册的 AppUserModelId 和可用的 WinRT 投影；BurntToast 常见但属于可选安装；消息框则始终可用。三级链让那些"更好"的通道不可用的机器也照样能看到通知，而 `-Diagnostic` 永远会告诉你实际走的是哪一级。

**转义没有手写。** Toast XML 文本统一走 `[System.Security.SecurityElement]::Escape`——它正是 Toast schema 所接受实体形式的精确逆运算，所以像 `<script>&"` 这样的标题无法破坏它所嵌入的 XML。已有测试覆盖这一点。

## 开发

```powershell
npm install
npm test               # 42 项测试：纯逻辑、通知脚本，以及真实的 Cordis 运行时
node demo.mjs          # 装载插件并真实弹出一条 Windows 通知
npm run test:notify    # 只验证通知脚本
```

`demo.mjs` 是端到端检查：它搭一个 Cordis 上下文并提供插件注入的两个服务，发出一次 `running → idle` 轮次，且把 `powershellPath` 留作默认值，因此会走真实的 shim、弹出真实的通知。

测试分三层：

- **`test/render.test.js`** —— 轮次完成判定规则、模板渲染、耗时格式化、载荷编码，全部基于假时钟。
- **`test/integration.test.js`** —— 插件的公开契约（`name` / `inject` / `apply` / `Config`），以及真实的 `notify-windows.ps1`：它能通过 PowerShell 语法解析、用约定的退出码拒绝畸形载荷、真的弹出一条通知，并且能扛住塞满 XML 与 shell 元字符的标题。
- **`test/runtime.test.js`** —— 把插件装进真实的 `@deepseek-ai/cordis` 上下文并向它发事件。投递结果的观测方式是：把 `powershellPath` 指向一个必然不存在的可执行文件，于是产生的 `ENOENT` 会带上完整的 argv——这样"有没有通知"和"发了什么"都可断言，同时不必让每次跑测试都真的弹窗。

通知脚本相关测试都以 `-NoRegister` 运行，因此测试套件**不会**改动你机器上的注册表。

## 已知限制

- **仅 Windows。** 没有 macOS / Linux 后端；在其它平台插件不动作。
- **不检查窗口焦点。** 即使 DSH 窗口就在前台，通知照样会弹。要做到"前台时静默"需要读取宿主窗口状态，而本插件刻意不伸手去碰这些；嫌吵可以调 `throttleMs` 或用 `enabled` 关掉。
- **点击通知不会跳回会话。** 虽然设了 `activationType="protocol"`，但没有注册协议处理器，所以点击只是关掉通知。
- **`{{lastText}}` 取的是最后一条助手消息，而不是整轮输出的全文。** 对于以工具调用收尾的一轮，预览反映的是最后那条助手消息的文本块。
- **通知不会补发。** 若某一轮在宿主关闭过程中完成，可能不会通知。

## 许可

[MIT](LICENSE)

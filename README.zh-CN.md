# dsh-native-browser

<p align="center">
  <img src="https://raw.githubusercontent.com/longmiaoo/dsh-native-browser/main/assets/icon-180.png" width="140" alt="dsh-native-browser 图标" />
</p>

> 为 DeepSeek Harness 打造流畅、连贯的原生 Chrome 操作体验。

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](#开始试用) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · 简体中文 · [开始试用](#开始试用) · [参与共建](#参与共建) · [反馈体验](https://github.com/longmiaoo/dsh-native-browser/issues/new)

让 DSH 在你日常使用的 Chrome 中办事：沿用已有标签页、登录状态和扩展，通过自然语言读取页面、填写表单、完成连续操作，并在需要时交还控制。

**我们以 Codex 的浏览器操作体验为标杆：让熟悉 Codex 的用户来到 DSH，也能获得自然、连贯的浏览器协作体验。** 首个正式版本将支持范围限定为 macOS + Chrome，并持续打磨真实任务中的流畅度。

我们希望把操作做得足够顺，让你愿意把越来越多的浏览器任务交给 AI。欢迎带着一个真实任务来试用，也欢迎一起解决其中每一次停顿、误解和不顺手。

## 体验重点

| 你关心的体验 | 项目围绕它做的工作 |
|---|---|
| 直接使用熟悉的浏览器 | 接入现有 Chrome 标签页，复用已有登录状态和扩展。 |
| 操作之间保持连贯 | 保持浏览器连接，使用语义观察、局部读取和增量结果；支持有界批量动作。 |
| 看得见 AI 在做什么 | 在真实页面操作，提供点击和滚动的虚拟指针反馈。 |
| 需要时能接手 | 使用扩展中的 Stop 或明确的 handoff 释放控制；切换 DSH 会话也会撤销原会话的控制。 |
| 遇到异常能判断下一步 | 检查目标是否可操作，区分已确认结果与结果未知，避免盲目重复动作。 |

这里的“原生”指对 DSH 会话、工具和审批机制的集成，以及对现有 Chrome 的直接控制。插件为 DSH 使用；Codex 是体验参考。

## 可以从这些任务开始

安装并授权相应网站后，把下面的指令发给 DSH：

```text
读取我指定的文档页面，整理关键步骤和需要注意的事项，完成后释放浏览器控制。
```

```text
在这个测试表单里填写我提供的资料，逐项核对，提交前停下来交给我。
```

```text
读取我指定的资料页面，整理一份比较表；保留相关页面，完成后交还控制。
```

任务效果取决于页面、模型和权限配置。首次试用可先完成下面的公开页面读取，再逐步尝试你熟悉的网站。

## 开始试用

正式版 `0.1.0` 的支持范围是 **macOS + Google Chrome**。需要 Node.js ≥ 22.19、pnpm 11，以及已能正常对话的 DSH。宿主声明为 `>=0.1.5-rc.1 <0.3.0`；已验证的宿主组件版本为 `0.1.5-rc.1` 和 `0.2.1-rc.3`。Chrome 最低清单版本为 125，验收使用的版本见[发布验收记录](docs/releases/0.1.0-acceptance.zh-CN.md)。Edge、Windows 和 Linux 的完整安装体验仍属实验范围。

### 1 一条命令配置本机组件

在终端粘贴这一整行：

```bash
dsh plugin --profile web add dsh-native-browser@0.1.0 && dsh plugin --profile web exec dsh-native-browser install --browser=chrome
```

如果你使用 `desktop`、`browser-lab` 或其他 Profile，把整行中的两处 `web` 都换成实际名称。插件需要安装到你正在使用的 DSH Profile；装到另一个 Profile 不会在当前聊天中注册工具。

安装器会把扩展复制到固定目录，注册 Native Messaging Host，启动并检查后台 Broker，然后打开 Chrome 扩展页和 Finder。终端关闭后后台服务继续运行。

### 2 首次在 Chrome 确认加载扩展

在 `chrome://extensions` 开启“开发者模式”，点击“加载已解压的扩展程序”。在出现的目录选择窗口按 **Command + Shift + G**，粘贴安装器输出的完整扩展目录，回车后点击“选择”。隐藏的 `.dsh` 目录也可以这样直接定位。

这是首次手动确认步骤。当前通过 npm 分发未打包扩展，尚未在 Chrome 网上应用店上架。

### 3 连接并开始对话

重启安装插件的 DSH Profile。在 Chrome 打开一个普通网页，点开 DSH Native Browser 扩展，点击“允许当前标签页并连接”。然后在 DSH 输入：

```text
使用 native_browser 工具，读取我刚才授权页面的标题和主要内容，然后交还浏览器控制。
```

成功时，DSH 返回正确的页面内容；任务结束后页面仍保留。插件默认逐动作确认，安装器不会修改 DSH 的权限设置。页面截图由 DSH 交给所选模型，能否看懂图片取决于模型能力；不强制依赖 Vision Router。

### 权限模式

默认 `per-action` 适合首次验收。希望每次接管只确认一次，可以在该 Profile **已有** 的 `native-browser` 配置行加入：

```yaml
- id: native-browser
  config:
    approvalMode: per-lease
```

个人日常浏览可显式选择 `approvalMode: personal`，再重启对应 Profile。安装器已经提供匹配的 personal Broker；此模式连接后可发现并接管该 Chrome 中的普通 HTTP(S) 标签页，减少逐动作确认；应只在你愿意开放这些页面的个人浏览器中启用。同一会话中的控制可以跨轮次保留，Stop、交还控制、会话切换和租约到期仍会撤销控制。插件不能可靠判断任意按钮的业务后果，请由人完成付款、公开发布和其他不可逆业务步骤。详见[权限说明](docs/development.md#approval-modes)。

### 升级、排障与卸载

升级也运行上面的安装命令，然后在 Chrome 扩展页点“重新加载”，并重启对应 DSH Profile。固定扩展目录不会随 npm 包路径变化。**从旧 Alpha 首次迁移时**，移除原先从 `node_modules` 或源码目录加载的旧扩展，改为加载安装器输出的固定目录，并重新授权标签页。

若旧版 Broker 仍在某个终端运行，先在那个终端按 Ctrl+C，再运行安装命令。不要同时运行手工 Broker 和后台服务。

诊断命令中的 `web` 同样要换成实际 Profile：

```bash
dsh plugin --profile web exec dsh-native-browser doctor --browser=chrome
dsh plugin --profile web exec dsh-native-browser service-status
```

`doctor` 的 `ready` 表示连接组件和浏览器连接健康，不代表已经授权页面或模型任务一定成功。没有浏览器连接时，检查扩展是否已加载，以及是否点过“允许当前标签页并连接”。工具没有出现时，检查 Profile 并重启 DSH。完整故障对应表见[安装指南](docs/installation.zh-CN.md)。

卸载前先执行：

```bash
dsh plugin --profile web exec dsh-native-browser uninstall --browser=chrome
```

再在 Chrome 移除扩展，并从 DSH 插件管理器卸载插件。命令停止属于当前运行目录的后台服务并移除该浏览器的 Host 注册，保留本地状态和固定扩展目录；不会关闭你的标签页。

## 当前能力与边界

`0.1.0` 提供页面语义读取、点击、输入、滚动、复选框及单选框操作、批处理、多标签页、截图、受控视觉点击，以及文件上传、下载和原生对话框相关动作。各动作的具体条件见[版本说明](CHANGELOG.md)与该版本随包提供的文档。[实现文档](docs/current-implementation.zh-CN.md)描述开发版本，可能包含尚未发布的改动。

- 跨域 iframe 内容与动作仍有边界；发现一个 frame 不等于获得读取权限。
- 视觉点击需要截图及相应的模型理解能力；插件自身不运行视觉模型。
- 明确的 Stop 与 handoff 已有机制；自动识别任意人工操作并无缝续接仍需打磨。
- Edge 已有早期兼容性验证，正式支持和其他操作系统的完整验证仍在推进。
- 首次需要手动加载 Chrome 扩展；本机组件已由安装器配置，Chrome 商店分发和自动扩展升级仍在推进。

控制连接运行在本机。页面文本和截图可能通过 DSH 发给你配置的模型，请按模型服务和 DSH 的数据策略选择处理内容。

## 参与共建

**我们最想收到的反馈是：“这个任务在这里不顺。”** 你可以先使用、记录和复现问题，再决定是否参与代码。

| 你愿意参与的方式 | 可以带来的贡献 |
|---|---|
| 试用一个日常任务 | 描述目标、卡住的步骤，以及你期望的操作方式。 |
| 熟悉 Codex 的浏览器体验 | 说明具体哪里不够连贯：首次响应、动作间停顿、页面反馈，还是交接。 |
| 擅长文档或翻译 | 改进安装步骤、报错说明、任务示例和中英文文档。 |
| 擅长测试或前端 | 把失败步骤缩小成可公开运行的网页和复现用例。 |
| 擅长浏览器与系统开发 | 改善连接恢复、语义观察、动作等待、兼容性或安装流程。 |

从[已有问题](https://github.com/longmiaoo/dsh-native-browser/issues)开始，或[提出一个具体改进](https://github.com/longmiaoo/dsh-native-browser/issues/new)。如果列表里没有适合的任务，可以先描述你想解决的场景。涉及协议、权限或大范围重构时，先讨论方案，有助于减少返工。

### 反馈一次不顺畅的操作

请提供这些信息，敏感内容可省略或脱敏：

```text
任务目标：
系统、Chrome、DSH 和插件版本：
使用的模型、web/desktop profile 和权限模式：
卡住或不符合预期的步骤：
预期行为 / 实际行为：
最小复现步骤或公开测试页面：
可选：脱敏录屏、诊断结果、耗时记录
```

请勿公开提交 Cookie、令牌、账号资料或含私人内容的截图。安全漏洞按[安全报告方式](SECURITY.md)反馈。

### 开始代码贡献

在本地检出仓库后：

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
```

从小范围改动开始，并阅读[贡献指南](CONTRIBUTING.md)。浏览器行为改动还需对应的真实 Chrome 验证；性能改动请附可复现的前后结果。录屏、文档和问题复现本身也有价值。

## 下一步想一起改善什么

- 降低安装和升级成本，让第一次连接更容易成功。
- 减少连续任务中的空等、重复观察与不必要的模型往返。
- 改善操作状态反馈，以及停止、接管和继续的体验。
- 用更多真实网站任务验证流畅度与页面兼容性。
- 扩大 DSH 桌面端、Web 端和浏览器版本的验证覆盖。

这些方向欢迎提案；具体工作以讨论和可复现的问题为起点。[路线图](docs/roadmap.md)记录更详细的计划。

## 工具命名与共存

正式版默认注册 13 个 `native_browser_*` 工具，例如 `native_browser_claim`、`native_browser_observe`、`native_browser_act` 和 `native_browser_handoff`。独立命名避免与使用 `browser_*` 的插件重名。需要兼容旧提示词时，可在已有配置中显式设置 `legacyToolNames: true`；已被其他插件占用的旧别名会跳过。新任务直接使用标准名称。

源码开发、手工 Broker 和实验功能见[开发文档](docs/development.md)。

## 技术与验证

语义观察负责理解页面，可操作性检查负责确认目标，本地运行时负责连接与会话状态，虚拟指针负责展示已经发出的操作。减少重复读取和模型往返，是打磨连续体验的重要方向。

已有的本地执行层测试和 benchmark 用于验证这些基础能力；完整模型任务、真实网站和长时间使用需要更多证据。我们以 Codex 为体验标杆，持续验证与改进。

[当前实现](docs/current-implementation.zh-CN.md) · [性能测量](docs/benchmarks.md) · [安全模型](docs/security-model.md) · [架构计划](docs/plans/README.md)

### 文档导航

- [安装、配置与诊断](docs/development.md)
- [当前实现](docs/current-implementation.zh-CN.md)与[实施进度](docs/implementation-progress.md)
- [性能测量](docs/benchmarks.md)与[安全模型](docs/security-model.md)
- [路线图](docs/roadmap.md)与[架构计划](docs/plans/README.md)
- [浏览器插件比较与 Codex 体验计划](docs/plans/browser-plugin-competitive-analysis.zh-CN.md)
- [架构背景](docs/architecture.md)、[协议](docs/protocol.md)与[Chrome 集成研究](docs/research/codex-chrome-browser-architecture.md)
- [Chrome first 决策](docs/decisions/0001-chrome-first.md)

Chrome DevTools MCP provider 仍属于后续规划，当前浏览器操作使用原生 Chromium 路径。

## 致谢与许可

感谢 DeepSeek Harness、Chrome DevTools Protocol、Chrome 扩展平台和浏览器 Agent 社区。Codex 为本项目提供体验参考；本项目独立实现，与 OpenAI 无隶属或背书关系。

[MIT License](LICENSE)

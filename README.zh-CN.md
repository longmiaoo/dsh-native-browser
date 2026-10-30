# dsh-native-browser

<p align="center">
  <img src="https://raw.githubusercontent.com/longmiaoo/dsh-native-browser/main/assets/icon-180.png" width="140" alt="dsh-native-browser 图标" />
</p>

> 为 DeepSeek Harness 打造流畅、连贯的原生 Chrome 操作体验。

[![Alpha](https://img.shields.io/badge/status-alpha-orange)](#当前能力与边界) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · 简体中文 · [开始试用](#开始试用) · [参与共建](#参与共建) · [反馈体验](https://github.com/longmiaoo/dsh-native-browser/issues/new)

让 DSH 在你日常使用的 Chrome 中办事：沿用已有标签页、登录状态和扩展，通过自然语言读取页面、填写表单、完成连续操作，并在需要时交还控制。

**我们以 Codex 的浏览器操作体验为标杆：让熟悉 Codex 的用户来到 DSH，也能获得自然、连贯的浏览器协作体验。** 项目正在向这个目标打磨，目前处于公开 Alpha 阶段。

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

下面安装已发布的 `0.1.0-alpha.10`，使用 DSH `web` profile。[开发版本](#开发下一个版本)正在准备 `alpha.12`，增加一键安装和独立工具命名。安装到 `desktop` 时，将命令中的 `web` 一致替换为 `desktop`。两个 profile 需要分别安装。

环境以 **macOS + Google Chrome** 为首要验证目标。需要 Node.js ≥ 22.19、可运行的 DSH 和 pnpm 11。已记录的 DSH 验证版本是 `0.1.5-rc.1`；发布包声明兼容 `>=0.1.5-rc.1 <0.3.0`，其他版本仍欢迎提交兼容性反馈。

### 1 安装插件并注册连接组件

```bash
dsh plugin --profile web add dsh-native-browser@0.1.0-alpha.10
dsh plugin --profile web exec dsh-native-browser setup --browser=chrome
```

`setup` 会注册 Native Messaging Host，并输出扩展目录 `extensionPath` 和稳定的扩展 ID。

打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，载入输出的 `extensionPath`。若已有旧的未打包扩展，按 setup 提示先移除旧版，再载入当前版本。

### 2 启动首次试用连接

在终端运行以下命令，并保持该进程运行。这条首次试用路线只准入 `https://example.com`，沿用默认的逐动作审批。

```bash
dsh plugin --profile web exec dsh-native-browser broker --allow-origin=https://example.com
```

确保所选 DSH profile 中 `native-browser` 配置使用默认的 `approvalMode: per-action`。如果此前改过权限模式，先按[配置说明](docs/development.md#explicit-chromeprofile-setup)核对。

重启对应 DSH profile。在目标 Chrome profile 中打开 `https://example.com`，通过扩展弹窗允许该标签页并连接。

### 3 完成第一个任务

在 DSH 中发送：

```text
接管标题为“Example Domain”的已授权标签页，读取标题和主要内容，然后释放浏览器控制。
```

按 DSH 提示批准工具操作。首次成功的标志是：DSH 返回正确的页面内容，并结束本次浏览器控制，页面仍留在 Chrome 中。

若连接失败，运行诊断：

```bash
dsh plugin --profile web exec dsh-native-browser doctor --browser=chrome
```

`ready` 表示连接组件健康；实际页面任务还需要对应的标签页授权。

### 日常连续操作的权限配置

首次连接成功后，可根据使用场景选择 `per-lease`、`trusted` 或显式启用的 `personal` 模式，减少逐动作确认。模式说明和完整配置见[开发与安装文档](docs/development.md#approval-modes)。

`personal` 需要匹配的 Broker 启动模式和 DSH 配置。请按文档切换已有进程；同一个运行目录只使用一个 Broker。本 Alpha 不适用于支付、破坏性业务操作、密码输入或无人值守任务。

## 当前能力与边界

`alpha.10` 提供页面语义读取、点击、输入、滚动、复选框及单选框操作、批处理、多标签页、截图、受控视觉点击，以及文件上传、下载和原生对话框相关动作。各动作的具体条件见[版本说明](CHANGELOG.md)与该版本随包提供的文档。[实现文档](docs/current-implementation.zh-CN.md)描述开发版本，可能包含尚未发布的改动。

- 跨域 iframe 内容与动作仍有边界；发现一个 frame 不等于获得读取权限。
- 视觉点击需要截图及相应的模型理解能力；插件自身不运行视觉模型。
- 明确的 Stop 与 handoff 已有机制；自动识别任意人工操作并无缝续接仍需打磨。
- Edge 已有早期兼容性验证，正式支持和其他操作系统的完整验证仍在推进。
- 目前需要手动加载 Chrome 扩展；完整安装器和更轻松的更新流程是共建方向。

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

## 开发下一个版本

当前检出代码正在准备 `0.1.0-alpha.12`，元数据记录了 DSH `0.1.5-rc.1` 和 `0.2.1-rc.3` 的兼容性，声明范围为 `>=0.1.5-rc.1 <0.3.0`。源码开发请使用对应的本地插件安装说明；上面的已发布 `alpha.10` 是独立的安装路线。

开发版本增加了一键安装器。在已完成构建的本地仓库中运行：

```bash
node bin/dsh-native-browser.mjs install --browser=chrome
```

在 macOS 上，该命令将扩展放入稳定的私有目录，注册 Native Messaging Host、启动 LaunchAgent Broker，并打开扩展安装页。你仍需手动完成 Chrome 的“加载已解压的扩展程序”确认，再将本地 bundle 挂载到专用 DSH 开发 profile。步骤见[安装说明](docs/development.md#explicit-chromeprofile-setup)。升级后重新执行安装并重载扩展。该安装方式已提供 Broker，请勿在同一运行目录额外启动竞争的手工 Broker。

安装器使用个人模式 Broker，adapter 仍默认逐动作审批。若要为普通个人浏览显式减少确认，可在 profile 已有的 `native-browser` 行中配置 `approvalMode: personal`，再重启对应 DSH profile。Stop、handoff 和会话切换仍会释放控制。

### 工具命名与共存

`alpha.12` 使用 `native_browser_*` 命名，包括 `native_browser_claim`、`native_browser_observe`、`native_browser_act` 和 `native_browser_handoff`。独立前缀便于与其他浏览器插件共存；已发布 `alpha.10` 使用早期的 `browser_*` 名称。

旧提示词或自动化需要兼容别名时，可显式开启：

```yaml
- id: native-browser
  config:
    legacyToolNames: true
```

已被其他插件占用的别名会跳过，标准的 `native_browser_*` 工具仍然可用。新集成应使用标准名称。

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

# 六个浏览器竞品源码复核与 0.1.6 优化方案

日期：2026-11-02。本项目基线：`cb886ed`，package 版本 `0.1.6`。

## 结论与证据边界

0.1.6 已有任务用途标记与完成清理、聊天/设置执行状态、现代 DSH 前台同步、输入指针、连续移动动画与独立活动提示。此前 0.1.2 报告中的这些缺项已经过时，不能再按旧版本安排开发。

下一轮最有价值的投入依次为：可信的结果与恢复提示、人工点选目标、人工接手后继续、业务事实前置核对、工具上下文减重，以及 select/hover 等常见交互。商店分发仍是首次使用的关键差距。当前没有同机竞品成功率、时延和 token 实测，不能宣布整体领先或落后。

本次已将六个仓库浅克隆到工作区旁的 `browser-competitors/`，没有安装或运行竞品依赖/脚本，没有把竞品接入日常 Chrome，也没有读取其运行态或用户凭据。下面结论来自固定提交的实现与测试源码；测试文件的存在不表示这些测试已在本机通过。源码版本也不等于 npm 已发布版本或商店版本。

| 本地目录 | 项目 | 克隆提交 | package 源码版本 |
| --- | --- | --- | --- |
| `tencent-browserskill` | Tencent/BrowserSkill | `7840c46e956ffca61372d5bd2ad674cd85403ddf` | DSH 插件 0.4.1 |
| `dsh-browser-cdp` | drscrewdriver/dsh-browser-cdp | `d161dc89e356473f651d3507bfe66073826e7040` | 1.7.6 |
| `wqty123-dsh-browser` | wqty123/dsh-browser | `c224979d30f49ee653ad85b5857799945a69f982` | dsh-builtin-browser 0.5.2 |
| `dsh-ego-browser` | Fisfzy/dsh-ego-browser | `5d13f2391b7b25a2025ddc4ef57ab5f74a546a4f` | 0.9.8 |
| `anweat-dsh-browser` | anweat/dsh-browser | `673c8bb906752aab0f65296aae02ddc0a3e705a0` | @anweat/dsh-browser 0.2.2 |
| `dsh-douyin-agent` | LockyBee/dsh-douyin-agent | `7989640e340f0fd79e2de9874880d5197546e755` | dsh-douyin-browser-local 1.4.6 |

本机下载清单为 `browser-competitors/source-snapshot-2026-11-02.json`，记录 remote、分支、SHA、源码版本与阅读范围。更新这些 checkout 前应保留本快照依据；不要用一次普通 pull 悄悄替换本报告的版本。

## 1. 安装与连接：同一个 Chrome 程序不等于同一份登录态

| 项目 | 实际连接路径 | 首次使用成本及需要学习的设计 |
| --- | --- | --- |
| BrowserSkill | CLI/daemon + Chrome/Edge 扩展，独立 Agent Window；明确借用/归还已有页 | CLI、扩展、DSH 插件分别安装更新；有商店入口。学习一步一检查的安装指导、协议兼容和多实例选择 |
| CDP | 随包 ego 兼容运行时、受管 Chrome/CDP，也提供端点选择 | `runtime/ego-linux/src/chrome.mjs` 使用远程调试端口与专用 profile；基础操作无扩展，但 Chrome、显示环境和端点依赖仍需诊断 |
| wqty123 | 官方侧栏、自托管 Electron、显式系统 Chrome/Edge | `system-browser.ts` 使用插件专用 user-data-dir 与 DevToolsActivePort。Electron 二进制和可选 Desktop bridge 不是零成本；学习明确载体选择、真实版本报告和可操作失败原因 |
| ego | 随包 JS 运行时启动受管 Chrome，常驻执行器可选 | 基础自动化无扩展；复用现代日常 Chrome 登录态的推荐路径另装 cookies 桥接扩展并配对。学习环境自检与单次/常驻通道的一致契约 |
| anweat | Playwright/Patchright 启动系统 Chrome/Edge 或已安装 Chromium；会话 context 隔离 | 系统有浏览器时少一次二进制下载，但不自动附着日常窗口。authProfiles/storageState 和可选 OpenCLI 另有配置 |
| 抖音助手 | Windows 专用 Edge + 固定业务流程 | 插件设置、自检、手动登录和验证码处理形成完整用户路径；不是通用跨平台现有 Chrome 接管方案 |
| 我们 0.1.6 | Native Messaging + 本地 Broker + 用户当前 Chrome 扩展 | 直接沿用现有登录态，标准路径无需调试端口；商店未完成，首次 Load unpacked 与扩展更新仍有摩擦 |

建议保留现有 Chrome 作为主路径。未来可新增可选 managed-browser provider，但不能在扩展断开时悄悄切到另一份登录态；UI 必须明确浏览器实例、运行主机和登录环境。Chrome、Edge、平台注册与能力声明应继续由 provider/installer 隔离。

## 2. 各项目最有价值的实现

### BrowserSkill：按需能力、业务前置条件、真实的人机协作

重点源码：`packages/dsh-plugin-browserskill/src/lazy-tools.ts`、`sessions.ts`、`step-receipt.ts`，以及 `skill/references/cooperation.md`。

- lazy-tools 识别成功的技能调用，而非看到工具调用就假定加载成功；适配新旧 DSH tool/result 形态，并利用持久事件恢复发现状态。工具套件的揭示是进程级注册，不应误称完全按每个对话隔离。
- sessions 区分 starting / active / cleanup，登记 owned 资源。创建失败不等于没有创建资源，卸载与清理只能停止自己登记的会话。
- step-receipt 用宿主 execution token 跟踪回执，区分工具操作结束、取消和宿主策略抑制。不能因补回执而覆盖宿主拒绝。这比单纯把 HTTP/RPC 成功视作动作成功更完整。
- cooperation 文档及交互入口把目标身份与业务事实区分：同一个 DOM 节点可能从“保存”变为“删除”，虚拟列表也会复用节点。`expect` 在输入前检查文本、属性、值等事实，已有的动作后置条件不能替代这一环。
- 人工干预后重新 sync/replan，等待人的活动结束，保留已完成步骤；不是发一个新 context 就重放旧操作。

吸收方案：在现有 epoch/ref/后置条件上扩展有界前置条件；绑定原始节点与当前文档，不引入任意 JS；缺失能力时明确拒绝而非悄悄取消条件。人机协作要新增“暂停/人工修改/重新观察/继续”的契约，不把一次鼠标反馈当作接管检测。

### CDP：人工指认是准确性能力，不只是观察窗装饰

重点源码：`src/worker/pick-channel.ts`、`pick-contract.ts`、`pick-ui.ts`、`src/cdp/events.ts`。

- inspect mode 使用常驻的 CDP 会话；DOM 与 Overlay 的启用顺序和 domain affinity 被明确处理。另起一个临时连接做 inspect 容易出现能启动但收不到事件的问题。
- 失败分 connection / target / arming / hit / describe 五类。命中坐标但无法描述节点属于失败，不把裸坐标当成成功指认。
- 一次 pick 后立即退出 inspect，避免继续吞用户点击。结果包含目标和来源信息，而不是只给“右边那个按钮”。

吸收方案：复用我们的扩展常驻调试通道，生成 Host 所有的短期 pick 引用，绑定会话、tab、epoch 和节点身份。先进入草稿，让用户发送；不把网页中的指令当作用户授权。跨源 iframe 继续拒绝或明确降级，不能拿顶层坐标假装已验证子文档。

### wqty123：默认可用、载体归属、重复绘制抑制

重点源码：`src/browser-electron/virtual-cursor.ts`、`system-browser.ts`、`ephemeral-profile.ts`、`runtime-diagnostics.ts` 与 `src/tool-browser/index.ts`。

- 已有页面内光标、波纹和动作文字，不能将“虚拟鼠标”宣传为我们独有。
- WeakMap 记忆上次位置及动作，避免相同位置重复绘制重启动画；反馈失败不应使真实操作失败。
- 系统浏览器启动探测读取 DevToolsActivePort，并在专用 profile 中确认实际进程归属，而非看到一个端口就认为是自己启动的浏览器。
- 临时 profile 清理要确认 owner 进程已经退出且满足清理条件；这是资源所有权原则，不宜直接变成删除用户 profile 的功能。
- runtime-diagnostics 从运行进程报告 Electron/Chrome/Node 版本，不从 npm 包名猜测运行内核。0.1.6 的 Native Messaging 诊断可吸收同样原则。

对我们：0.1.6 已实现距离相关动画、持续重定向、reduced-motion 和独立活动提示，本轮不需要再重写光标。后续以真实中间帧、CSP/Trusted Types、滚动/缩放和 Stop 后无残留验收；不要通过 sleep 延迟真实输入来制造“流畅”。

### ego：常驻执行与观察画面的资源控制

重点源码：`src/index.ts` 的 resident transport、`tests/serve-protocol.test.ts`、`src/worker/capture-cdp.ts`、`extension/background.js`。

- 可选常驻进程减少每次启动开销，但相应测试专门检查全局环境恢复、stdout 协议与各次调用隔离。常驻不是免费优化，会增加故障状态。
- 任务空间、tab target、观察帧和当前选中目标分别管理。画面切目标时需要 generation fence，不能把旧目标的迟到帧展示为当前页。
- cookies 扩展的作用是把指定域名登录态导入受管浏览器，和我们通过 Native Messaging 操作现有页是不同问题；不用为“看起来安装简单”引入 cookie 搬运。

对我们：Broker/Native Host 已是常驻路径，不需要照搬 ego 执行器。若增加聊天观察窗，优先可见时采样、只留最新待发帧、限制解码/发送队列，并将人工观看帧与模型截图的发布权限分开。

### anweat：工具入口减重、严格歧义处理和可度量预算

重点源码：`src/tool-defs.ts`、`locator.ts`、`skill.ts`、`automation-execution.ts` 与 `automation-journal.ts`。

- indexed 入口保留 browser_index/browser_call，分组查询动作 schema；flat 模式另存。按 JSON Schema 实际序列化长度计算预算，字符/token 比值只是估算器。
- locator 默认要求唯一匹配；若显式选 index，要求 indexReason；这不等于任意 first 都可靠。我们的 ref 与精确 query 已有类似严格性，不应退回默认取第一个。
- skill 是可选宿主服务，不让缺技能服务阻塞整个插件加载；适合我们的渐进接入。
- 自动化资产、探索记录、独立重放验证分层，不把一次成功探索等同于可复用自动化。这适合后期站点工作流，近期不应先引入任意脚本资产执行器。

对我们：测得 14 个常驻工具的 name/description/parameters JSON 共 39,641 字符，act 为 16,297，batch 为 12,862，二者约占 73.6%。这是本地注册面测量，不是模型 tokenizer 的 token 数，也不是响应延迟。act/batch 重复携带动作 schema 是明确减重目标。

先提供可选 indexed 工具面和按需指南，保留现有工具名兼容；做同任务 A/B 后决定默认值。验收必须包含用户只说自然语言、不知道斜杠命令时的能力发现；不能为压缩上下文让插件“装了却找不到”。

### 抖音助手：业务回执和可以照做的诊断

重点源码：`receipt-baseline.mjs`、`diagnostics.mjs`、`browser-host.mjs`、`tests/chat-recovery.test.mjs`。

- 动作前基线记录 operation、目标业务 ID 与正文摘要，结果不确定时通过只读业务证据回查；不能事后补造旧收据的点击前基线。
- 回读要求明确身份和唯一匹配，不把“按钮点了”当作“业务发送成功”。这类实现依赖抖音特定结构，不能直接泛化为所有网页已确认。
- 诊断把原因、处理主体、步骤与限定修复操作一起返回；不以删锁、清记录、重发来处理不确定性。

对我们：已有动作 journal 是防重复的基础，但通用工具只能返回已验证的页面证据。站点级业务确认应做成可选适配器，不能让模型自报成功覆盖 journal。近期先让任务 UI 清楚区分未知、失败和可继续。

## 3. 0.1.6 的真实位置

| 维度 | 0.1.6 已有 | 当前仍缺 / 需专项验证 |
| --- | --- | --- |
| 安装 | 当前 DSH 内配置、固定目录、模式诊断 | 商店分发、升级后扩展版本错位提示、多 Chrome 实例易辨识名称 |
| 可见反馈 | 鼠标连续动画、输入反馈、读取状态、任务卡 | 在复杂布局/严格页面上的连续性与实际时延基线 |
| 生命周期 | temporary/deliverable/handoff、completed 轮次清理、原用户页保留 | 用户主动编辑临时页后的自动保留、跨重启元数据与授权分离；不可按历史数字 ID 关页 |
| 准确执行 | epoch/ref、动作可执行性、命中校验、后置条件、journal | 用户点选、业务事实前置条件、人工改完后继续 |
| 常见动作 | fill/append/click/check/press/scroll/wheel、上传下载、对话框、受控视觉点击 | select、hover、历史导航、结构化列表/表格提取 |
| 观察 | AX、定向 query、分页、delta、同源 frame 路径 | 虚拟化列表记录身份核对、人工协作同步、宽 iframe 能力需独立验收 |
| 模型成本 | 明确命名、结构化 schema、部分 delta 观察 | act/batch schema 重复，按需工具面与指南 |
| 稳定性 | 多层控制边界、Stop、回归与真实 Chrome smoke | 长会话、并发、故障注入和同机竞品评测；测试数量不能代替这些 |

## 4. 本轮已经实施的优化

源码复核发现：0.1.6 的聊天动作卡会提示 unknown/unverified，但任务状态的 addTool 包装只把抛异常视为失败；act 返回未知结果是正常 fulfilled Promise，因此任务设置页会回到 ready。

已先添加回归，旧实现真实失败为 `expected attention / actual ready`，随后修复：

1. `BrowserTasks` 只保存 outcome/dispatch/postcondition 三个枚举值作为 lastResult，不保存输入、URL、页面正文、截图或原始错误。
2. 未知、失败或后置条件未通过的结果使任务进入 attention；随后普通 observe 成功不会清掉该待核实状态。后续已验证动作可更新最近回执。
3. 按错误代码给出连接、控制交接、目标变化、显式策略与结果核实的固定恢复类别，设置页显示中英文建议。
4. 工具原始结果、动作 journal、模型可见错误、宿主审批和关闭权限不变；没有自动重试、自动重新 claim 或恢复执行。
5. 收尾“completed”仍表示资源收尾完成，不表示业务成功。回执继续独立保留；通用 observe 本身不证明业务已完成，也未新增业务自动核销功能。

相关文件：`packages/dsh-adapter/src/tasks.ts`、`index.ts`、`client.js`、`test/adapter.test.mjs`、`scripts/smoke-setup-ui.mjs`。这是 0.1.6 之上的本地候选改动，未修改版本号、未推送或发布；竞品代码没有复制进产品。

验证记录：`pnpm check`、`pnpm typecheck` 通过；完整测试 619 项通过。真实 Chrome 153.0.8010.12 中的宿主 React/SlotCore 设置页 smoke 覆盖未知结果警告与目标变化指引，通过。日志分别为 `/tmp/dsh-016-deep-review-tests.log` 和 `/tmp/dsh-016-review-ui.log`；产物位于 `output/playwright/setup-ui.json`。没有重跑全部网站动作，也没有声称竞品通过同机评测。

研究期间同一工作区还有安装引导、插件详情/侧栏入口与 README/package description 的并行修改。版本仍是 0.1.6；这些变化不是本次复核新实现的功能。保留它们，不做提交或发布；后续发布前应对最终合并后的工作树统一检查，不能把本次回归结果无限外推到之后的并行改动。

## 5. 分阶段实施与验收

### P0：把已知结果表达正确，形成可比较基线

- 本轮回执状态与恢复提示通过完整回归及真实 React/SlotCore UI smoke 后交付。
- 固定 12 类任务：首次安装/升级、搜索比较、中文填表、原生下拉、hover 菜单、同名按钮指认、虚拟化列表、人工修改后继续、动态 frame、下载、未知提交结果、任务清理。
- 同一台 Mac、同一 Chrome 主版本与模型配置，每类任务至少重复 5 次；分别记录冷/热启动、模型耗时与浏览器耗时。保存脱敏操作元数据，不记录登录内容。模型和网络均有波动，需报告分布和失败样本。
- 成功指标：可核验业务结果、重复副作用次数、误关用户页次数、Stop 后输入次数、总调用数、P50/P95、实际 tokenizer 计量或服务账单。无权限执行的任务记为阻塞，不伪装失败重试。

### P1：人工点选与人工接手闭环

- 新增 source-side pick 能力，独立协商版本；Inspector 模式有取消/超时/Stop 清理，选择结果仅进入当前对话草稿。
- 引用绑定 session/tab/documentEpoch/节点身份及期限；导航、替换、切换与过期后拒绝旧引用。不得跨会话使用，也不直接暴露 provider token。
- 检测用户真实编辑/拖动/按键活动，暂停代理写入并保护人工改动；手动完成后显式继续，再观察和规划。单纯鼠标经过不应频繁打断。
- 用户改过的临时页转为待接手/保留状态；此设计需先验证事件可信度、IME 与 Shadow DOM，不直接把网页合成事件当作用户接管。
- 验收：同名按钮点选不歧义；切到别页迟到的选择不进入新对话；人工填写不被自动覆盖；Stop 后 inspector 不吞点击。

### P2：业务前置条件与高频动作

- 在固定动作契约中增加有界 `preconditions`，支持已观察目标的精确 text/value/checked/attribute 条件；先验证原节点与 epoch，再核对事实，在最终输入前复检。条件失败返回未派发，敏感值不写日志。
- 前置条件与后置条件使用不同字段，不承诺与远端业务服务器构成原子事务。虚拟列表须检查业务 ID，不能仅验证 DOM 仍存在。
- 先补原生 select 与受控 hover，再按用户任务补 back/forward 与只读提取。select 验证值/标签唯一性、disabled、多选和事件结果；hover 不得假称菜单已打开；导航使旧 ref 失效。
- 每项穿透 contracts/validation/runtime/provider/extension 能力协商，不能只加适配器描述；Edge 通过自己的实际测试后才声明支持。

### P3：工具面减重与可选观察窗

- 新增可选 indexed 面，保持现有 14 工具兼容，评测通过后再迁移默认。保留不可妥协的 Stop、授权、未知结果和重放禁令。
- 按需指南应随包提供、无外网依赖，避免扫描其他会话历史或凭据。缺技能服务时可用基础工具，宿主升级需真实集成回归。
- 若用户需要聊天内实时看页面，使用有界最新帧队列、可见性启停、目标 generation 和模型截图独立发布；不要默认把每帧交给模型。
- 建议验收目标：工具面字符减少至少 50% 是设计目标而非已实现成绩；能力发现与任务完成率不得因压缩显著下降。帧率、CPU 与内存目标先实测再定。

### 分发并行项

继续准备 Chrome 商店提交，注册付费由用户完成后再恢复后台操作。商店 ID、Native Messaging 白名单、旧固定目录扩展迁移和错位更新必须实测。Edge 与 Windows/Linux 分开做门槛；不得以 Chrome 结果代替。

## 6. 保留的架构与不直接照搬的部分

本地研究不改变分层：DSH 入口/任务元数据 → runtime/动作与观察契约 → provider → 浏览器扩展/Native Messaging。用户 UI 不直接发送 CDP 或绕过租约；页面数据只作输入数据。

近期不引入 cookie 批量导入、profile 复制、默认 no-sandbox、修改桌面 asar 的 bridge、任意 JS 工作流或多远端调度。这些服务于不同部署需求，会扩大维护和权限范围。未来若有明确需求，应以可选 provider/adapter 实现并独立验收。

六个 package 均声明 MIT，但携带的运行时与第三方资产仍有各自 NOTICE。借鉴设计不等于复制代码；若未来复用实现，应核查具体文件与传递依赖许可、保留归属和测试边界。本次实现为本项目原创的小范围状态修复。

## 7. 源码复核入口

- [BrowserSkill](https://github.com/Tencent/BrowserSkill/tree/7840c46e956ffca61372d5bd2ad674cd85403ddf/packages/dsh-plugin-browserskill)：lazy-tools、sessions、step-receipt 与 cooperation 参考。
- [CDP picker](https://github.com/drscrewdriver/dsh-browser-cdp/tree/d161dc89e356473f651d3507bfe66073826e7040/src/worker)：pick-channel / pick-contract / pick-ui。
- [wqty123 provider](https://github.com/wqty123/dsh-browser/tree/c224979d30f49ee653ad85b5857799945a69f982/src/browser-electron)：virtual-cursor / system-browser / runtime-diagnostics / ephemeral-profile。
- [ego 源码](https://github.com/Fisfzy/dsh-ego-browser/tree/5d13f2391b7b25a2025ddc4ef57ab5f74a546a4f)：resident transport、serve-protocol 测试、cookies 扩展与观察管道。
- [anweat 源码](https://github.com/anweat/dsh-browser/tree/673c8bb906752aab0f65296aae02ddc0a3e705a0/src)：tool-defs / locator / skill / automation-execution。
- [抖音助手](https://github.com/LockyBee/dsh-douyin-agent/tree/7989640e340f0fd79e2de9874880d5197546e755)：receipt-baseline / diagnostics / browser-host。

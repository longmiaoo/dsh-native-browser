# 浏览器插件竞品分析与 Codex 级体验计划

日期：2026-10-30。数据源：awesome-dsh-plugin `plugins.json`（索引更新 2026-10-29）、npm registry `latest` 元数据、各项目 GitHub README/package.json。下载量为近 30 天滚动值，stars 为抓取时快照；索引可能滞后于 npm 最新版本。

## 1. 结论

- 市场并不“不拥挤”：索引共 7,723 个插件，`category=browser` 161 个，按名称/描述匹配浏览器相关约 484 个。
- 真正做“真实浏览器控制”的头部是 **Tencent BrowserSkill**、**dsh-browser-cdp**、**dsh-builtin-browser**；三者合计约 8.9 万次近 30 天下载，远高于我们的 910。
- 我们的差异化不在“工具数量”，而在 **Codex 式可见操作 + 用户现有 Chrome + 严格动作校验**：
  - 虚拟鼠标/点击/滚轮脉冲在用户当前页面内；
  - 不引入 Electron/bsk CLI 等第二套浏览器运行时；
  - tab lease、动作 journal、命中/重叠校验、visual-click 新鲜度校验；
  - 会话切换撤销、Stop、handoff、多标签 release-all。
- 当前最大的非技术短板：
  - 市场索引仍停在 `0.1.0-alpha.2`，能力扫描停在 2026-09-24，仍带旧红线 `uses plaintext http:// to *`；
  - 之前没有 `engines.dsh`，市场显示“未声明宿主要求”；
  - 安装仍需手动 Load unpacked；
  - 工具名仍是通用 `browser_*`，存在命名冲突风险；
  - 功能广度落后于 BrowserSkill / dsh-builtin-browser。

## 2. 市场全景（browser category，按近 30 天下载）

| 插件 | npm | 版本 | 下载 | Stars | 类型 |
|---|---|---|---:|---:|---|
| dsh-free-search | dsh-free-search | 0.9.21 | 66,454 | 718 | 搜索/抓取（相邻） |
| modsearch | @liustack/modsearch | 5.10.11 | 46,737 | 875 | 搜索/抓取（相邻） |
| BrowserSkill（腾讯） | @wxg-prc-cpg/browser-skill-dsh-plugin | 0.3.3（npm 0.4.0） | 34,113 | 9,785 | 真实浏览器控制 |
| dsh-browser-cdp | dsh-browser-cdp | 1.7.4 | 28,615 | 19 | 真实浏览器控制（CDP 接入） |
| dsh-builtin-browser | dsh-builtin-browser | 0.4.15 | 26,622 | 154 | 真实浏览器控制 |
| dsh-douyin-agent | dsh-douyin-browser-local | 1.4.5 | 18,800 | 29 | 垂直站点自动化 |
| dsh-web-search-zhipu | dsh-web-search-zhipu | 0.1.0 | 7,642 | 1 | 搜索/抓取（相邻） |
| @anweat/dsh-browser | @anweat/dsh-browser | 0.2.2 | 5,523 | 29 | 真实浏览器控制（Playwright） |
| dsh-browser-playwright-codex | dsh-browser-playwright-codex | 0.7.7 | 3,083 | 2 | 真实浏览器控制（Playwright，Codex 风格） |
| dsh-inner-browser-use | dsh-inner-browser-use | 0.34.98 | 819（索引旧值） | 0 | 右栏内置浏览器 |
| dsh-tabbit | dsh-tabbit | 0.4.0 | 2,133 | 116 | 浏览器 + web_fetch 组合 |
| dsh-browser-control | dsh-browser-control | 0.1.0 | 548 | 48 | CDP/Playwright + WebSocket |
| dsh-browser4 | dsh-browser4 | 0.0.1 | 934 | 10 | Browser4 CLI 技能包 |
| dsh-aginxbrowser | dsh-aginxbrowser | 0.1.1 | ~1,000 | 55 | JS 渲染抓取/搜索（相邻） |
| **dsh-native-browser（我们）** | **dsh-native-browser** | **0.1.0-alpha.2（索引）/ alpha.10（npm latest）** | **910** | **4** | **真实用户 Chrome + 严格租约** |

## 3. 竞品分层

### 3.1 直接竞品：真实浏览器控制

#### A. Tencent BrowserSkill（`@wxg-prc-cpg/browser-skill-dsh-plugin`）

- 架构：`bsk` CLI/daemon + Chrome/Edge 扩展，Agent Window；DSH 插件只暴露 6 个 `bsk_*` 工具。
- 观察/动作：VOM/快照/HTML/console/network/video/extract；click/hover/drag/step/wheel/scroll/focus/blur/fill/select/press/evaluate/upload/download；tabs create/select/close/borrow/return；resize/emulate/request-help。
- 人机协作：Web UI 实时视图、shared-tab control、wait-user、cooperation-status。
- 宿主：peerDependencies `^0.1.5-rc.3 || ^0.2.0-rc.1`。
- 优势：功能最全、文档/生态/审计强、9.7k stars；腾讯品牌。
- 劣势：需要安装并维护 bsk CLI/daemon + 扩展；不是“直接在用户当前 Chrome 里画指针”的产品。

#### B. dsh-browser-cdp（drscrewdriver）

- 架构：附着到运行中的 Chrome/Edge CDP，无需自带浏览器；30+ `bcdp_*` 工具。
- 宿主：`engines.dsh` 明确列出 0.1.7-rc.1…0.2.1-rc.4。
- 优势：直接复用运行中的 Chrome、安装相对轻；下载量 2.86 万。
- 劣势：市场红线 `reads credentials/secrets AND has network access`；CDP 暴露面较大；stars 仅 19，社区信任弱。

#### C. dsh-builtin-browser（wqty123）

- 架构：共享真实浏览器（桌面侧栏/Web 自托管/本机 Chrome/Edge），Electron 载体；34 个 `dsh_browser_*` 工具。
- 能力：DOM 级交互（React/Vue 安全）、per-task session isolation、cookie persistence、CAPTCHA detection、batch form fill、authenticated download、history/replay、action restriction。
- 宿主：`engines.dsh: >=0.1.1-rc.2 <0.3.0`；Windows 验证。
- 优势：装好即用、共享真实浏览器体验、34 工具、长期迭代/CHANGELOG。
- 劣势：Electron 依赖；可见浏览器是插件自己的载体，不是用户当前 Chrome 页面内的虚拟指针。

#### D. @anweat/dsh-browser

- 架构：Playwright + Patchright，系统 Chrome/Edge 或 Playwright 浏览器。
- 宿主：peerDependencies 覆盖大量 DSH 0.1.5+ 客户端服务。
- 优势：5.5k 下载；系统浏览器复用 + Playwright 生态。
- 劣势：Playwright/Patchright 依赖重；会话/租约/审计不是产品核心。

#### E. dsh-browser-playwright-codex

- 架构：Playwright-core；表单、列表抓取、跨标签；使用已有登录态。
- 优势：名称直接对标 Codex；3k 下载。
- 劣势：stars 2；更像 Playwright 工具封装，不是 Codex 级可见交互。

#### F. dsh-inner-browser-use（regrevia）

- 架构：agent-owned Chromium sidecar，镜像到 DSH 右栏；人可观看并接管。
- 宿主：`engines.dsh >=0.2.0`。
- 优势：右栏内置、观看/接管体验好；版本迭代快（0.34.x）。
- 劣势：独立 Chromium sidecar，不是用户自己的 Chrome；下载量/生态较小。

#### G. dsh-tabbit

- 架构：Tabbit Browser bundle，`tabbit_browser` 工具 + browser-backed `web_fetch` + `@tab` composer mentions。
- 优势：2.1k 下载/116 stars；浏览器 + 抓取组合。
- 劣势：绑定 Tabbit 浏览器产品，通用性弱。

#### H. dsh-browser-control / dsh-browser4

- dsh-browser-control：CDP/Playwright + WebSocket 本地桥；548 下载/48 stars。
- dsh-browser4：Browser4 CLI 技能包；934 下载/10 stars。
- 共同点：更偏“桥/CLI 封装”，不是 DSH 原生 lease/审计产品。

### 3.2 垂直/相邻（不作为直接竞品，但会分流需求）

- dsh-douyin-agent：抖音专用，18.8k 下载；说明“垂直站点 + 本地助手”有强需求。
- dsh-free-search / modsearch / web-search-* / dsh-web-fetch-playwright / dsh-aginxbrowser：搜索、抓取、JS 渲染阅读；不提供完整交互控制，但会满足“读网页”需求。
- dsh-skip-browser-auth / kimi-webbridge-dsh：连接/认证/桥接基础设施，属于生态组件。

## 4. 竞品矩阵

| 维度 | 我们 | BrowserSkill | dsh-builtin-browser | dsh-browser-cdp | @anweat | inner-browser-use |
|---|---|---|---|---|---|---|
| 浏览器表面 | 用户现有 Chrome | bsk CLI + 扩展、Agent Window | Electron/共享浏览器/Chrome/Edge | 运行中的 Chrome/Edge（CDP） | 系统 Chrome/Edge + Playwright | 独立 Chromium 右栏 |
| 额外运行时 | 无 Electron/CLI | bsk CLI/daemon | Electron | 无（CDP） | Playwright/Patchright | Chromium sidecar |
| 虚拟鼠标 | **有（当前页面内）** | 公开文档未作为能力点 | 公开文档未作为能力点 | 未提及 | 未提及 | 未提及 |
| 观察 | AX-first、有界、增量、epoch | VOM/快照/HTML/console/network/video/extract | DOM 级、34 工具 | 结构化 CDP | Playwright 快照 | 右栏镜像 |
| 动作广度 | 中（含上传/下载/选择框/视觉点击） | 最广 | 最广（34 工具） | 广（30+ bcdp） | 中 | 中 |
| 多标签 | open/activate/release-all + grouping/agent-close | tabs create/select/close/borrow/return | 标签条/任务隔离 | 有 | Playwright tabs | 右栏 |
| 人机协作 | 指针/Stop/handoff/会话切换撤销 | 实时视图/wait-user/request-help | 人机同页/接管/CAPTCHA | 可见 Agent 浏览器 | 一般 | 右栏观看/接管 |
| 安全/审计 | lease/journal/后置条件/命中校验 | 共享控制同步 | 动作限制/会话隔离 | 红线：凭据+网络 | 一般 | 一般 |
| 宿主要求 | `>=0.1.5-rc.1 <0.3.0`（刚补） | `^0.1.5-rc.3 || ^0.2.0-rc.1` | `>=0.1.1-rc.2 <0.3.0` | 0.1.7–0.2.1-rc.4 | peerDeps | `>=0.2.0` |
| 生态体量 | 910 / 4 | 34k / 9.7k | 26.6k / 154 | 28.6k / 19 | 5.5k / 29 | 819 / 0 |

## 5. 我们的真实优势

### 5.1 Codex 级体验（核心叙事）

1. **用户当前 Chrome 页面内的虚拟鼠标**：点击/滚轮后出现指针和脉冲；不是另一个浏览器窗口里的光标。
2. **不引入第二套浏览器**：没有 Electron/bsk CLI/Playwright 浏览器；保留登录态、扩展、标签页。
3. **语义优先、视觉兜底**：AX 快路径；必要时截图 + `visual-click`，而不是把视觉当默认路径。
4. **多标签连续工作流**：独立 lease、activate、release-all。
5. **人类随时接管**：Stop、handoff、会话切换撤销。

### 5.2 超越 Codex 的可信度

- tab lease + per-tab queue：一个标签页同一时间只属于一个任务；
- 动作 journal：超时/断线/重启不盲重放，未知就标未知；
- 三段式结果：notDispatched / dispatched / observed + postcondition；
- visual-click：epoch、视口滚动/缩放、elementFromPoint、框重叠 ≥50% 四重校验；
- 跨源 frame 截图脱敏；
- 细粒度能力协商（runtime.upload.v1 / visual-click.v1 / open-tab.v1 等）；
- 本地 Unix socket + token + 扩展 ID 绑定，无公网端口。

### 5.3 必须补的短板

- 工具名 `browser_*` 是通用词，竞品已迁移到 `dsh_browser_*` / `bsk_*`；建议 0.1.0 前换成独立前缀并保留兼容别名。
- 安装仍需 Load unpacked；这是转化率最大的损失。
- 缺 hover/drag/select/evaluate/network/console/video/extract。
- 缺 UI 面板/实时状态。
- 市场索引/能力扫描滞后，旧红线未清。

### 5.4 当前已实现（alpha.10 基线）

- visual-click、上传/下载/选择框、多标签 open/activate/release-all、agent tab 分组/关闭；
- agent tab 分组（`DSH Browser` 蓝组）与 only-agent close；
- JavaScript `alert` / `confirm` / `prompt` / `beforeunload` 对话框处理；
- `engines.dsh`、中英 README、图标、npm provenance。

## 6. 三级目标

### L1 Codex 级

- 用户感觉“这就是 Codex 的浏览器手感”；
- 虚拟指针、连续观察、语义优先、视觉兜底、随时接管、多标签。

### L2 超越 Codex

- 每个动作可验证、可恢复、不盲重放；
- 多会话/多标签严格隔离；
- 本地优先、无额外运行时、截图脱敏。

### L3 Codex 用户无缝切换

- 一键安装（不再手动 Load unpacked）；
- 同一套心智模型 + 迁移指南；
- 20 个 Codex 风格任务对标；
- 不需要重新登录、不需要第二套浏览器。

## 7. 修订后的 6 周计划

> 日期是计划上限；验收不过顺延。

### W1（10/30–11/05）：让优势可见

- `0.1.0-alpha.10` 已在 npm；本周期做市场 rescan/图标、pointer demo、one-click install；
- README/市场：Codex-like 标题、虚拟鼠标 GIF/短视频、三行卖点；
- 合并市场 rescan issue #10507 + 图标 PR；
- 安装脚本化（先做 3 步一键路径）。

**验收**：新用户 5 分钟装好；市场显示宿主要求/新图标；README 首屏看懂“为什么丝滑”。

### W2（11/06–11/12）：日常动作补齐

- hover / drag / select；`evaluate` 先做只读有界版或明确不做；
- UI 面板/状态条（受控 tab、lease 数、最后动作、Stop/Handoff）；
- network/console 只读查看；video/extract 评估是否进入本批；
- 虚拟指针可见性优化（off-screen/遮挡提示）。

**验收**：覆盖“搜索→填表→选择→拖拽→下载→多标签”完整链路。

### W3（11/13–11/19）：Codex 用户迁移

- `docs/codex-migration.md` / `.zh-CN.md`：Codex 操作 → 我们的工具映射、5 个首次示例、差异说明；
- 可选 Codex 兼容别名（不改变安全边界）；
- 20 个 Codex 风格任务清单。

**验收**：Codex 用户按指南 10 分钟内完成 5 个任务。

### W4（11/20–11/26）：UI 与可观测性

- 右侧面板/状态条：受控 tab、lease 数、最后动作、Stop/Handoff；
- 动作时间线：observe → validate → dispatch → verify；
- 错误可读化：STALE_TARGET / NOT_ACTIONABLE / AMBIGUOUS_TARGET。

**验收**：不看日志就能知道 agent 在做什么、为什么停下。

### W5（11/27–12/03）：安全/稳定硬门槛

- journal 故障注入：Broker 中途被杀，不重复点击；
- 会话切换撤销 ≤1s；
- visual-click 滚动/缩放/遮挡/低重叠全部拒绝；
- 跨源截图脱敏真实 iframe 验证；
- 决定工具命名迁移并保留别名；
- 一键安装器/签名方案评估。

**验收**：每个安全卖点都有可复现测试。

### W6（12/04–12/10）：对标与 0.1.0 候选

- 20 任务真实 Chrome 基准：成功率、p50/p95 延迟、观察字节、stale-target 率、重复动作率、Stop 响应、会话切换撤销；
- 与 Codex / BrowserSkill / dsh-builtin-browser / dsh-browser-cdp 的可验证对比表；
- 发布 `0.1.0-rc.1`，市场重新扫描，准备正式版。

**验收**：一键安装 + 20 任务达标 + 安全评审 + 市场无高危红线 → `0.1.0`。

## 8. 量化指标

| 指标 | Codex 级 | 超越目标 |
|---|---:|---:|
| 语义动作 p50 / p95 | ≤150ms / ≤400ms | ≤100ms / ≤300ms |
| 截图 + 视觉点击 p95 | ≤2s | ≤1.5s |
| 典型页观察字节 | ≤8KB | ≤5KB |
| stale-target 误点击 | 0 | 0 |
| 重复动作 | 0 | 0（journal 证明） |
| Stop 响应 | ≤500ms | ≤200ms |
| 会话切换撤销 | ≤1s | ≤500ms |
| 20 任务成功率 | ≥90% | ≥95% |
| 安装到首个任务 | ≤10 分钟 | ≤3 分钟 |

## 9. 风险

1. 功能广度：BrowserSkill/dsh-builtin 工具多；我们先补高频，不追全量。
2. 命名冲突：`browser_*` 通用名；0.1.0 前必须迁移/别名。
3. 市场滞后：rescan issue 已开；alpha.8 发布后复查。
4. 视觉兜底：自定义 `sd` 路由需声明 `input: ["text","image"]`；否则 `read_image` 被 DSH 拒绝。
5. 安装摩擦：Load unpacked 是最大转化损失；W1 脚本化，W5 评估签名安装器。
6. 竞争定位：不要用“工具更多”硬碰腾讯；用“现有 Chrome + Codex 式可见 + 可验证安全”切自己的人群。

## 10. 定位文案

**中文**

> 在你自己的 Chrome 里，做出 Codex 一样的浏览器操作体验。  
> 看得见虚拟鼠标、保留登录态、语义优先、视觉兜底、每个动作都可验证、随时可以接管。

**English**

> Codex-like browser control inside the Chrome you already use.  
> A visible virtual cursor, your signed-in sessions, semantic-first observation, vision fallback, verified actions and instant human takeover.

**一句话竞争定位**

> 腾讯赢在功能广度，dsh-builtin-browser 赢在装好即用；我们赢在“Codex 式可见操作 + 你自己的 Chrome + 严格动作校验”。

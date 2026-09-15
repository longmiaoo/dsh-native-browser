# dsh-native-browser 当前实现：技术架构与关键时序

> 状态基线：2026-09-15  
> 范围：以当前工作区里的真实代码和实测结果为准，Chrome first。本文不会把规划中的能力写成已经实现。

## 1. 一句话结论

这个项目不是用 Playwright/Puppeteer 再启动一个“机器人专用浏览器”，而是通过 Chrome MV3 扩展接入用户明确授权的现有标签页，再用 <code>chrome.debugger</code> 调用 Chrome DevTools Protocol（CDP）。DSH 侧通过本地 Broker、Native Messaging Host 和扩展通信。

当前的主链路是：

~~~text
DSH Agent
  -> DSH Adapter
  -> Local Broker
  -> Runtime Core
  -> Chromium Provider
  -> Native Messaging Host
  -> Chrome MV3 Extension
  -> chrome.debugger / CDP
  -> 当前 Chrome 标签页
~~~

“丝滑”主要来自四点：

1. 以 Accessibility Tree（AX）做语义观察，不依赖每一步都截图识图。
2. 观察结果是有上限的窗口和增量，不把整棵 DOM/AX 树反复穿过模型与进程边界。
3. 动作在最后一刻重新确认节点身份、几何位置和命中目标，再只发送一次原生输入。
4. 输入后必须观察业务结果；如果已经发出输入但无法确认，返回 <code>unknown</code>，不会偷偷重试造成重复点击。

交互版图：

- [当前 Chrome 运行时架构图](./current-runtime.architecture.html)
- [一次可验证浏览器动作的完整时序图](./action-lifecycle.sequence.html)

两张图均通过 Archify <code>showcase</code> 级 9/9 结构校验，以及 1440×900、1600×1000、1920×1080、2048×1320 的亮/暗主题浏览器检查。

## 2. 当前技术架构

~~~mermaid
flowchart LR
    Agent[DSH Agent<br/>ToolRuntime]

    subgraph Node[本地 Node.js 控制面]
        Adapter[DSH Adapter<br/>browser_* tools]
        Broker[Local Broker<br/>Owner / Lease / Journal]
        Runtime[Runtime Core<br/>策略 / 串行化 / 结果语义]
        Contract{{BrowserProvider<br/>可移植契约}}
        Provider[Chromium Provider<br/>AX / Ref / Actionability]
        Host[Native Host<br/>Native Messaging]
    end

    subgraph Chrome[Chrome 信任边界]
        Extension[MV3 Extension<br/>Allow / Stop / 方法白名单]
        Debugger[chrome.debugger<br/>CDP 1.3]
        Page[已授权标签页<br/>DOM + AX + 用户状态]
    end

    Agent -->|tool call| Adapter
    Adapter -->|本地 RPC| Broker
    Broker -->|owner + lease + journal| Runtime
    Runtime --> Contract --> Provider
    Provider <-->|有界 wire message| Host
    Host <-->|Native Messaging| Extension
    Extension -->|allowlisted CDP| Debugger
    Debugger <--> Page
~~~

### 2.1 各层的真实职责

| 层 | 当前职责 | 主要代码 |
|---|---|---|
| DSH Adapter | 注册 9 个 <code>browser_*</code> 工具；把 DSH session 映射成隔离 owner；在变更动作前接入 ApprovalService；把截图发布为 DSH 可用附件 | <code>packages/dsh-adapter/src/index.ts</code> |
| Local Broker | Unix socket 本地 RPC、token 握手、连接角色隔离、owner/lease 生命周期、持久化 action journal、Provider 注册 | <code>packages/broker/src/server.ts</code>、<code>ownership.ts</code>、<code>action-journal.ts</code> |
| Runtime Core | 每标签页串行执行；二次校验 lease/策略；管理批处理、观察、动作、帧与结果状态；统一 fail-closed 语义 | <code>packages/runtime-core/src/runtime.ts</code> |
| Portable Contracts | 浏览器无关的请求、结果、错误码、能力协商、帧模型、wire 版本和输入校验 | <code>packages/contracts/src/</code> |
| Chromium Provider | AX 投影、节点 ref 缓存、文档 epoch、精确语义查询、几何和稳定命中、CDP 输入、结果确认、截图 | <code>packages/provider-chromium/src/</code> |
| Native Host | Chrome Native Messaging 的 framing 和 RPC 桥接 | <code>packages/transport-native/src/host.ts</code>、<code>framing.ts</code>、<code>rpc.ts</code> |
| MV3 Extension | 用户 Allow/Stop；只连接当前获准标签页；<code>chrome.debugger</code> attach；CDP 方法/参数白名单；最后一道 lease 与 tab 检查 | <code>packages/extension-core/src/background.ts</code>、<code>popup.ts</code> |
| Installer | 安装/诊断/卸载 Native Host manifest 和扩展产物；检查目录所有权与权限 | <code>packages/installer/src/</code> |
| Vision Adapter | 截图几何、候选 grounding、截图附件生命周期；为 <code>dsh-vision-router</code> 等视觉能力提供输入 | <code>packages/vision-adapter/src/</code> |

### 2.2 对 DSH 暴露的工具

当前 Adapter 注册：

| 工具 | 作用 |
|---|---|
| <code>browser_list</code> | 列出已连接浏览器实例，或扩展中明确允许的标签页 |
| <code>browser_claim</code> | 经审批后独占控制一个标签页，返回 lease |
| <code>browser_observe</code> | 读取有界 AX 文本、控件、区域；支持 subtree、精确 query、same-origin child frame |
| <code>browser_read_page</code> | 按单次 continuation 读取大页面的下一个实时 AX 窗口 |
| <code>browser_frames</code> | 只返回有界帧结构、opaque frame ID、父子关系、epoch 和 origin relation |
| <code>browser_act</code> | 单个 click/fill/append/press/scroll/wheel/check/navigate 动作 |
| <code>browser_batch</code> | 串行批动作；每个变更步骤分别审批；某步不确定时立即停止后续步骤 |
| <code>browser_handoff</code> | 释放当前控制，让用户接管 |
| <code>browser_screenshot</code> | 采集当前 viewport，并发布成 DSH 可读的受控附件 |

## 3. 身份、授权与状态模型

这个项目准确性的基础不是 selector，而是五类相互绑定的状态：

~~~mermaid
flowchart TD
    Conn[Broker connection epoch]
    Session[DSH wire session ID]
    Owner[Owner = connection + session]
    Lease[Lease<br/>instance + tab + origin + owner]
    Doc[Document epoch]
    Frame[Frame target<br/>opaque frameId + child epoch]
    Ref[Opaque node ref<br/>backendNodeId + role + name + epoch]
    Cursor[Single-use continuation<br/>lease + doc + scope + root]
    Req[requestId<br/>journal identity]

    Conn --> Owner
    Session --> Owner
    Owner --> Lease
    Lease --> Doc
    Doc --> Ref
    Lease --> Frame
    Frame --> Ref
    Lease --> Cursor
    Doc --> Cursor
    Ref --> Cursor
    Owner --> Req
~~~

### 3.1 Owner 与 Lease

Broker 不直接相信模型传来的 session 字符串。它把“当前 Broker 连接 epoch”和 Adapter 生成的 wire session ID 组合成 owner。不同连接、不同 DSH 会话无法互相使用 lease 或恢复元数据。

<code>browser_claim</code> 只对扩展已经允许、且 origin 在本地策略允许范围内的 tab 发放独占 lease。后续每次观察、截图和动作都重新验证 owner、tab、origin、lease 状态与 Stop 状态。

### 3.2 Document epoch 与 opaque ref

Provider 不把 CSS selector、XPath 或 CDP backend node ID 直接交给模型。观察时，它把 AX 节点映射成随机 opaque ref，并在内部绑定：

~~~text
ref -> backendNodeId + role + accessibleName + documentEpoch
~~~

导航、文档替换、同名节点替换或 ref 缓存失效后，旧 ref 会得到 <code>STALE_TARGET</code>，不会自动落到页面上的另一个同名元素。

### 3.3 Frame target

子帧使用 <code>{ frameId, documentEpoch }</code> 显式定位。<code>frameId</code> 是不暴露 CDP session/context 的 opaque 标识。只有目标 frame 及其全部祖先都与 lease 根页面同源，内容读取和已支持的子帧动作才会继续；cross-origin、opaque 或“同源孙帧位于跨域祖先后面”的情况都拒绝。

### 3.4 Continuation

大页面分页 token：

- 与 owner、lease、document、frame、root scope 绑定；
- 单次使用；
- 2 分钟过期；
- 导航、Stop、scope 变化、root 身份变化或重复使用时 fail closed；
- 它只是读取进度，不会授予新的访问权。

### 3.5 requestId 与 Action Journal

所有动作都有唯一 <code>requestId</code>。Broker 在输入发出前持久化 dispatch intent；重复 <code>requestId</code> 返回历史结果/恢复元数据，不会再次点击。若输入已经发出、但响应或确认丢失，结果是 <code>unknown + dispatched</code>，调用方必须先重新观察，不能换一个 requestId 盲目重试。

## 4. 观察链路是怎么实现的

### 4.1 普通观察时序

~~~mermaid
sequenceDiagram
    autonumber
    participant A as DSH Agent
    participant D as DSH Adapter
    participant B as Broker / Runtime
    participant P as Chromium Provider
    participant E as MV3 Extension
    participant C as Chrome CDP
    participant W as Web Page

    A->>D: browser_observe(leaseId, scope/query/frame/cursor)
    D->>B: RPC + owner scope
    B->>B: 校验 owner、lease、origin；按 tab 串行
    B->>P: observe(lease, options)
    P->>E: ax.read / ax.find / ax.frame.*
    E->>C: Accessibility / DOM 有界命令
    C->>W: 读取当前文档或已验证子帧
    W-->>C: AX nodes
    C-->>P: 有界 AX 数据
    P->>P: 映射 opaque refs；过滤敏感值；应用预算
    P->>P: 再校验 document、origin、frame ancestry
    P-->>B: snapshot/delta + epoch + refs + truncated
    B-->>D: 有界结果
    D-->>A: JSON tool result
~~~

### 4.2 为什么观察比较快

默认观察不是“把整个网页吐出来”，而是执行预算化投影。目前 Provider 的主要上限包括：

- 最多约 120 个普通控件；
- 最多 24 个命名区域；
- 最多 240 段文本且文本总量不超过 32 KiB；
- 节点 JSON 预算约 40 KiB；
- ref 使用有界 LRU，不允许大页面无限吃内存；
- password value 永不从 AX 暴露；
- 返回 <code>truncated</code> 明确告诉调用方当前视图不完整。

对于后续变化，Runtime 会在相同 document/scope 基础上生成 delta；base、document 或 scope 对不上时返回 <code>resyncRequired</code>，不会伪造可应用的增量。

精确查找使用 accessible name 的大小写精确匹配，可附加 role；它只返回候选，不会在出现多个同名元素时擅自点第一个。

### 4.3 大页面与子帧分页时序

当前工作树正在把根页面已经存在的 page-window 机制完整扩展到 same-origin child frame：

~~~mermaid
sequenceDiagram
    autonumber
    participant A as DSH Agent
    participant R as Runtime Core
    participant P as Chromium Provider
    participant F as FrameSessions
    participant G as Frame Node Scope
    participant X as AXPager
    participant E as MV3 / CDP

    A->>R: browser_frames(lease)
    R-->>A: opaque frameId + child documentEpoch
    A->>R: browser_read_page(frame, rootRef?, continuation?)
    R->>R: sameOriginFrame：前置校验完整祖先链
    R->>P: readPage(lease, frame scope)
    P->>F: 解析 child session/context/source binding
    P->>G: 绑定 child document/object/root identity
    P->>X: read(binding, continuation?)
    X->>E: ax.frame.page（只取当前窗口）
    E-->>X: nodes + next cursor + incomplete
    X->>X: token 绑定 lease/doc/root 且标记已消费
    X-->>P: bounded window
    P->>R: 再查 frame inventory 与 child epoch
    R->>R: 后置校验完整祖先链
    R-->>A: page[index] + child refs + continuation?
~~~

这里的两次 same-origin 校验很重要：第一次防止未授权读取，第二次防止读取期间发生导航或 frame replacement 后，把旧内容错误发布给 DSH。

<code>withFrameNodeScope</code> 还会把 child document、远端 object 和可选 root 节点绑定在同一个作用域内，防止“同名 root 被替换”或“节点被 adopt 到同源兄弟文档”后 continuation 继续工作。

## 5. 动作链路是怎么实现的

### 5.1 核心时序

~~~mermaid
sequenceDiagram
    autonumber
    participant A as DSH Agent
    participant D as DSH Adapter
    participant B as Broker
    participant R as Runtime Core
    participant P as Chromium Provider
    participant E as MV3 Extension
    participant C as Chrome / Page

    A->>D: browser_act(requestId, leaseId, epoch, action)
    D->>A: 请求本次变更审批
    A-->>D: allowed-once
    D->>B: 本地 RPC + owner token
    B->>B: 校验 owner/lease；查询 journal
    B->>R: 在 tab 队列中串行执行
    R->>P: act(lease, current request)
    P->>P: ref -> backend node；核对 epoch/role/name
    P->>E: 读取实时 AX、DOM object、geometry
    E->>C: allowlisted CDP inspect
    C-->>P: connected/actionable/stable hit target
    P->>B: 在输入前持久化 dispatch intent
    P->>E: dispatch input exactly once
    E->>E: 再校验 Stop/lease/tab/method/params
    E->>C: Input.dispatch* / Runtime.callFunctionOn
    C-->>P: 页面产生实际效果
    P->>C: 有界 observe，等待 expected postcondition
    C-->>P: passed / failed / timeout / stale
    P->>B: settle journal
    B-->>A: outcome + dispatch + postcondition + provenance
~~~

完整交互版：[Verified Browser Action Lifecycle](./action-lifecycle.sequence.html)。

### 5.2 点击前为什么不容易误点

Provider 在输入前按顺序完成：

1. 用当前 document epoch 查回 opaque ref；
2. 用 backend node ID 取回 DOM object；
3. 重读 AX 身份，确认 role/name/节点没有被偷偷替换；
4. 检查 connected、disabled、可见尺寸、viewport 与滚动状态；
5. 必要时在允许范围内滚动，再重新测量；
6. 在目标点做 hit test，确保实际命中的还是目标或可接受的后代；
7. 把 dispatch intent 写入 journal；
8. 仅发送一次 CDP 输入；
9. 用显式 <code>expected</code> 或动作类型的内建规则验证结果。

对 fill/append/check/press 等操作还有独立语义验证，例如：

- <code>fill</code> 验证最终完整值；
- <code>append</code> 先绑定原前缀，再验证完整组合值，避免页面中途改值；
- checkbox/switch/radio 最多点击一次并核对最终 checked state；
- scroll 返回前后真实 offset；
- wheel 只发一个真实 CSS 像素样本，没有可观察反馈时保持 <code>unknown</code>；
- state expectation 绑定原节点，页面创建一个同名替代节点不能冒充成功。

### 5.3 结果状态不是普通的成功/失败二元组

| outcome | 含义 | 是否可直接重试 |
|---|---|---|
| <code>succeeded</code> | 输入已发出，postcondition 已观察到 passed | 不需要 |
| <code>failed</code> | 通常是输入未发出前已经确定失败，或明确观察到反向结果 | 先修正请求 |
| <code>cancelled</code> | 用户取消、lease revoked 或 Stop，且按返回元数据判断是否曾 dispatch | 重新获取授权后再判断 |
| <code>unknown</code> | 可能已经产生副作用，但确认失败、超时、连接丢失或状态发生竞争 | **绝不能盲目换 requestId 重试** |

<code>unknown</code> 是这套实现避免“双击付款、重复提交”的关键语义，不是一个可以忽略的错误。

## 6. iframe 尾页故障与已落地修复

child-frame paging 可以分页穿过包含 4000 个控件的 same-origin 子帧。最初最后一个目标虽然收到一次 <code>isTrusted === true</code> 的点击，完整 native smoke 却在动作结果确认阶段失败：默认 <code>observeFrame()</code> 的有界读取看不到深处反馈。

~~~mermaid
sequenceDiagram
    participant T as Native Smoke
    participant P as Child AX Pager
    participant A as Action Pipeline
    participant W as Child Web Page
    participant Q as Bound ax.frame.text
    participant O as Frame observation

    loop 分页直到最后一页
        T->>P: continuation
        P-->>T: bounded child controls + next token
    end
    T->>A: click(lastRef, expected text)
    A->>W: 单次 trusted click
    W->>W: hits=[true]，feedback=true
    A->>Q: 在同一 child document 定向确认 expected text
    Q->>Q: 校验最多 128 个候选的文档归属与 AX identity
    Q-->>A: {present:true}
    A->>O: 获取保持 frame scope 的有界结果视图
    A-->>T: succeeded（同 requestId 不重放点击）
~~~

修复后的边界是：

- 输入仍然最多一次；确认失败绝不会触发第二次点击；
- 非空且不超过 1000 UTF-16 单元的文本期望优先走内部 <code>ax.frame.text</code>，它只接受已绑定 child document 和文本，不接受 session、脚本、坐标或对象句柄；
- 查询候选逐个验证仍属于同一 child document，并只向 Provider 返回 <code>{present:boolean}</code>；
- 定向查询为阴性或不适用时仍保留原有有界 observation substring 回退；
- 动作返回的 observation 继续保持 <code>scope:{kind:'frame',frameId}</code>，不会把查询结果伪装成整帧快照或污染 delta cache。

2026-09-15 的 Chrome for Testing 151 和 Edge 153 隔离全链路都已通过：4000 控件、81 个窗口、尾页 trusted click、反馈确认、请求去重、scope/token/reorder/replacement/adoption 拒绝、导航、Stop 与重新授权失效检查全部成功。它证明这个受控缺陷已闭环，但不等于真实网站、日常登录 Profile、模型或 Codex 同等水平已经验收。

## 7. Screenshot 与视觉理解

<code>browser_screenshot</code> 不是绕过权限的备用通道。当前实现会：

1. 验证 lease 与当前 document；
2. 读取 frame tree；只要截图中存在未经批准的跨域 frame 就拒绝；
3. 读取 visual viewport；
4. 通过 <code>Page.captureScreenshot</code> 采集 JPEG（quality 70、只截 viewport、宽度上限按 1200 缩放）；
5. 再次验证 document、frame tree 和 viewport 没有变化；
6. 限制传输体积，随后由 Adapter 的 ScreenshotRegistry 绑定 owner/lease 并发布附件。

因此视觉模型负责“理解像素”，本插件负责“安全、稳定地得到与当前 tab/epoch 对得上的像素”。<code>dsh-vision-router</code> 可以作为上层视觉路由，但它不应该替代 ref、lease、postcondition 和 journal 这些控制语义。

目前已经有 <code>test:vision-router</code> 集成 smoke；但真实日常登录账号、云端视觉模型和人工审批 UI 组成的生产级全链路，还没有被当前证据完整覆盖。

## 8. 为什么后续能扩展到 Edge

Chrome first 不等于架构写死 Chrome。扩展点已经放在 Provider 契约和能力协商上：

~~~mermaid
flowchart TD
    DSH[DSH Adapter]
    Broker[Broker + Runtime Core]
    API{{BrowserProvider Contract}}
    ChromeP[Chromium Provider<br/>Chrome policy/profile]
    EdgeP[未来 Edge Provider<br/>Edge policy/profile]
    OtherP[未来其他浏览器 Provider]
    ChromeE[Chrome MV3 + Native Host]
    EdgeE[Edge Extension + Native Host]

    DSH --> Broker --> API
    API --> ChromeP --> ChromeE
    API -. capability negotiation .-> EdgeP --> EdgeE
    API -. browser-specific adapter .-> OtherP
~~~

可复用部分：

- DSH 工具契约与审批；
- owner/lease/Stop 状态机；
- per-tab 串行化；
- action journal 与 exactly-once bias；
- outcome/postcondition/recovery 语义；
- observation/page-window/frame 的公共数据模型；
- wire 版本与 capability negotiation；
- 大部分测试夹具与行为契约。

浏览器特定部分：

- 扩展 manifest、权限和商店打包；
- Native Host 注册路径；
- tab/profile 枚举；
- debugger/CDP 兼容差异；
- frame/OOPIF 行为差异；
- 安装、诊断与签名策略。

当前 Broker 只接受 <code>family: chromium</code>；能力表已经显式报告 <code>oopif: false</code>。Edge 目前有隔离 smoke 和兼容证据，但尚未作为正式支持目标，不能只换一个品牌字符串就宣布完成。

## 9. 安全边界

当前实现的重要边界：

- 本地 socket 在准备后设为 <code>0600</code>；连接先 token 握手，再分 client/provider 角色；
- Native Messaging 目录必须由当前用户所有，且不能被其他用户写；
- 只有扩展中用户允许的 tab 才能出现在可 claim 列表；
- lease 固定 owner、tab 与 root origin；
- Extension 在最靠近 Chrome 的位置再次检查 Stop、lease、tab 和命令白名单；
- AX/DOM/CDP 原始大对象不直接交给模型，只返回预算化投影；
- cross-origin/opaque child frame 内容默认拒绝；
- screenshot 对 frame tree 使用更严格的全同源策略；
- 所有 wire 输入做严格 schema/长度/数值检查；
- post-dispatch 不确定性不会被自动重放。

## 10. 当前能力与缺口

### 已实现并有自动化覆盖

- DSH 工具注册、owner 隔离、claim/handoff；
- Chrome MV3 <code>chrome.debugger</code> attach 与 Native Messaging 主链路；
- AX 观察、subtree、精确 accessible-name query、delta；
- root document page windows；
- click/fill/append/check/press/scroll/wheel/navigate；
- actionability、stable hit test、显式 postcondition；
- batch 串行执行、逐步审批、中途失败停止；
- journal 防重放与 crash recovery 语义；
- same-origin frame 发现、读取、query、subtree、same-process click；
- bounded screenshot 与 DSH attachment；
- child-frame page windows 的核心读取、scope 和 continuation 机制。

### 仍在进行中或明确不支持

- 大型 child-frame 尾页动作的 scoped result verification，当前 smoke 失败；
- cross-origin child 内容/动作；
- OOPIF 输入几何，当前 capability 明确为 false；
- 子帧 fill/check/keyboard/scroll/wheel 等完整动作矩阵；
- Edge 正式产品化支持；
- 文件上传、下载、浏览器对话框、多标签页编排、IME；
- 日常 signed-in Chrome profile + 真实人类审批 UI + 实际模型的生产 acceptance；
- 与 Codex 的完全同等能力声明。

## 11. 当前验证证据

2026-09-15 的最近一次本地验证：

| 验证 | 结果 | 说明 |
|---|---:|---|
| <code>pnpm check && pnpm typecheck && pnpm test</code> | 502 passed / 0 failed | 静态边界、类型、单元与行为测试 |
| <code>pnpm test:chrome</code> | 90 passed | Chrome Stable 152.0.7977.84，真实 Provider/CDP 语义 |
| <code>pnpm test:extension</code> | 15 passed | Chrome for Testing 151.0.7922.10，真实 MV3 + chrome.debugger |
| <code>pnpm test:native &lt;dsh-path&gt;</code> | 105 passed | DSH ToolRuntime → Broker → Native Host → MV3 → 页面 |
| <code>pnpm test:frame-page-native</code> | Chrome/Edge 均通过 | 各 7 组：4000 控件、81 窗口、尾页 trusted click、离窗反馈确认、失效与清理 |

报告位于：

- <code>output/playwright/chrome-smoke.json</code>
- <code>output/playwright/mv3-smoke.json</code>
- <code>output/playwright/native-smoke.json</code>
- <code>output/playwright/chrome-frame-page-native-smoke.json</code>
- <code>output/playwright/edge-frame-page-native-smoke.json</code>

需要注意：上述 native 测试使用隔离的 Chrome profile 和可控审批服务。当前日常 DSH Web profile 中，旧浏览器插件已卸载，<code>dsh-native-browser</code> 还没有正式安装进去；所以“项目完整测试链路可运行”不等于“日常 DSH 已经可以直接调用”。

## 12. 代码导航

建议按下面顺序阅读：

1. <code>packages/contracts/src/index.ts</code>：公开数据结构、动作、结果和错误；
2. <code>packages/dsh-adapter/src/index.ts</code>：DSH 工具入口与审批边界；
3. <code>packages/broker/src/server.ts</code>：RPC、角色、owner、Provider 注册；
4. <code>packages/runtime-core/src/runtime.ts</code>：lease、串行化、observe/act/batch 状态机；
5. <code>packages/provider-chromium/src/provider.ts</code>：AX refs、动作执行与结果验证；
6. <code>packages/provider-chromium/src/actionability.ts</code>：几何与命中检查；
7. <code>packages/provider-chromium/src/ax-pager.ts</code>：single-use continuation；
8. <code>packages/provider-chromium/src/frame-sessions.ts</code>：frame/session/context 图；
9. <code>packages/provider-chromium/src/frame-node-scope.ts</code>：child document/root identity fence；
10. <code>packages/provider-chromium/src/frame-page.ts</code>：child page-window 读取；
11. <code>packages/provider-chromium/src/frame-text.ts</code>：大型 child document 的定向文本 postcondition；
12. <code>packages/extension-core/src/background.ts</code>：最后一公里 CDP 网关；
13. <code>packages/broker/src/action-journal.ts</code>：防重复副作用；
14. <code>scripts/smoke-native.mjs</code> 与 <code>scripts/smoke-frame-page-native.mjs</code>：完整链路证据与尾页回归。

## 13. 本地复现命令

~~~bash
cd /Users/sd/likunlong/longmiaoo/dsh-native-browser

pnpm check
pnpm typecheck
pnpm test
pnpm test:chrome

DSH_CHROME_TEST_EXECUTABLE='/Users/sd/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  pnpm test:extension

DSH_CHROME_TEST_EXECUTABLE='/Users/sd/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  pnpm test:native /Users/sd/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh

DSH_CHROME_TEST_EXECUTABLE='/Users/sd/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  pnpm test:frame-page-native /Users/sd/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh
~~~

最后一条现在应输出七组通过结果并生成 Chrome 报告；设置 <code>DSH_TEST_BROWSER_BRAND=edge</code> 且把可执行文件换为 Edge 可复跑共享 Chromium 路径。

## 14. 架构判断

当前方向是对的：它已经把“浏览器控制”拆成了可移植的控制平面和 Chromium 执行平面，也把准确性从“尽量找到一个元素”提升为“必须证明是当前文档里的同一个语义节点，并证明动作结果”。这正是后续逼近 Codex 丝滑程度时应该保留的核心。

大型 child-frame 的 scoped postcondition verification 已闭合为“看见目标 → 单次输入 → 在同一 child document 定向确认 → 返回 frame-scoped 观察”。下一阶段应把同样的证据边界扩展到动态/虚拟化页面、OOPIF 几何与更丰富的 child action，同时开始真实模型和日常 Profile 的明确 opt-in 验收，而不是据此提前宣称 Codex 同等水平。

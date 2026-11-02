# 无需填写 Profile 的浏览器配置入口

版本：`0.1.1` 新增；`0.1.0` 不含此入口。

## 用户路径

1. 在自己正在使用的 DSH 应用中，从插件市场安装 DSH Native Browser；按 DSH 的提示重载插件或应用。
2. 进入 **设置 → 浏览器配置**，点击 **完成浏览器配置**。
3. 安装器验证 DSH 的运行时，暂存扩展到固定目录、注册 Native Messaging、安装或更新用户级后台服务，打开 Chrome 扩展页和 Finder。
4. 在 Chrome 开启开发者模式，点击“加载已解压的扩展程序”。在目录选择器按 **⌘⇧G**，粘贴配置页复制的扩展目录并选择。
5. 回到配置页点击 **检查连接**，再开始聊天。标准安装的后台为个人模式，无需逐页点击授权；只有受限模式才需要在扩展弹窗允许目标标签页。`0.1.1` 的旧页面仍会无条件提示逐页授权，这是下方记录的已修复文案问题。

新路径不需要输入 `web`、`desktop` 或 `browser-lab`。插件市场负责在当前 DSH 环境安装插件；设置页直接调用该环境内已经加载的插件。配置使用插件自身的 `runtimeDirectory` 或默认运行目录，不扫描或猜测其他 Profile。

安装只影响运行 DSH 的主机。通过网页远程连接另一台机器的用户，不能用此按钮配置面前的电脑。自动安装仍仅支持 macOS。

## 为什么还保留 Chrome 的确认

当前交付的是 npm 随包提供的未打包扩展。Chrome 官方给开发者的路径是开发者模式下加载目录；针对普通 macOS/Windows 用户的正式分发渠道是 Chrome Web Store，商店外托管安装受企业策略限制。

使用桌面自动化可以代点按钮，但会增加系统控制权限要求，并受窗口、语言、Chrome 版本等影响。本插件没有把这类自动化作为默认安装依赖。

来源：

- [Chrome 扩展分发方式](https://developer.chrome.com/docs/extensions/how-to/distribute)
- [官方加载未打包扩展步骤](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)

## 后续商店分发

下一阶段目标是 **DSH 内配置本机组件 → 打开真实商店条目 → 用户点击“添加至 Chrome”确认 → 自动检查连接**。这会移除目录选择和开发者模式要求，并利用 Chrome 的扩展更新机制。

这部分尚未实现，不能把商店链接占位符当作已经上架。实施时需：

- 完成开发者账号、扩展审核资料、隐私政策和实际商店条目。
- 获取并核验商店扩展 ID；Native Messaging 白名单、当前稳定开发版 key 和迁移路径必须保持一致或明确迁移。
- 在安装器返回的分发信息中区分 `unpacked` 和 `web-store`；UI 展示对应步骤。商店入口只允许项目维护的固定链接，不能由模型或网页提供安装 URL。
- 保持 Broker/扩展的协议版本协商，验证商店扩展自动更新早于或晚于 npm 插件更新时的兼容行为。
- 为已经从固定目录加载扩展的用户提供迁移说明，不能让两个版本同时接管同一个目标。

用户对 Chrome 安装权限的确认会保留；企业受管设备的强制部署不属于普通个人安装流程。

## 实现边界

客户端使用 DSH 的 `settings.section` 插槽和宿主提供的 React。原有前台会话切换桥接继续保留。使用最新 DSH 设置插槽的部署会出现“浏览器配置”；不提供该插槽 API 的旧客户端仍需使用文档中的安装方式。

新版宿主使用 Connection 的 `/api/dsh-native-browser/<端点>` 精确路由，由宿主负责登录鉴权、请求来源和 owner 身份校验；不占用 API Gateway 的共享拦截器。不提供精确路由 API 的旧宿主保留 `/dsh-native-browser` RPC 通道。客户端仅在明确返回路由不存在时回退，不会在鉴权失败或超时后重发安装请求。

| 端点 | 参数 | 行为 |
| --- | --- | --- |
| `setup.status` | `{}` | 只读诊断、固定目录、是否已暂存扩展、是否正在安装 |
| `setup.install` | `{ "confirmed": true }` | 明确点击后执行安装；同目录并发请求复用一次操作 |
| `setup.open` | `{}` | 检查已暂存扩展的 ID，再打开固定 Chrome 扩展页和目录 |

没有增加模型可调用的安装工具。客户端不能传入 Profile、可执行文件、目录、浏览器种类或 URL。未知字段和无确认的安装请求会被拒绝；不支持的平台在修改前返回错误。安装器原有的目录所有权、服务归属和文件写入校验继续生效。

在安装前检测当前宿主可执行程序的 Node 版本及 `node:sqlite`。DSH Desktop 的 Electron 通过其支持的 `ELECTRON_RUN_AS_NODE=1` 模式启动；这个模式同时写入 Native Messaging 启动器和 LaunchAgent，使 Chrome/登录服务启动时也有效。不会寻找或执行工作区中的 `node`，也不安装全局运行时。

原先 standalone Node 启动器仍能识别、升级和卸载。后台服务采用现有个人 Broker 模式；安装不会更改 DSH 的 `approvalMode`、批准标签页、恢复租约或关闭 Stop 功能。更新已有服务会重启该服务；升级后需要重新连接，已有动作可能中断。

页面首次打开只检查状态；关闭页面不会撤销已开始写入的配置。重新打开后可检查状态。另一个运行目录在同一宿主内安装时会返回忙碌错误；跨进程继续由现有安装锁和服务归属校验保护，不承诺整个安装流程是跨进程事务。

## 验证记录（2026-10-30）

- `pnpm check`：元数据和架构边界通过。
- `pnpm test`：591 项通过，0 失败、0 跳过。覆盖只读状态、确认参数、路径拒绝、重复请求、运行目录冲突、失败后重试、取消、Electron 启动器兼容及适配器 RPC 接线。
- `scripts/smoke-setup-ui.mjs`：使用 DSH `0.2.1-rc.3` 的真实 SlotCore、共享 React `18.3.1`、ReactDOM `18.3.1` 和隔离 Chrome `153.0.8010.12`。实际点击首次安装、重复安装、重新打开和检查连接；使用真实安装器写入临时目录，身份令牌保持不变；没有页面异常。
- `scripts/smoke-setup-desktop.mjs`：在本机 DSH NEXT 的 Electron `44.7.0` / Node `24.21.0` 内运行。真实生成并启动 Native Messaging 启动器，即使子进程不继承 Electron 环境变量仍能完成 Broker 握手和标签查询，诊断为 `ready`。首次运行有一次 5 秒 RPC 超时；加入阶段诊断后的两次运行通过，尚不能据此给出首次冷启动时延保证。

- `scripts/smoke-setup-host.mjs`：完整 DSH Web `0.2.1-rc.3` 外壳和真实 Connection 服务。由 npm 打包安装插件后打开“设置 → 浏览器配置”，读取初始状态、点击检查连接、验证前台会话通知。未登录请求返回 401，跨来源请求返回 403，无确认安装返回业务拒绝。没有页面异常。该测试发现并修复了旧独立 RPC 路由在真实宿主中触发 `webServer` 依赖错误的问题。
- `pnpm test:package-install`：新装、重复安装、alpha.10 升级、宿主卸载/重装、稳定 ID/路径和身份保持通过。
- `pnpm test:installation /path/to/installed-dsh`：打包后的插件通过真实 DSH ToolRuntime、macOS LaunchAgent、Native Messaging 和隔离 Chrome 完成中文输入、点击、截图、公开网页读取、标签创建/关闭、虚拟鼠标和 Stop 验收，测试资源已清理。

验证边界：完整 Web 外壳测试只检查配置状态及拒绝路径，不点击会改动本机注册/服务的安装按钮；真实安装写入由隔离组件测试和安装验收覆盖。Desktop 已验证其运行时与启动器，但未替换用户日常 Desktop 插件或验收整个 Desktop 设置外壳。浏览器动作使用确定性工具调用，不能代替任意模型的端到端成功率测试。

复现 UI 测试（设置 `DSH_CHROME_TEST_EXECUTABLE` 为测试版 Chrome，使用隔离浏览器）：

```sh
pnpm build
node scripts/smoke-setup-ui.mjs /path/to/installed-dsh /path/to/react-dom-test-dependencies
```

第三个路径仅在 DSH 分发目录没有独立 ReactDOM 包时需要；测试渲染器使用 ReactDOM `18.3.1`，React 始终从宿主分发目录解析。产物位于 `output/playwright/setup-ui.png` 和 `setup-ui.json`。

验证 Desktop 的安装启动器：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT' scripts/smoke-setup-desktop.mjs
```

产物为 `output/playwright/setup-desktop.json`；测试不修改用户的 Chrome 注册目录或登录服务。


完整 Web 设置外壳验收（先启动已安装本次打包插件的隔离 DSH Web，配置临时 `runtimeDirectory`，把启动日志保存到临时文件）：

```sh
DSH_CHROME_TEST_EXECUTABLE=/path/to/test-chrome node scripts/smoke-setup-host.mjs /tmp/isolated-dsh-launch.log
```

日志包含临时登录链接，勿公开。测试只在隔离浏览器内使用它，不将链接、认证信息或配置路径写入报告。产物为 `output/playwright/setup-host.png` 和 `setup-host.json`。


## 个人模式一致性修复（0.1.2，2026-11-02）

`0.1.1` 安装器启动个人模式 Broker，而适配器缺省 `per-action`，导致安装完成后仍逐次审批；页面还无条件提示逐页授权。`0.1.2` 将适配器缺省值统一为 `personal`，并在每次连接/重连的握手阶段验证后台支持个人模式，在不匹配时拒绝发送任何浏览器操作。

状态响应新增 `policy.approvalMode` 与 `policy.browserAccessMode`：前者来自适配器实际配置，后者来自经过验证的实时 Broker 握手；离线或旧响应为 unknown，不根据安装路径猜测。个人模式提示可直接聊天，受限模式才要求弹窗授权；显式逐次审批会独立显示，不把后台个人模式等同于已取消宿主审批。安装按钮继续不修改 DSH 全局权限或已有显式插件审批设置。

本地验证：598 项测试通过；真实 SlotCore/React 设置页覆盖个人、逐次、受限、模式不匹配与未知状态。已打包插件通过真实 Chrome 153.0.8010.12、Native Messaging 和 DSH 0.2.1-rc.3 工具运行时验证默认配置，无逐页 allow 调用，连续输入/点击/截图、多标签页、Stop 与前台会话撤销通过。使用 `scripts/smoke-installation.mjs /path/to/dsh --no-service` 避免干扰正在运行的用户 LaunchAgent；没有模型调用或日常浏览器账户测试。

`0.1.1` 的现有安装可先添加插件配置 `approvalMode: personal` 并重载 DSH，无需重新安装扩展。此临时配置不会改变旧版页面的提示文字。

## 键盘鼠标反馈与切换会话回归（0.1.2，2026-11-02）

用户的百度搜索/阿里云页面会话中，记录到 6 次 `LEASE_REVOKED`，其中一次接管后约 7 秒失败，早于 120 秒租约到期。用户确认测试中切换过对话或 DSH 窗口。旧实现只释放旧会话的现有租约，没有阻止仍运行的旧模型再次申请接管；这是可重复验证的交接缺口。历史记录没有记录每次释放的来源，不能把所有失败都归因为切换，也不能声称重放已经复现全部现场。

修复后，收到前台会话更新就同时限制新工具调用：后台会话得到明确的停止浏览器工作提示，不能再次 claim/open；用户切回后可以申请新租约，旧租约不会复活。可见但未获得焦点的 DSH 窗口不再发送前台声明，获得焦点时重新同步选择。插件只能拒绝自己的工具，无法技术上阻止模型调用其他插件或 Bash；错误说明明确要求不要绕过交接继续操作。

旧版鼠标仅响应真实点击/滚轮。本次现场使用的是输入、回车和读取，且没有调用 activate。新增输入/按键的实际焦点控件反馈，不合成鼠标点击；页面读取不伪装成点击，指针仍只显示在目标 Chrome 页面，不会浮在 DSH 聊天窗口。工具说明要求需要展示的浏览任务先激活目标标签页，但未更改默认后台建页行为。

新增验收：真实打包安装后，在任何点击之前通过填充显示指针，按键后保留，交还后移除；后台重新接管被拒绝，切回后重新接管与 Stop 通过。截图：`output/playwright/installation-keyboard-pointer.png`。首次与全量测试并行运行时原生握手超时；单独重跑通过，测试错误路径已避免不存在的服务日志掩盖原始错误。此验收使用隔离 Chrome 153，未替换用户 Chrome 156 中的扩展，不构成用户 Chrome 156 的现场验证。

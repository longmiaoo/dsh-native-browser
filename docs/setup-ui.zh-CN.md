# 无需填写 Profile 的浏览器配置入口

状态：开发分支实现，尚未发布；npm `0.1.0` 不含此入口。

## 用户路径

1. 在自己正在使用的 DSH 应用中，从插件市场安装 DSH Native Browser；按 DSH 的提示重载插件或应用。
2. 进入 **设置 → 浏览器配置**，点击 **完成浏览器配置**。
3. 安装器验证 DSH 的运行时，暂存扩展到固定目录、注册 Native Messaging、安装或更新用户级后台服务，打开 Chrome 扩展页和 Finder。
4. 在 Chrome 开启开发者模式，点击“加载已解压的扩展程序”。在目录选择器按 **⌘⇧G**，粘贴配置页复制的扩展目录并选择。
5. 在目标普通网页打开扩展弹窗，允许目标标签页；回到配置页点击 **检查连接**，再开始聊天。

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

服务端沿用 Connection 的 `trusted-host` RPC 通道 `/dsh-native-browser`：

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
- `pnpm test`：588 项通过，0 失败、0 跳过。覆盖只读状态、确认参数、路径拒绝、重复请求、运行目录冲突、失败后重试、取消、Electron 启动器兼容及适配器 RPC 接线。
- `scripts/smoke-setup-ui.mjs`：使用 DSH `0.2.1-rc.3` 的真实 SlotCore、共享 React `18.3.1`、ReactDOM `18.3.1` 和隔离 Chrome `153.0.8010.12`。实际点击首次安装、重复安装、重新打开和检查连接；使用真实安装器写入临时目录，身份令牌保持不变；没有页面异常。
- `scripts/smoke-setup-desktop.mjs`：在本机 DSH NEXT 的 Electron `44.7.0` / Node `24.21.0` 内运行。真实生成并启动 Native Messaging 启动器，即使子进程不继承 Electron 环境变量仍能完成 Broker 握手和标签查询，诊断为 `ready`。首次运行有一次 5 秒 RPC 超时；加入阶段诊断后的两次运行通过，尚不能据此给出首次冷启动时延保证。

UI 验证是实际组件和真实 DSH 插槽内核的隔离验证，尚未替换用户日常 Desktop 插件，也不等同于完整 Desktop 设置外壳的发布验收。UI 测试不注册用户 LaunchAgent；Desktop 测试使用协议提供者夹具，不能当作真实 Chrome 操作验收。正式发布前仍需完整宿主内的安装/升级验收。

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

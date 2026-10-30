# 安装、升级与故障处理

0.1.0 的正式支持范围为 macOS + Chrome。Node.js ≥ 22.19、pnpm 11、可正常对话的 DSH 是前置条件。Edge、Linux/Windows 完整安装和 Chrome 网上应用店分发尚未纳入正式支持。

## 安装

使用 DSH 当前正在运行的 Profile。以下以 `web` 为例；如果使用 `desktop` 或 `browser-lab`，一致替换两处名称：

```sh
dsh plugin --profile web add dsh-native-browser@0.1.0 && dsh plugin --profile web exec dsh-native-browser install --browser=chrome
```

这条命令安装 DSH bundle，暂存固定扩展目录，注册当前用户的 Native Messaging Host，安装并检查 LaunchAgent Broker，再打开 Chrome 扩展页及 Finder。安装完成不会自动批准任何标签页，也不会修改 DSH 的审批模式。

Chrome 首次加载需要你确认：在 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”。在目录选择窗口按 Command+Shift+G，粘贴安装器输出的完整目录，回车并选择。该快捷键可以直接进入隐藏目录。

重启对应 DSH Profile，在 Chrome 普通网页打开扩展，选择“允许当前标签页并连接”。在 DSH 输入：

> 使用 native_browser 工具读取刚才授权页面的标题和主要内容，然后交还浏览器控制。

默认采用逐动作审批。确认首次连接正常后，可选择 README 中的 `per-lease` 或显式的 `personal` 模式。运行目录、DSH Profile、Chrome profile 是三个概念：插件装在 DSH Profile 中；Chrome profile 决定登录状态和扩展安装位置；Broker 使用一个私有运行目录。自定义 `--runtime-dir` 时，DSH 的 `runtimeDirectory` 必须一致。

## 升级

重复安装命令，重载 Chrome 扩展，然后重启 DSH Profile。固定扩展目录不会跟随 npm 包目录变化。

从 Alpha 迁移时，先停止旧终端中的手工 Broker；在 Chrome 移除原先从 npm/源码路径加载的扩展，再加载安装器输出的新目录。之后的升级使用该固定目录即可。旧的稳定 key 保持不变；移除并重载扩展后，需要重新授权标签页。首次升级时 Chrome 的调试提示是 `debugger` 权限的正常表现。

标准工具名已从 `browser_*` 改为 `native_browser_*`。更新旧任务提示词；确实需要旧别名时，在已有 `native-browser` 配置中显式加入 `legacyToolNames: true`。与其他插件冲突的旧别名会跳过，标准名称仍然注册。

## 故障对应表

| 现象 | 下一步 |
|---|---|
| 找不到扩展目录 | 在“加载已解压”目录窗口按 Command+Shift+G，粘贴 install 输出的完整路径；不要只输入父目录。 |
| 插件市场显示已安装，聊天没有工具 | 检查安装的 DSH Profile 是否与当前运行的 Profile 相同，然后重启该 Profile；新工具名以 `native_browser_` 开头。 |
| 提示手工 Broker 正在占用 | 在旧 Broker 终端按 Ctrl+C 后重新 install；不删除 socket、锁数据库或运行状态。 |
| 提示服务属于其他 runtime | 使用原来的 `--runtime-dir` 卸载原服务，再切换目录。不要覆盖其他会话的后台服务。 |
| doctor 的 browser-connection 为 NO_MATCHING_BROWSER | 检查扩展是否加载在目标 Chrome profile，并在普通网页打开弹窗授权连接。 |
| doctor 的 broker/socket 检查失败 | 用 `service-status` 检查 LaunchAgent；查看 install 输出的运行目录下 broker.stderr.log。确认 Node 路径未移动后重跑 install。 |
| doctor 为 ready，但读不到标签页 | ready 只代表组件健康；目标标签页还需扩展授权，DSH 还需接管该标签页。 |
| 同时安装多个浏览器插件后，模型选错工具 | 提示“使用 native_browser 工具”；标准命名已隔离，但模型仍可能选择其他插件的同类工具。 |
| 虚拟鼠标没出现 | 虚拟指针在真实点击/滚轮分发后显示；HTTP 页面需在弹窗中单独授予可选 HTTP 指针权限。Chrome 内部页面不支持注入。 |
| 页面截图看不懂 | 使用支持图片输入的模型，或单独配置可选视觉插件；浏览器插件自身不运行图像识别模型。 |
| 切换 DSH 会话后原任务报失去控制 | 这是控制撤销机制；新会话需要重新接管，控制权不会直接转移。 |

```sh
dsh plugin --profile web exec dsh-native-browser doctor --browser=chrome
dsh plugin --profile web exec dsh-native-browser service-status
```

`ready` 不是网站任务成功保证。分享诊断时只提供脱敏内容，不公开 auth-token、Cookie 或真实账户页面。

## 卸载

在删除 npm 插件前执行：

```sh
dsh plugin --profile web exec dsh-native-browser uninstall --browser=chrome
```

再从 Chrome 移除扩展，从 DSH 插件管理器卸载插件。卸载保留运行状态和固定扩展目录，不关闭用户页面；其他 runtime 的服务不会被停止。需要完全删除本地文件时，先核对运行目录中是否还有需要保留的状态，手动删除属于本插件的目录。

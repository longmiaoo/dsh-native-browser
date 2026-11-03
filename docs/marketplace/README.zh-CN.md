# 插件市场展示更新

## 已准备的内容

- `package.json` 的介绍突出 DSH 原生浏览器操作、Codex 工作流参考、平滑虚拟鼠标、Chrome 登录态复用，以及安装后的侧栏入口。
- 中英文 README 顶部增加 Star 与共创邀请，并展示两张实际组件／测试截图。
- 根目录 `screenshots.json` 声明两张 GitHub 仓库内的 PNG；不使用第三方图床。
- `longmiaoo__dsh-native-browser.yml` 是社区目录条目的完整更新内容，`catalog-update.patch` 只修改此项目的条目。
- 连接页和侧栏使用 README 吉祥物的 128px 资源，直接内置于前端，不新增网络请求。修改图标源文件后需同步 client.js 的 brandIcon。

## 为什么只发 npm 不会立刻改变截图中的卡片

当前 dsh-market 的介绍来自 awesome-dsh-plugin 的目录条目，不是每次读取 npm description。需要向目录仓库提交这一个 YAML 的更新；不能编辑它自动生成的 README。截图在我们仓库发布后由目录构建读取 screenshots.json，已安装市场的旧缓存还需刷新。

1. 推送本项目的前端、文案和截图。
2. 将 catalog-update.patch 应用到 awesome-dsh-plugin/awesome-dsh-plugin 的当前 main，提交仅修改 data/plugins/longmiaoo__dsh-native-browser.yml 的 PR。
3. 等目录维护者合并和目录重新构建，再刷新 DSH 市场。不能保证上游合并或缓存刷新时间。
4. package.json 介绍及安装后的新页面随下一次 npm 版本发布交付；0.1.8 不包含本次页面改版。

市场的一句话介绍以功能和入口为主；Star／共创邀请放在 npm 介绍、README 顶部和配置页页脚。Codex 是体验参考和迭代目标，不宣称已经达到或超越其性能。

## 来源与验证

- [目录现有条目](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/longmiaoo__dsh-native-browser.yml)
- [目录投稿与 screenshots.json 约定](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md#screenshots--截图optional-recommended--可选推荐)
- [dsh-market 截图展示机制](https://github.com/dsh-market/dsh-market#what-you-get)

2026-11-03 核对。已验证真实 Cordis 注册生命周期、隔离 Chrome 中的实际 Setup 组件、深浅主题、390px 窗口无横向溢出、英文界面、宿主主题变量优先、旧宿主设置回退、复制指令和打开页面不自动安装的防回归。

截图 browser-setup.png 是隔离组件的连接成功状态预览；cursor-feedback.png 是隔离测试页的实际指针和状态条。它们不是第三方网站任务成功率或性能的证明。

# DSH Native Browser privacy notice

Effective date: 2026-10-30. Applies to the DSH Native Browser extension, its local Broker/Native Messaging host and the `dsh-native-browser` DSH plugin maintained at [longmiaoo/dsh-native-browser](https://github.com/longmiaoo/dsh-native-browser).

## Purpose and information processed

This software lets you authorize DSH to read and operate browser tabs for tasks you request. It can process:

- Open-tab identifiers, titles, URLs, browser instance information and navigation state for tab selection and control.
- Page text, accessibility/DOM structure, element positions and screenshots for understanding pages and verifying actions.
- The text, clicks, scrolling and other inputs required by requested browser actions.
- Local file paths selected for upload, and download identifiers, filenames, state and related metadata when those actions are requested. Uploading a file sends it to the website you operate through the browser.
- Local authentication tokens, transient control/consent state, operational diagnostics and action recovery metadata needed to connect components and avoid duplicate actions.

Page contents and screenshots may contain personal information or sensitive information displayed by websites. Password-field text input is intentionally restricted and some observations/screenshots exclude specific sensitive elements or cross-origin frames. These checks are **not a guarantee that all personal or sensitive information is removed**. Authorize only pages you intend to share with your assistant.

The extension uses the browser's existing signed-in sessions to operate websites. It does not request the Chrome `cookies` or `history` APIs, and it does not implement a cookie/password export feature. This does not mean that page content from signed-in websites is anonymous or nonsensitive.

## Where information goes

The extension communicates with a registered native application on the same computer through Chrome Native Messaging. The local Broker communicates with the DSH plugin over a private local socket.

The plugin supplies tool results and screenshot attachments to DSH. **DSH may send these results to the model/provider, services and other integrations selected by you.** Those services may process information remotely and may retain it according to their own policies and your settings. A remote DSH deployment also processes information on the host running that deployment. This project is not a guarantee of offline operation.

Your browser continues to communicate with websites as part of navigation, form submission, uploads and downloads. These website transfers are subject to the websites' own policies.

The project's extension and Broker do not include a maintainer-operated analytics, advertising, telemetry or page-content upload endpoint. The maintainer does not receive your browsing content merely because you install the plugin. Information you voluntarily post in a support issue is public on GitHub and is handled under GitHub's policies.

## Local storage and retention

The default component directory is `~/.local/state/dsh-native-browser`; a host administrator may configure another directory. It contains the staged extension, native-host configuration and launcher, local authentication token, ownership/recovery files and service logs. Browser-native registration and a user login-service definition are also installed in the relevant macOS user directories.

The recovery journal stores keyed hashes of request identity/payload plus action type, timestamps and dispatch/outcome state, rather than raw page content or entered text. Its default expiry is 24 hours; cleanup depends on the Broker running and journal maintenance. Operational logs may contain error and diagnostic information. These are not uploaded automatically by the plugin.

Browser page observations and control state are primarily transient within the running components. DSH can retain conversations, tool results and screenshot attachments separately. Its storage/retention settings and the configured provider's policies apply to those copies; uninstalling this plugin does not delete them.

## Your choices and deletion

- Authorize target tabs in the extension, and use Stop or handoff to release control. DSH approval settings govern assistant actions independently of installation.
- Remove the Chrome extension to prevent future extension operation. Use the documented component uninstall process to remove its native registration and login service.
- Component uninstall intentionally preserves the runtime directory, recovery state and staged files. To erase them, first stop the relevant components and confirm the directory is no longer shared by another browser/profile, then delete that directory and any retained native-registration backup files. Removing only the npm plugin does not perform this full cleanup.
- Delete DSH conversations/attachments and contact your model provider separately when you want their retained copies removed.

## Limited use and support

The project uses information obtained through Chrome APIs only to provide or improve the user-facing browser assistance described here. It does not sell that information, use it for personalized advertising, or use it to determine creditworthiness or lending eligibility. Use and transfer of such information will adhere to the Chrome Web Store User Data Policy, including its Limited Use requirements.

General questions can be raised at the [project issue tracker](https://github.com/longmiaoo/dsh-native-browser/issues). Do not post tokens, screenshots of private pages, personal data or vulnerability details publicly. For a sensitive request, first ask the maintainer for a private contact channel without including the sensitive information. See [SECURITY.md](SECURITY.md) for security reporting guidance.

This notice describes this project's behavior. It does not replace the privacy policies of DSH, your model provider, Google Chrome, GitHub or websites you visit. Material changes to this behavior should be accompanied by an updated notice.

## 中文摘要

本插件为了完成你授权的浏览器任务，会处理标签页标题/网址、网页文字、页面结构、截图、操作输入和相关文件元数据。扩展经本机 Native Messaging 与本地 Broker 通信，再把工具结果交给 DSH；**DSH 可能将内容发送给你配置的模型或其他服务，不能理解为数据始终不离开电脑**。

项目本身没有维护者运营的广告、分析或网页内容上传服务。页面截图仍可能包含敏感信息，请仅授权你愿意交给助手处理的页面。停止或卸载插件不会自动删除 DSH 会话、截图附件、模型供应商留存内容，组件卸载也会保留本地运行目录；完整删除方式见上文及安装文档。

# Chrome Web Store submission packet

Prepared: 2026-10-30. **Draft materials, not a submitted or approved listing.** Current public distribution remains npm plus an unpacked extension. The store-generated extension ID and native-host registration must be reconciled before submission for review.

## Listing copy

Name: **DSH Native Browser**

Short description (English):

> Let DSH assist in your Chrome tabs with page reading, visible pointer feedback and control you can stop.

Short description (中文):

> 让 DSH 在你的 Chrome 标签页中读取和操作网页，支持可见鼠标反馈、截图及随时停止控制。

Detailed description:

> DSH Native Browser connects Google Chrome to the DeepSeek Harness (DSH) assistant running on your Mac. Ask DSH to read an authorized page, fill a form, follow links or capture a screenshot while you watch the browser.
>
> Features include semantic page reading, verified clicks and typing, scrolling, multi-tab workflows, screenshot support, visible pointer feedback and explicit Stop/handoff. Browser tools use the native_browser_* namespace to reduce conflicts with other DSH plugins.
>
> Requires macOS and a working DSH installation with the dsh-native-browser companion plugin. Configure the local components from DSH Settings → Browser setup, then authorize a target tab in this extension. Installing the Chrome extension alone does not install or configure DSH. Linux/Windows and Edge are not part of this store release's supported setup.
>
> The extension communicates with a local native application. Page text and screenshots can be passed by DSH to the model provider you choose; use only pages you intend to share with your assistant. The project does not operate an advertising or page-content collection service. See the privacy notice for data handling and deletion details.
>
> This is an independent community project. It is not an official product of DeepSeek, Google or OpenAI. Task results depend on the page, model and permissions; no specific automation success rate is promised.

中文介绍：

> DSH Native Browser 把你正在使用的 Chrome 与 Mac 上的 DeepSeek Harness（DSH）连接起来。你可以在 DSH 对话中要求读取已授权网页、填写表单、点击链接或截图，并在浏览器中查看执行过程。
>
> 支持语义化页面读取、经过验证的点击和输入、滚动、多标签页、截图、虚拟鼠标反馈，以及 Stop/交还控制。使用独立的 native_browser_* 工具名，减少与其他浏览器插件的命名冲突。
>
> 需要 macOS、可正常使用的 DSH，以及 dsh-native-browser 配套插件。请从 DSH“设置 → 浏览器配置”完成本机配置，再在扩展弹窗中授权目标标签页。仅安装 Chrome 扩展不会自动安装 DSH。Linux、Windows 和 Edge 不属于本次商店版本的正式安装支持范围。
>
> 扩展通过本机程序与 DSH 通信，网页内容和截图可能由 DSH 发送给你选择的模型服务。请只授权愿意交给助手处理的页面，详细数据处理及删除方式见隐私政策。
>
> 本项目由社区独立开发，非 DeepSeek、Google 或 OpenAI 官方产品。实际效果取决于网页、模型与权限配置。

Website: `https://github.com/longmiaoo/dsh-native-browser`

Support: `https://github.com/longmiaoo/dsh-native-browser/issues`

Privacy URL after the accompanying commit is pushed: `https://github.com/longmiaoo/dsh-native-browser/blob/main/PRIVACY.md`. Verify this URL is publicly accessible before putting it into the dashboard.

Category candidate: Productivity / Workflow & Planning, subject to the categories actually offered in the dashboard. No claim of store availability, verified publisher status or Codex parity should be added to the listing.

## Single purpose

> Enable user-directed DSH browser assistance in Chrome through a local native connection, including page observation, requested input, visual feedback and explicit user control over the session.

## Permission justifications

| Permission | Purpose and source evidence |
| --- | --- |
| `debugger` | Attach to authorized tabs to obtain accessibility/DOM observations, dispatch verified input, capture screenshots and handle task-related dialogs/files. `packages/extension-core/src/background.ts` restricts the accepted CDP methods and parameters; `packages/provider-chromium/src/provider.ts` contains packaged operation logic. |
| `nativeMessaging` | Connect only to `com.longmiaoo.dsh_native_browser`, the separately installed local companion, to exchange typed browser operations/results. |
| `tabs` | Identify/select tabs by title and URL and maintain tab/navigation/closure state for user-directed tasks. Listing open tabs may expose their URLs/titles to DSH. |
| `activeTab` | Temporary active-tab access after the user's extension action; used alongside the target-tab consent flow. Recheck whether any functionality still specifically requires this permission before store submission; remove if redundant. |
| `scripting` | Inject packaged pointer feedback into the controlled tab when needed; does not download code from a remote URL. |
| `downloads` | Observe downloads started by a requested browser action, correlate them to the authorized lease and return filename/status evidence. It is not used to export the user's entire download history. |
| `tabGroups` | Visually group tabs created for assistant tasks so the user can identify them. |
| `https://*/*` | Current pointer content script runs on HTTPS pages; packaged code provides visible automation feedback across the user's chosen sites. Its presence does not itself authorize page control. Broad host access is a likely review concern: evaluate optional, site-scoped access without breaking navigation/pointer behavior before submitting. |
| optional `http://*/*` | Only requested through the popup's explicit HTTP pointer button, for equivalent pointer feedback on HTTP pages. |

These are evidence-based draft explanations, not an assertion that every declared permission already passes Google's minimum-permission review. Do not misdescribe a broad host permission as limited to one website.

## Privacy practices fields

Use [PRIVACY.md](../../PRIVACY.md) as the source of truth. Dashboard wording can change; map these actual behaviors to the categories shown there:

- **Website content**: page text, DOM/accessibility observations, screenshots and requested form inputs.
- **Web history / browsing activity**: open-tab URLs/titles and navigation state, not the Chrome history database. Declare the applicable category when the dashboard definition includes this data.
- **User activity**: actions requested through the assistant and their verification results.
- Personal, financial, health or authentication-related information can appear in page text/screenshots even if the plugin does not specifically seek it. Review the actual dashboard definitions and disclosure requirements before choosing “not collected” for those categories.
- Local connection tokens are not sent to the extension or model. DSH conversation content/screenshots may be sent to the configured model/provider; do not select declarations that promise offline-only processing.
- No sale of user data, no personalized advertising use and no creditworthiness/lending use by this project. Certify these only if they remain true for the uploaded build.

The screenshot cross-origin masking policy is not a general PII-redaction guarantee. Uninstall preserves local runtime files and does not delete DSH/provider copies.

## Remote-code disclosure

The extension's JavaScript and pointer logic are packaged. Browser operations arrive over Native Messaging from the companion. There is no generic model-facing JavaScript evaluation tool. The background enforces a CDP allowlist; `Runtime.evaluate` is restricted to a packaged readiness expression, and `Runtime.callFunctionOn` accepts packaged approved functions and validated arguments.

Review the final built archive, especially debugger-dispatched expressions/functions, before answering the dashboard's remote-code question. Do not assume that “uses a local native host” automatically exempts all behavior from review. Google's MV3 policy has a specific Debugger API exception only for appropriate documented API use; full functionality must remain reviewable.

## Reviewer test steps

Prerequisites: macOS, Google Chrome and DSH host components 0.2.1-rc.3 (tested version). DSH requires its own model configuration to perform conversational tasks; do not provide real personal credentials or model API keys in public submission materials.

1. Install `dsh-native-browser@0.1.1` or the later store-ID-compatible companion from the plugin market in the running DSH app. Restart/reload DSH as it requests.
2. Open Settings → Browser setup and click Set up Chrome. This registers the native application and user login service. **Do not submit for review until this step registers the actual store extension ID. Version 0.1.1 still targets the unpacked ID.**
3. Install the submitted store extension. Open an ordinary public HTTPS page, open the extension popup and allow the current tab.
4. In DSH, ask: “Use native_browser tools to read the title and main content of the authorized page, then hand control back.” Expect the correct title/text without exporting browser cookies.
5. Request a visible click/scroll on a harmless public page or local test fixture. Observe the pointer feedback during supported actions. Idle pointer visibility is not guaranteed on every page.
6. Click Stop in the popup during a task; subsequent input must require renewed valid control.
7. Check connection in DSH settings. Test switching foreground conversations to ensure the old conversation loses control. Reload Chrome and repeat the consent flow when needed.

Before submitting, add a short screencast of this actual sequence and a reproducible no-personal-account fixture. The reviewer should not have to guess how to install the companion. The model configuration requirement is a review usability dependency; do not hide it.

## Remaining account/submission dependencies

- Developer registration/payment and required account verification are unconfirmed. Chrome automation currently refuses navigation to the developer dashboard; no draft item has been created.
- Confirm the publisher identity, support/privacy contact email and intended distribution regions in the real dashboard.
- Confirm rights to the supplied mascot image for public extension distribution. The supplied image is in the project; its commercial/distribution license has not been established by this preparation work.
- Upload the draft ZIP without publishing to obtain the actual item ID/public key. Then implement/test store-ID host registration and migration before review submission.
- Finish the minimum-permissions audit; validate the configured model data flow against the privacy declarations.
- Use actual product screenshots at 1280×800 or 640×400. Existing 128px icon can be reused after rights confirmation. The optional 440×280 promo and 1400×560 marquee are separate assets, not required to claim readiness.

## Official references

- [Publish an extension](https://developer.chrome.com/docs/webstore/publish)
- [Privacy fields and permission justifications](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Manifest V3 code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [Screenshot and icon requirements](https://developer.chrome.com/docs/webstore/images)
- [Obtain a store key before publishing](https://developer.chrome.com/docs/extensions/reference/manifest/key)

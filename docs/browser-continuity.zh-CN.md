# 连续浏览器任务：受控续期与异常提示

日期：2026-11-03。基线：`v0.1.8` / `ddc9d5f`。本文描述 `0.1.9` 的实现与发布前验收。

目标是减少长任务中断，同时保留人工接管和会话归属。这里没有 Codex 内部租约实现的证据，也没有与 Codex 的同任务耗时对照，不能将本轮功能验证表述为已达到或超越 Codex。

## 本轮行为

- personal 模式成功 claim/open 后，宿主维护现有控制权。每次约剩余期限的一半时续期；默认首次约一分钟后发生，成功后再延长两分钟。
- 续期保持相同 owner、leaseId、标签页和 token，不重新 claim、不重新附加 debugger，也不重放输入。每次重新检查当前页面、访问策略和有效期限。
- 扩展只有在本地 gate 仍有效、原期限精确匹配、身份和 scope 不变时才接受新期限。Stop 与异步续期发生竞争时，Stop 仍然生效。
- 页面指针和活动条收到新期限，经过原期限后不会因旧的展示计时器而消失。续期消息不生成鼠标、键盘或其他页面输入。
- 轮次结束、显式 finish/release_all/handoff、切换对话、断线、插件/会话销毁都会停止相应续期。中断保留用户页面；正常完成仍遵循已有临时页清理规则。
- 十分钟没有新的浏览器工具请求就停止维护；随后按最后一次已确认期限自然失效。维护心跳和任务状态查询本身不会刷新这十分钟预算。已过期、停止或维护失败的租约不会因后来又有工具调用而自动恢复。

这是保持当前任务控制权，不是取消权限边界。`per-action`、`per-lease`、`trusted` 的原有期限不变；restricted Broker 明确拒绝续期方法。DSH 自身的权限裁决仍有效。

## 实现位置与兼容性

| 层 | 实现 | 保证 |
|---|---|---|
| DSH 宿主 | `packages/dsh-adapter/src/lease-keepalive.ts`、`index.ts` | 只维护当前作用域；有空闲预算；不重连、不申请新控制权、不重试 |
| Broker | `packages/broker/src/client.ts`、`server.ts` | 协商 `runtime.lease-renew.v1`；连接与会话共同绑定 owner；restricted 模式拒绝 |
| Runtime | `packages/runtime-core/src/runtime.ts` | 同标签页串行；检查原期限；提供方 ACK 后才更新；失败/迟到 ACK 不恢复权限 |
| Chromium 提供方 | `packages/provider-chromium/src/provider.ts` | 只有声明 `lease.renew.v1` 的扩展可接收续期；确认返回的新期限 |
| Chrome MV3 | `packages/extension-core/src/background.ts` | 检查原 gate 与期限；不创建 gate；刷新展示期限 |

两个续期能力都是可选协商，不提高旧版 peer 的必需能力集合。旧 Broker 不启用维护；旧扩展可继续使用固定期限，收到不支持续期的结果后宿主停止维护。要获得完整效果，需要在新版发布后更新插件、重新运行配置以更新 Broker/扩展文件，再重载 Chrome 扩展和 DSH。本次工作没有改动用户当前运行的 Broker 或 Chrome 扩展。

工具返回的 `expiresAt` 是当时的期限快照。后续工具使用 `leaseId`；模型不需要调用心跳，也不能拿旧期限绕过 Runtime/扩展的当前检查。

## 结果未知时

任务状态仅保留 `outcome / dispatch / postcondition` 三个字段，不包含页面正文、URL、填写内容或原始错误。结果未知、条件未验证或不满足时，显示需要核验；读取成功本身不会清除此提示。后续已验证的动作可以更新最近动作结果，此面板不是每个历史业务操作的审计账本。

恢复提示分为核验结果、刷新目标、等待交还控制、检查连接和尊重访问策略。它们帮助用户和模型判断下一步，不代表插件能自动恢复任意业务流程。已派发但结果未知的输入不会自动重试；付款、提交等业务事实仍需只读核对。

## 验证

- `test/lease-keepalive.test.mjs`：跨期限维护、空闲预算、工具活动、失败不重试、取消和迟到 ACK。
- `test/lease-renewal.test.mjs`：原身份和观察缓存保持、策略/站点变化、过期/撤销拒绝、Stop 竞争和 ACK 丢失。
- `test/adapter.test.mjs`：真实本地 socket 路径跨过原两分钟期限；会话切换、handoff、release_all、turn/end、Stop、dispose，以及未知结果提示。
- `test/broker.test.mjs`：新旧扩展能力协商、跨连接/会话隔离、restricted 拒绝。
- `test/extension.test.mjs`：精确 gate 与原期限验证、伪造期限拒绝、Stop 竞争、展示期限更新且不派发输入。
- `scripts/verify-lease-renewal-extension.mjs`：真实隔离 Chrome MV3，使用两秒期限加速跨过原截止时间，重复续期后沿用旧 ref 完成一次输入，检查活动条/指针及 Stop。该脚本由 `smoke-extension.mjs` 调用，Native Messaging 由测试桥替代。
- `scripts/smoke-native.mjs`：真实 DSH ToolRuntime → socket → Broker 子进程 → Native Messaging → Chrome MV3 的原有流程回归；该脚本使用 restricted 模式，不代表 personal 心跳全链路验收。
- `scripts/smoke-setup-ui.mjs`：真实 React/SlotCore 验证未知结果和目标过期的提示；不是完整 Desktop 外壳验收。
- `scripts/smoke-installation.mjs --no-service --lease-renewal`：打包后安装到全新目录，使用真实 DSH ToolRuntime、默认 personal 配置、Native Messaging 和 Chrome。等待超过原本两分钟的期限，期间不轮询浏览器工具，再用同一 lease/ref 成功输入，检查指针/活动条和交接清理。不更改用户的 LaunchAgent。

以上隔离 Chrome 测试在 Chrome for Testing `153.0.8010.12`、DSH 组件 `0.2.1-rc.3` 上通过。完整记录见[验收证据](compatibility/2026-11-03-browser-continuity.json)。这些验证没有调用大模型，也不证明真实网站上的任意任务成功率、数小时运行的稳定性或与 Codex 相比的性能。

## 接下来

1. 将现有专项验收扩展为固定任务集，测量续期、Stop、会话切换延迟及数小时稳定性。
2. 补齐受控 select、hover、后退/前进、刷新等常用动作，沿用相同文档/目标/权限检查。
3. 完善人工接管后的重新观察与继续路径，以及来源元素选择器。
4. 建立固定任务集，记录成功率、工具调用次数和耗时分位数，再与 Codex 做实际对照。

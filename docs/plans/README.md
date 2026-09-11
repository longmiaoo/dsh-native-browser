# 浏览器运行时计划包

本目录是 2026-09-11 的设计交付，不代表功能已实现。

- [完整架构与实施计划](browser-runtime-plan-v2.zh-CN.md)
- [Vision Router 接入设计](vision-router-integration.zh-CN.md)
- [交互式架构图](diagrams/browser-architecture.html)
- [交互式动作时序图](diagrams/browser-action-sequence.html)
- [图表验证记录](diagram-verification.md)

两份正文还包含安装配对、停止恢复、图片路由、视觉定位等 Mermaid 图。HTML 图可独立打开、切换深浅色、缩放和导出；JSON 是可编辑源，PNG 是已校验 HTML 的浏览器截图。

实施顺序：P0 风险验证 → P1 可控垂直切片 → P2 定位/等待与 Edge 冒烟 → P3 真实任务 → P4 Chrome 加固 → P5 Edge 正式支持。

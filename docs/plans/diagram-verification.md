# 图表交付验证记录

日期：2026-09-11。使用 Archify 生成独立 HTML；验证的是文档图表，不是浏览器插件本身。

## 架构图

```text
diagram_type: architecture
output: /Users/sd/likunlong/longmiaoo/dsh-native-browser/docs/plans/diagrams/browser-architecture.html
specification_sha256: 17ad44668843d96d9d8f0542f3e873f456130cd377fe301227851d4a3614b790
artifact_sha256: 6f799459ba340a570ca4153bd680309d91614c9499de3fbd755f24a03c44333a
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 1
```

## 动作时序图

```text
diagram_type: sequence
output: /Users/sd/likunlong/longmiaoo/dsh-native-browser/docs/plans/diagrams/browser-action-sequence.html
specification_sha256: 1f609e7085dffa8c3b3397878dfc727b83027384fa2dd5b9be155f21af8adcd8
artifact_sha256: 5b0faf928655972b284acfa0e1d63207679beafb792b4db48991f2d020b8524c
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 2
```

自动浏览器检查覆盖 1440×900、1600×1000、1920×1080、2048×1320；生成两端尺寸深浅色截图。两份 HTML 的 hash 与对应 `.visual-check.json` 回执相同，所有必要测量通过，无溢出或诊断错误。

视觉审阅实际查看每份图的 1440×900 浅色和 2048×1320 深色截图，检查节点、连线、标签、首屏与下方留白；无发现阻挡阅读的布局问题。图表生成修正仅为连线文字位置、可读性与画布尺寸。

自动回执中的 `visualReview: pending` 是工具的固定语义，不代表它执行了人工审阅；此处单独记录图像审阅结果，不修改自动回执。其他尺寸/主题已有自动截图证据，但不将其全部声称为逐张人工审阅。

正文链接与图片路径存在性已检查。Mermaid 保留为可编辑文本，本记录的 9/9 和浏览器证据仅适用于上述两份 HTML，不涵盖 Mermaid 的渲染质量。

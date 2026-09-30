# Benchmark 文档状态

当前规范：[本地 PDF QASPER 设计](specs/2026-09-28-local-pdf-qasper-benchmark-design.md)。
实施计划：[本地 PDF QASPER 计划](plans/2026-09-28-local-pdf-qasper-benchmark.md)。

已实施的增量实验设计：[PageIndex-style 目录树检索对照组](specs/2026-09-30-pageindex-style-toc-tree-benchmark-design.md)。该设计新增 D 组，不修改既有 A/B/C/R 的定义。代码与自动化测试已完成。

2026-09-30 的真实 train 三篇 mini-batch 已通过验收：`ds-train-3-toc-tree-v1-fixed-20260930-0840` 产生 20/20 条记录，D 的 4/4 道题均成功路由与回答，三棵树来源为 1 篇 heading、2 篇 native outline；共同速度 cohort 为 4。D 的 AnswerF1 为 0.5240、EvidenceF1 为 0.0625、retrieval latency P50/P95 为 3822.41/7623.71 ms、TTFT P50/P95 为 6919.64/9021.31 ms。60 篇 / 179 题运行尚未启动，需先由用户审阅该 mini-batch。
实施计划：[PageIndex-style 目录树检索计划](plans/2026-09-30-pageindex-style-toc-tree-benchmark.md)。

此前关于伪页 QASPER、PDF 小集 pilot、目录/JEV、冷首问、Q 综合评分、旧速度及页级检索指标的设计和计划，均作为历史研究记录保留，其公开 benchmark 运行协议已被上述规范替代。历史结果不应改写为新 schema 或与新结果直接混排。

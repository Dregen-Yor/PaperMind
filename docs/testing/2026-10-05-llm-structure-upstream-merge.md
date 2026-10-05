# exp/llm-structure 合入 upstream/main

合并来源：`9165896`。合并前实验提交：`ed074fc`；备份分支：`backup/llm-structure-before-upstream-20261005`。

## 冲突处理

- 合入共享产品代码：索引解析/检索缓存、请求内 query embedding 复用、标题先验、上下文分词复用、结构卡格式恢复、回答提示词及品牌界面。
- 保留本分支 localPdf CLI 与 A/B/C/D/R、官方 AnswerF1/EvidenceF1、retrieval latency/TTFT P50/P95。旧 benchmark runner 已在本分支删除，不恢复其 config/types/runner、相关旧入口测试及仅依赖旧数据集/指标模块的两个评测脚本。上游 full-context 默认配置修复属于该旧入口，本分支没有同一入口可应用。
- 保留 C 的 outline 融合、权重和诊断；上游 heading 先验独立存在且默认关闭，不改变 C 的定义。
- 保留预构建 BM25 scorer 的注入。首轮测试发现缓存初始化重复建库；改成仅在未传 scorer 时按需创建，避免在计时区间重复做准备工作。
- 保留上游回答报文测试。产品和 localPdf 共用 buildAnswerMessages，后续 benchmark 会使用新提示词；不能把新旧 AnswerF1 差值直接归因于检索变化。
- 本分支已有 localPdf 精确截断优化保持不变。上游 contextTrace 优化作用于另一条共享物化路径。
- 上游合成检索对照脚本保留，默认基准改为本分支合并前的 ed074fc，以兼容 outline 诊断字段。

## 验证

- `npm test`：76 个文件、938 个 Vitest 测试通过；branding 18 通过、1 跳过（平台校验）。
- `npm run typecheck`：通过。
- `git diff --check` 与暂存区检查：通过。
- `node --import tsx scripts/benchmark-passage-retrieval.ts --baseline-ref ed074fc --passages 60 --iterations 20`：450 个输出等价用例通过。只验证合成 CPU 检索、预算填充和确定性向量下的行为，不包含真实模型、网络、答案质量或端到端延迟。

未运行真实 API benchmark，未修改历史 results。已有三份未提交调研文档不纳入合并提交。上游 docs/testing 的评测文档保留作为上游历史记录，其中旧 CLI 命令不适用于本分支，应使用 bench/README.md 中的 localPdf 命令。

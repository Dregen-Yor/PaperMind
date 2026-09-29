# Local-PDF QASPER Benchmark

唯一评测入口为 `prepare → run → report`。输入是根目录 `dataset/qasper-pdfs/` 的真实 PDF，问题和逐标注者参考来自 QASPER v0.3 JSON。dev 当前本地匹配 280 篇 / 1,002 题，缺失 `1802.00396.pdf` 的 3 题在冻结时明确排除；不是完整官方 dev。train 只用于开发。

## 准备与运行

需要项目 Node.js 依赖，以及 Python 3（只用标准库；可用 `BENCH_PYTHON` 指定可执行文件）。从仓库根目录运行：

```bash
npm run bench -- prepare --split train --dataset-root dataset --limit-papers 3 --out bench/prepared/train-3.json
npm run bench -- prepare --split dev --dataset-root dataset --out bench/prepared/dev.json

# 配置同一回答模型；密钥只通过环境变量提供
export BENCH_LLM_PROVIDER=openai
export BENCH_LLM_MODEL=your-model
export BENCH_LLM_BASE_URL=https://your-endpoint.example/v1
# BENCH_LLM_API_KEY 由本机安全环境注入

npm run bench -- run --manifest bench/prepared/dev.json --methods A,B,C,R --out bench/results/pdf-dev-001
npm run bench -- report --run bench/results/pdf-dev-001
```

输出必须是新路径，不能覆盖既有 manifest 或 run。正式四组共 4,008 次逻辑回答请求，默认最多额外重试 3 次；先用 train 小集验证。`--methods A` 等单臂运行可以用于调试，速度标为未配对。report 不请求模型，可在无 API key 的环境重算；必须保留 run 内的 gold、预测和固定 evaluator。

回答配置沿用 `BENCH_QA_REQUEST_TIMEOUT_MS`（默认 120000）、`BENCH_QA_RETRY_ATTEMPTS`（默认 3）、`BENCH_QA_TOP_P` 和 `BENCH_QA_THINKING`（enabled/disabled）；输出上限 4096、temperature=0。所有臂共享配置。Ollama 不接受显式 thinking 参数，请使用支持 `truncate: false` 的服务版本；请求明确禁止静默截断。本地模型 endpoint 必须设置 `BENCH_EXECUTION_BACKEND`。

检索 tokenizer 是 `BAAI/bge-m3`，embedding 是 `Xenova/bge-small-en-v1.5` q8/384 维。默认文件缓存 `bench/cache/models`，可通过 `BENCH_MODEL_CACHE_DIR` 指定；首次初始化可能下载模型。实际缓存文件 hash 写入身份；`HF_ENDPOINT` 可指定模型镜像。

## 方法与六列指标

A 是 BM25；B 是 BM25 + passage 向量；C 增加 PDF 原生目录先验，目录缺失/非法时回落 B 并记录原因。R 全文直投单列参考。A/B/C 共用 120/350 token 切段、4096 token 上下文预算。

| 质量 | 速度（ms） |
|---|---|
| AnswerF1 | Retrieval latency P50 / P95 |
| EvidenceF1 | TTFT P50 / P95 |

F1 使用 `bench/vendor/qasper/` 固定版本的官方 evaluator，范围 0–1。AnswerF1 和 EvidenceF1 各自对多标注者取 max，最后全题宏平均。EvidenceF1 保留图表证据，不使用 text-only 选项。旧 Q、judge、ROUGE、页级检索指标及冷启动评测入口已经移除。

PDF 文本通过不读取问题/答案标注的 canonical 对齐器映射到全部原文段落/caption。只有最终上下文完整覆盖的单元才导出官方原始字符串；未对齐正文保留为不匹配项。因此分数包含 PDF 解析/对齐误差，不能直接等同官方 leaderboard 的 JSON 全文输入结果。逐题 trace、原始回答和错误保存在 records.jsonl。

索引/模型已就绪后，retrieval latency 从收到问题到预算内上下文准备完成；TTFT 从同一起点到首个非空白可见回答 token（不含 reasoning 帧）。单题串行、回答/查询结果客户端缓存关闭，provider 缓存不保证可控。四组速度只用共同完整成功的问题，最近秩法 P50/P95；质量仍用全部冻结题。没有速度样本显示 `—`。R 的 EvidenceF1 和 retrieval latency 均不适用，全文超输入上限如实失败。

初始化失败只写 launch-error.json，不能伪造指标。中断 run 标 incomplete；不拼接不同 run 的速度。断裂 JSONL 报损坏，不自动忽略尾部。全部生成失败退出非零。输入 bytes/hash 改变必须重新 prepare。

`dataset/`、`bench/prepared/`、`bench/results/`、`bench/cache/` 均是本地产物，不提交真实 PDF、gold、预测或凭据；自定义输出目录也应保持不提交。历史结果和原始小集资料保留，但旧 schema 不再被新 report 接受。

测试：`npm test`、`npm run typecheck`；专用测试 `npx vitest run bench/src/tests/localPdf*.test.ts`。

## 分词性能修复（2026-09-29）

本地 BGE-M3 tokenizer 使用实例级 Unigram 优化：词典前缀搜索最多读取最长词条对应的 Unicode 码点数，避免 Transformers.js 3.x 在每个位置复制整段剩余文本。保留原始 normalizer、候选顺序、分数、未知字符处理和 Viterbi 解码；不修改依赖文件、切段规则或 4096 token 预算。依赖内部接口变化时明确失败，升级后须运行 `localPdfTokenizer.test.ts` 并重新核对真实 tokenizer。

修复前 train mini-batch 的 12 次检索约 17.8–104.8 秒；不调用 API 的修复后重放约 0.3–1.9 秒，12 次上下文与 trace 全等，13 个不同历史上下文的完整 token 序列与原版一致。此处为本地调试证据，并非新的正式速度表。历史结果保持原样；正式 TTFT 仍需新 run，不能把新检索耗时拼接到旧 API 时间戳。

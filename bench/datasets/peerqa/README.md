# PeerQA 原生评测

场景是单篇论文已打开、索引已就绪的单轮问答。现有段落／章节／树检索继续运行，检索结果按最终上下文完整覆盖的官方句子评测。句子检索、回答质量和流式速度分别成表。

## 准备官方数据

数据与字段定义见 [UKPLab/PeerQA](https://huggingface.co/datasets/UKPLab/PeerQA)，实验及全文准备流程见[作者仓库](https://github.com/UKPLab/PeerQA)。先下载并解压作者的 [v1.0 数据包](https://tudatalib.ulb.tu-darmstadt.de/bitstream/handle/tudatalib/4467/peerqa-data-v1.0.zip?sequence=1&isAllowed=y)，得到 `qa.jsonl` 和 `papers.jsonl`。全量 OpenReview 文本需按作者仓库的下载/GROBID 0.8.0 流程补齐，或将 Hugging Face `qa` 与 `papers-all` 导出为 JSONL；本仓库接受原始 list-of-dicts 和 Hugging Face dict-of-lists 两种 evidence 格式。

公开包中 579 道问题有 53 道 `answerable: null`，导入时单独记录并排除。已标注但缺论文文本的题另计 `missingPaperQuestions`。2026-10-11 验证公开文本子集可导入 85 篇 / 194 道已标注问题，**不能称为完整 PeerQA 结果**。具体切片由本机输入决定，不把这些数量写死在代码里。

```sh
npm run bench:peerqa:import -- --qa /path/to/qa.jsonl --papers /path/to/papers.jsonl
# 自定义输出；这里的 --limit 是论文数，benchmark --limit 是问题数
npm run bench:peerqa:import -- --qa /path/to/qa.jsonl --papers /path/to/papers.jsonl --out /path/to/peerqa.jsonl --limit 5
```

导入器为原生 TypeScript，无 Python 运行时依赖。输出为 schema 1 JSONL，每篇含源文本、官方 `paper_id/pidx/sidx`、源句子跨度、问题与参考答案、证据映射状态，以及数据准备计数。另写 `<out>.metadata.json`，含输出 SHA-256 与导入数量。默认文件在本目录，已加入 git-ignore；自定义路径须自行存放在本地数据目录。导入命令会替换指定的归一化输出，不能与官方输入同路径。

标题与 heading 保留在源文本，不当作证据句。非空公式、图注、表格和 list-item 沿用作者的句子索引作为文本单位；当前不理解其视觉内容。空内容不产生句子。共用官方句子编号的不同单位保留原文，但排除该歧义身份；引用它的题标记 ambiguous。没有证据、未映射或歧义的题可参与有标签的回答质量评测，不进入句子检索分母。

## 运行与对比

先按 [bench/README.md](../../README.md) 设置回答模型与端点。所有命令复用现有 runner：

```sh
npm run bench -- --task qa --dataset peerqa --config default --speed
npm run bench -- --task qa --dataset peerqa --config rag-bm25 --speed
npm run bench -- --task qa --dataset peerqa --config long-section-rag --speed
npm run bench -- --task qa --dataset peerqa --mode full-context --speed
npm run bench -- --task qa --dataset peerqa --dataset-path /path/to/peerqa.jsonl --config default --speed
npm run bench -- --compare /path/to/a.json /path/to/b.json
```

PeerQA 仅支持显式 `--task qa`；`--dataset all` 保持原有 QASPER + smoke 范围。RAG 预算为 BGE-M3 4096 tokens。全文直投单列质量与速度，不能进入句子检索排名。实际跑模型需要本地凭据与模型缓存；离线回归测试无需网络或凭据。

| 指标 | 定义与分母 |
| --- | --- |
| Sentence Recall | 命中 gold 句数 / gold 句数；在明确映射的可回答题上宏平均 |
| Annotated Precision | 命中 gold 句数 / 上下文完整句数；空上下文计零，未标注句仍可能有用 |
| All Gold Coverage | 全部标注证据句均完整覆盖的题比例；不代表逻辑充分性 |
| Native ROUGE-L | 有作者自由参考答案的可回答题；失败／跳过计零；采用项目归一化，与论文 rouge_score 不直接等同 |
| Answerability Macro-F1 | 两个固定类别的 F1 均值；成功回答用 `No Answer` + 项目拒答规则；失败只加真实类 FN |
| TTFT P50/P95 | 在线入口到客户端收到首个非空可见回答正文 |
| Full Answer P50/P95 | 在线入口到整个回答流成功结束 |

句子覆盖只读取最终 token 截断后实际发出的源片段，重叠／相邻来源区间合并，重复句 ID 去重。非空片段无法唯一匹配源页时整轮契约失效，不能默认为零命中。gold 从不进入召回、排名或回答 prompt。索引／检索失败在检索固定分母中计零，生成失败保留已得到的检索观测。

`--speed` 使用 `query-timeline-v2`、客户端回答缓存关闭、concurrency 1。四个回答延迟分位数共用完整成功题集合，最近秩法计算；失败题另报数量／失败率／超时／断流，不能补成 0 ms。计入在线检索、prompt 组装、网络、重试；不计建索引、Judge、离线评分或界面绘制。输出回答词数 P50/P95 帮助解释回答长度；词数不充当 token 用量。

版本、源文本／标签指纹、预算、tokenizer、句子有效题集合及观测数不一致时，不输出句子差值。速度仍使用既有模型、framing、端点、参数、环境与 completed cohort 门禁。PeerQA 不生成 Q 综合分。

## 导入 AlignScore / Prometheus

必须使用对应原模型在生成结束后离线评分。通用 `--judge` 继续显示自己的 Factuality / Completeness / Groundedness，不替代 AlignScore 或 Prometheus。本入口验证、汇总评分；它不加载这些模型，也不调用付费服务。

`scores.json` 格式如下，SHA-256 使用 UTF-8 字节。`sourceResultSha256` 为原结果文件的**原始字节**哈希，`answerSha256` 为该题 `answer` 原始字符串哈希，不能 trim 或重新序列化后计算。

```json
{
  "schemaVersion": 1,
  "sourceResultSha256": "<64 位 SHA-256>",
  "alignScoreModel": "<实际 AlignScore checkpoint / revision>",
  "prometheusModel": "<实际 Prometheus checkpoint / revision>",
  "scores": [
    {
      "questionId": "<有参考答案、生成成功的题号>",
      "answerSha256": "<answer 的 SHA-256>",
      "alignScore": 0.8,
      "prometheus": 4
    }
  ]
}
```

两个模型均可只配置一个；不能提供未配置模型的评分。AlignScore 范围 `[0,1]`，Prometheus 为整数 `[1,5]`，原始分保留，归一化 `(score - 1) / 4`。模型已配置时，未评分的参考题（含生成失败）以零贡献进入固定分母，另外报告覆盖数量；模型未配置时显示 `—`。

```sh
npm run bench:peerqa:score -- --result /path/to/result.json --scores /path/to/scores.json --out /path/to/scored.json
npm run bench -- --compare /path/to/result.json /path/to/scored.json
```

输出只能写新文件，避免覆写原结果或旧评分。错误源哈希、回答哈希、未知／重复题号、失败题评分、空模型身份与越界评分均拒绝。评分模型身份不一致时，两侧模型评分不计算差值。

## 输入限制与验证

当前评测使用官方**解析文本伪页**，不测 PDF 解析质量、真实页码、图片推理或跨论文检索。公开包与自行补齐的文本不能混成同一数据身份。句子 qrels 的映射与拒答检测均有局限，报告始终保留版本与覆盖计数。

```sh
npx vitest run bench/src/tests/peerqa*.test.ts
npm test
npm run typecheck
```

回归用真实 materializer／生产检索管线接口和模拟流式客户端检查覆盖、失败分母、四个分位数及全文参照；这些模拟时间和得分不能作为实际 PeerQA 结果。

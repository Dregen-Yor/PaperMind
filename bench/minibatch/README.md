# bench/minibatch — 冻结的 PDF 大纲研究集（pilot）

真实 PDF 上的 3 篇论文 / 12 道人工标注题，用于评测「原生目录作为检索先验」是否优于平面检索（臂 A 词法 / B 混合-原文 / C 混合-目录 / R 全文直投）。

```bash
npm run bench -- --task qa --dataset outline-study --config <config>
```

## 目录内容

| 文件 | 是否入库 | 说明 |
|------|---------|------|
| `annotations.json` | ✅ 入库 | **冻结的标注清单**（本题集的身份），改动它即改变数据集身份 |
| `README.md` | ✅ 入库 | 本文件 |
| `*.pdf` | ❌ **不入库** | PDF 字节属「不得提交」清单（体积大），需**本地放置**在同目录 |

**被标注的论文**（文件名必须与 `annotations.json` 的 `file` 字段逐字一致）：

- `01-method-attention-is-all-you-need.pdf` — Attention Is All You Need（原生目录 22 条）
- `02-theory-deep-sets.pdf` — Deep Sets（原生目录 35 条）
- `03-experiments-bert.pdf` — BERT（**原生目录缺失**，刻意保留：验证「无目录即回落臂 B 且仍留在全 PDF 分母」）

目录里还可以有**其他未被标注的 PDF**（例如 `04-long-survey-...pdf`、`05-appendix-heavy-...pdf`）：加载器只读 `annotations.json` 里列出的文件，**目录中的其他 PDF 一律忽略**。

## 标注格式（`OutlineStudyAnnotation`）

```jsonc
[
  {
    "file": "01-method-attention-is-all-you-need.pdf", // 必须只写文件名，不得含 / \ 或 ..
    "title": "Attention Is All You Need",              // 可选；缺省时回落到 file
    "questions": [
      {
        "q": "What value of warmup_steps ...?",        // 问题文本
        "answers": ["4000", "The warmup_steps ..."],   // 多参考答案（非空、非空串）
        "evidencePages": [7]                           // 人工标注的**页码，1-based**
      }
    ]
  }
]
```

- `evidencePages` 是 **1-based**（与 `bench/datasets/smoke/` 的约定一致），加载时统一转为评测内部的 0-based。必须是**非空的正整数数组**；越界、非整数或缺失都会以「文件名 + 第 N 问」报错，而不是静默漏算。
- 每题会生成稳定 id `<pdf 文件名>#<0-based 题序号>`。
- 这些标注同时充当质量参考：每题带 `qualityAnswers` 与 `qualityDefinition: 'pdf-qa-all-questions-v1'`，失败/跳过记 0 但仍留在固定分母里。

## manifest 指纹

每篇论文由加载器算一个 SHA-256（`manifestFingerprint`，方案版本 `outline-study-manifest-v2`），按固定顺序覆盖：

1. 版本前缀
2. 文件名
3. 标注 `title`
4. **原始 PDF 字节**
5. 逐页文本数组
6. 该篇标注（问题文本 + 参考答案 + evidence 页）
7. 目录 JSON 树

覆盖 PDF 字节与标题是关键：同名换文件、或只改标题，都会改变指纹，从而让缓存/结果身份失效。指纹是**运行期**元数据，绝不写进结果 JSON。

## 本地准备

仓库只入库标注，PDF 需自行放置到本目录（文件名须与 `annotations.json` 一致）。缺失时 `--dataset outline-study` 会给出可诊断的报错；对应的 fixture 单测会自动跳过而非报错。

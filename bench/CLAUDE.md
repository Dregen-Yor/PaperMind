[根目录](../CLAUDE.md) > **bench/**

# bench/ — Evaluation Project

`bench/` is an ESM Node/tsx evaluation project. It is not part of the Electron
runtime and does not open the product SQLite database. It may import pure
production modules from `src/utils/` so product and evaluation behavior can
share contracts.

## Entry Points

| Entry | Responsibility |
|---|---|
| `src/cli.ts` | General QA/summary evaluation CLI |
| `src/productCli.ts` | Product-path E-k5 and Docling evaluation |
| `src/treeInspectCli.ts` | Legacy semantic-tree inspection |
| `src/report.ts` | Markdown reports and comparisons |

Run through root scripts:

```bash
npm run bench -- --task qa --dataset smoke --limit 5
npm run bench:product -- --help
npm run bench:trees -- --config semantic-tree --dataset qasper --limit 5
```

Credentials and endpoints come from documented `BENCH_*` environment
variables. Never embed them in configs or result artifacts.

## Structure

| Path | Responsibility |
|---|---|
| `src/datasets/` | QASPER and smoke adapters |
| `src/runner/product.ts` | Production E-k5/Docling runner |
| `src/runner/qa.ts` | Shared staged retrieval/generation runner |
| `src/runner/fullContextQa.ts` | Full-context reference |
| `src/runner/traditionalRagQa.ts` | Traditional RAG baselines |
| `src/runner/hybridRerankQa.ts` | Hybrid rerank baseline |
| `src/runner/longSectionQa.ts` | Long-section baseline |
| `src/runner/semanticTreeQa.ts` | Historical semantic-tree experiment |
| `src/metrics/` | Retrieval, answer, judge, ROUGE, and aggregation metrics |
| `src/speed/` | Query-timeline and latency contracts |
| `src/scoring/` | Reproducible Q comparisons and reports |
| `src/streaming/` | Benchmark-specific OpenAI/Ollama stream parsers |
| `src/traditionalRag/` | Baseline chunking and retrieval primitives |
| `configs/` | Versioned experiment configurations |
| `src/tests/` | Benchmark Vitest suites collected by root `npm test` |

## Product and Baseline Separation

- `bench:product` is the only runner intended to exercise current product
  E-k5 and Docling behavior.
- General runner configurations are explicit evaluation methods. A benchmark
  method must not be described as the current application path merely because
  it imports `ragPipeline.ts`.
- `semantic-tree`, legacy PageIndex scoring, passage retrieval, traditional
  RAG, hybrid rerank, and long-section RAG are comparison or historical paths.
- `src/runner/summary.ts` uses the legacy Hugging Face T5 helper. It is not the
  current parsed-summary product pipeline.

## Reproducibility Rules

- Keep dataset identity, question IDs, prompt framing, model/endpoint identity,
  generation parameters, context budget, metric versions, and cache mode in
  result metadata.
- Do not compare runs with different slices or contracts in one ranking table.
- Retrieval failures for eligible questions remain in fixed denominators when
  the metric contract requires a zero observation.
- Final context text and page order must come from the same materialization
  operation; do not infer page order from display labels.
- A failed generation must not erase already completed retrieval observations.
- Preserve model/revision pins and explicit baseline identities.

## Generated Data

`bench/cache/`, `bench/results/`, `bench/prepared/`,
`bench/minibatch/`, downloaded dataset files, and local PDF fixtures are
generated or machine-local. They are ignored and must not be committed.
Architecture documentation must not record their machine-specific sizes.

Use [`bench/README.md`](README.md) for CLI arguments and metric definitions.

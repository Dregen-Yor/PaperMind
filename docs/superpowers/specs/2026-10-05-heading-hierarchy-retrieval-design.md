# E: Heading hierarchy retrieval

Implement on `exp/llm-structure`, following the explicitly delegated implementation choices in `prompt.md`.

Reuse D's validated native-outline / verified-TOC / body-heading tree. Traverse every node from root to node, remove section numbering, and embed exactly `Method > Training > Training Objective`. Keep node IDs and original PDF page ranges. Never read questions, references, or gold during index construction.

Compare `E-bm25-k3` (lexical ablation), `E-dense-k3` (heading-path cosine), and `E-hybrid-k1/k3/k5` (equal-weight reciprocal rank fusion, constant 60). BM25 indexes the full heading path plus the node's original PDF section text. Dense indexes only heading paths, using the same local BGE-small embedder as B/C. Hybrid combines their rankings; zero BM25 matches do not receive arbitrary document-order rank credit. Ties use deterministic document order.

Select the top k nodes, resolve selected parent/child overlap in favor of the child, then materialize their original page ranges through D's shared 4096-token traced materializer. Overlapping pages appear once. No generative routing, query rewriting, or lexical fallback after dense failure. Invalid trees/vectors produce explicit failures under existing scoring rules.

Persist heading paths, vectors and config identity during cold start, and per-question scores/selected node ranges. Extend method validation, CLI, runtime model selection, and reports without changing the six metrics, official evaluator, timing origin, fixed quality denominator, or common-success speed cohort.

Run focused correctness tests, the full suite, and typecheck. First validate mechanism on train PDFs, then evaluate the identical frozen 60-PDF / 179-question dev manifest with real `deepseek-flash` OpenAI-compatible streaming requests. All arms use the same generation settings. Preserve historical results and label any separately executed speed cohorts. Exploratory k comparisons on this slice are not an independent generalization estimate.

Current environment limitation: the source PDFs, frozen manifest, and original result artifacts are absent on this Mac; their location has been requested. No scores may be entered until real evaluation completes.

# Exact context truncation performance

Scope: user-approved truncation optimization only. Routing prompts, model options,
selected nodes, scoring, and saved benchmark results are unchanged. No paid API
requests or new end-to-end benchmark were run.

## Implementation

- Search grapheme endpoints from the end, returning the longest legal prefix.
  This remains exact even when token counts are nonmonotonic.
- Reuse a Unigram lattice for exact normalized prefixes. Preserve incoming-edge
  order, floating-point addition/ties, EOS choice and unknown-token fusion.
- Cache fused token counts on the same Viterbi paths. The normal single-section
  path retains upstream normalization and pre-tokenization. Added tokens,
  multiple pre-tokenizer sections and unsupported preprocessing fall back to
  upstream tokenization.
- Keep the cache bounded to one normalized input; never edit dependency files.

## Offline validation

Source run: `bench/results/ds-qasper-60-179-toc-tree-v1-rerun-20260930-225924`.

All 884 nonempty saved contexts across A/B/C/D/R matched the stock full token
sequence and token count. The stock reference retained only the previously
verified trie-suffix optimization; it did not use the new prefix/count cache.

All 168 D records with completed retrieval were replayed using their saved node
selections. Context and trace are exactly equal to the saved outputs. Maximum
context size is 4096 tokens. This includes the record whose subsequent answer
generation failed; route failures have no materialization to replay.

Final materialization-only measurements (not API retrieval or TTFT):

| Metric | Time |
|---|---:|
| P50 | 5.26 ms |
| P95 | 691.32 ms |
| Maximum | 14,778.97 ms |
| Total for 168 records | 39,465.46 ms |

Same-machine exhaustive comparison on the overflowing append from paper
`2002.03407` (6,319 UTF-16 units): both algorithms selected offset 4,118.
Old: 109,010.86 ms / 6,320 count calls. New: 695.40 ms / 2,202 count calls,
approximately **156.8× faster**. These are append-only wall times, not the
original record's network-inclusive retrieval latency.

Independent read-only review found no Critical/Important issues. Its 3,859 real
BGE-M3 prefix comparisons matched stock token sequences and counts, including
special tokens, normalization, combining characters, unknown characters and
unpaired surrogates.

Full verification: 73 Vitest files / 860 tests passed; branding 18 passed / one
environment-dependent skip; `npm run typecheck` passed.

## Reproduction

Run `node --import tsx bench/replay-context-performance.ts RUN_DIRECTORY --baseline`.
It disables remote model downloads, compares all saved nonempty contexts against
the stock tokenization path, replays D materialization, and compares one slow
append with the old exhaustive algorithm. It prints diagnostics only and does
not modify the source run.

## Limits

This removes repeated lattice construction and token-array reconstruction; it
does not eliminate scanning every relevant grapheme endpoint. Very long pages
still incur repeated normalization/prefix checks and can take roughly 15 seconds.
No new end-to-end retrieval/TTFT claim is made: D still makes an API routing call.
The optimization depends on Transformers.js 3.8.1 internals and must be verified
again on dependency upgrades.

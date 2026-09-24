#!/usr/bin/env bash
# 用本机 ds profile 按 speed v2 协议跑 Q 的参考（full-context）与 PaperMind 候选（default），再离线算 Q。
# 只有全部完成、零错误的 query-timeline-v2 结果才覆盖正式归档。
# SKIP_REFERENCE=1 可复用已有参考（须与本次生成设置一致，否则 Q 输出 — 并列出原因）。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-ds-env.sh"

load_ds_profile
mkdir -p "$results_dir"
cd "$repo_root"
ensure_qasper_dataset

if [[ "${SKIP_REFERENCE:-0}" != 1 ]]; then
  echo "[$(date '+%F %T')] 开始 full-context 参考"
  run_speed "$reference_out" --config default --mode full-context
  echo "[$(date '+%F %T')] 完成 full-context 参考"
fi

candidate_out="$results_dir/qa-v2-papermind.json"
echo "[$(date '+%F %T')] 开始 PaperMind default"
run_speed "$candidate_out" --config default
echo "[$(date '+%F %T')] 完成 PaperMind default"

run_q "$candidate_out" "$results_dir/q-papermind.json"

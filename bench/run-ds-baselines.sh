#!/usr/bin/env bash
# 按 speed v2 协议顺序跑检索基线，并对 full-context 参考离线算 Q。
# 参考须先由 run-ds-papermind.sh 产出；可用参数覆盖基线列表，例如：
#   bench/run-ds-baselines.sh rag-bm25 hybrid-rerank
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-ds-env.sh"

configs=("$@")
[[ ${#configs[@]} -gt 0 ]] || configs=(rag-bm25 rag-jaccard rag-cosine)

load_ds_profile
mkdir -p "$results_dir"
cd "$repo_root"
ensure_qasper_dataset

if [[ ! -f "$reference_out" ]]; then
  echo "缺少 Q 参考 ${reference_out#$repo_root/}，先运行 bench/run-ds-papermind.sh" >&2
  exit 1
fi

# 单个基线失败只跳过它，不中断后续基线
failed=()
for config in "${configs[@]}"; do
  out="$results_dir/qa-v2-$config.json"
  echo "[$(date '+%F %T')] 开始 $config"
  if run_speed "$out" --config "$config" && run_q "$out" "$results_dir/q-$config.json"; then
    echo "[$(date '+%F %T')] 完成 $config"
  else
    echo "[$(date '+%F %T')] 失败 $config" >&2
    failed+=("$config")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "失败的基线：${failed[*]}" >&2
  exit 1
fi

#!/usr/bin/env bash
# run-ds-*.sh 共用：从本机 PaperMind profile 导出 BENCH_LLM_*，校验 QASPER 数据集，
# 以及 speed v2 结果的完整性门禁。只供 source，不单独执行。凭据不写入日志或结果文件。

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_path="$HOME/Library/Application Support/papermind/papermind.db"
profile_name="${PAPERMIND_BENCH_PROFILE:-ds}"
results_dir="$repo_root/bench/results"
dataset_path="$repo_root/bench/datasets/qasper/qasper.jsonl"
q_config="$repo_root/bench/configs/scoring/q-score.json"
# Q 的参考：full-context --speed 结果，由 run-ds-papermind.sh 产出
reference_out="$results_dir/qa-v2-full-context.json"

load_ds_profile() {
  if [[ ! -f "$db_path" ]]; then
    echo "找不到 PaperMind 配置数据库：$db_path" >&2
    exit 1
  fi

  # 字段以 ASCII Unit Separator 分隔，避免 base URL 中的常见字符产生歧义。
  local profile
  profile="$(sqlite3 -separator $'\x1f' "$db_path" "
    SELECT json_extract(json_each.value, '\$.provider'),
           json_extract(json_each.value, '\$.model'),
           json_extract(json_each.value, '\$.baseUrl'),
           json_extract(json_each.value, '\$.apiKey')
    FROM settings, json_each(settings.value)
    WHERE settings.key = 'llm_profiles'
      AND json_extract(json_each.value, '\$.name') = '$profile_name';
  ")"

  if [[ -z "$profile" ]]; then
    echo "未找到 LLM profile：$profile_name" >&2
    exit 1
  fi

  IFS=$'\x1f' read -r BENCH_LLM_PROVIDER BENCH_LLM_MODEL BENCH_LLM_BASE_URL BENCH_LLM_API_KEY <<< "$profile"
  if [[ -z "${BENCH_LLM_MODEL:-}" || -z "${BENCH_LLM_BASE_URL:-}" || -z "${BENCH_LLM_API_KEY:-}" ]]; then
    echo "profile $profile_name 缺少 model、baseUrl 或 apiKey" >&2
    exit 1
  fi
  export BENCH_LLM_PROVIDER BENCH_LLM_MODEL BENCH_LLM_BASE_URL BENCH_LLM_API_KEY

  # 生成设置进入速度身份，参考与候选必须一致；这里只透传、不替用户选择 thinking 模式
  echo "QA 生成设置：thinking=${BENCH_QA_THINKING:-<provider 默认>} top_p=${BENCH_QA_TOP_P:-<provider 默认>}" \
    "timeout=${BENCH_QA_REQUEST_TIMEOUT_MS:-120000}ms retry=${BENCH_QA_RETRY_ATTEMPTS:-3}"
}

# 旧归一化数据集缺 Q 所需参考答案时会被加载器拒绝：备份后重新生成 60 篇主切片。
ensure_qasper_dataset() {
  if [[ -f "$dataset_path" ]] && grep -q '"qualityAnswers"' "$dataset_path"; then
    return
  fi
  if [[ -f "$dataset_path" ]]; then
    local backup="$dataset_path.bak-$(date '+%Y%m%d%H%M%S')"
    cp "$dataset_path" "$backup"
    echo "旧 QASPER 数据集缺 qualityAnswers，已备份到 ${backup#$repo_root/}，重新生成"
  fi
  (cd "$repo_root" && QASPER_LIMIT=60 npx tsx bench/datasets/qasper/fetch.ts)
}

# speed v2 结果门禁：全部完成、零错误、query-timeline-v2，否则拒绝归档。
assert_complete_v2() {
  node -e '
    const fs = require("node:fs")
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const { completed, total, speedDefinition } = result.meta
    const errors = result.errors.length
    if (speedDefinition !== "query-timeline-v2") {
      throw new Error(`结果不是 query-timeline-v2：${speedDefinition}`)
    }
    if (completed !== total || errors !== 0) {
      throw new Error(`拒绝归档不完整结果：${completed}/${total}，失败 ${errors}`)
    }
  ' "$1"
}

# 跑一次 QA speed 并在通过门禁后原子覆盖正式文件。用法：run_speed <正式输出> <bench 参数...>
run_speed() {
  local final_out="$1"; shift
  local temp_out
  temp_out="$(dirname "$final_out")/.$(basename "$final_out" .json).$$.json"
  rm -f "$temp_out"
  npm run bench -- --task qa --dataset qasper --speed "$@" --out "$temp_out" || { rm -f "$temp_out"; return 1; }
  assert_complete_v2 "$temp_out" || { rm -f "$temp_out"; return 1; }
  mv "$temp_out" "$final_out"
}

# 离线计算 Q（不调用模型）。--out 拒绝覆盖，派生文件先删再写。用法：run_q <候选结果> <Q 输出>
run_q() {
  local candidate="$1" q_out="$2"
  if [[ ! -f "$reference_out" ]]; then
    echo "缺少 Q 参考 ${reference_out#$repo_root/}，先运行 bench/run-ds-papermind.sh" >&2
    return 1
  fi
  rm -f "$q_out"
  npm run bench -- --compare "$reference_out" "$candidate" --q-config "$q_config" --out "$q_out"
}

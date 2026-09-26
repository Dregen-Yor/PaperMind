"""Laya 侧车：常驻进程，逐行读 JSON 请求、逐行写 JSON 响应。

权重从本地目录加载（不联网）。判定只喂「节标题 + 父路径 + 问题」，
不带正文——总上下文 512 token，装不下整节内文。
"""
import json
import sys

import laya_mlx as laya

if len(sys.argv) < 2:
    # Path(__file__).with_name("laya-mlx") 会落在 bench/src/jev/，那里没有权重；而调用方
    # mlxJudge.ts 的 defaultSpawn 每次都显式传路径，所以「缺参数」属编程错误，该响亮报错，
    # 而不是默默指向一个不存在的目录。
    sys.exit("usage: sidecar.py <model-dir>（如 models/laya/laya-mlx）")
MODEL_PATH = sys.argv[1]

INSTRUCTION = "Does `section` contain evidence that answers `question`?"

_agent = None


def get_agent():
    global _agent
    if _agent is None:
        _agent = laya.load(MODEL_PATH)
    return _agent


def score(req):
    agent = get_agent()
    scores = []
    for node in req["nodes"]:
        path = " > ".join(list(node.get("path") or []) + [node["title"]])
        result = agent.predict(
            {"question": req["query"], "section": path},
            {"evidence": {"type": "noul", "instructions": INSTRUCTION}},
        )
        scores.append(float(result["answers"]["evidence"]["noul"]))
    return scores


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = {"id": req_id, "scores": score(req)}
        except Exception as exc:  # noqa: BLE001 — 单条失败必须让请求方拿到明确错误
            out = {"id": req_id, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

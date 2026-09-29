"""JSON stdin bridge; all metric calculations belong to the pinned evaluator."""
import importlib.util
import json
import pathlib
import sys

sys.dont_write_bytecode = True
path = pathlib.Path(__file__).resolve().parents[2] / 'vendor' / 'qasper' / 'evaluator.py'
spec = importlib.util.spec_from_file_location('official_qasper', path)
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)
data = json.load(sys.stdin)
gold = evaluator.get_answers_and_evidence(data['gold'], False)
ids = data['ids']
if len(set(ids)) != len(ids) or any(q not in gold for q in ids):
    raise ValueError('Invalid expected question IDs')
gold = {q: gold[q] for q in ids}
predictions = data['predictions']
if any(q not in gold for q in predictions):
    raise ValueError('Unexpected prediction')
result = evaluator.evaluate(gold, predictions)
per_question = []
for q in ids:
    r = evaluator.evaluate({q: gold[q]}, predictions)
    per_question.append({'id': q, 'answerF1': r['Answer F1'], 'evidenceF1': None if data['method'] == 'R' else r['Evidence F1']})
json.dump({'answerF1': result['Answer F1'], 'evidenceF1': None if data['method'] == 'R' else result['Evidence F1'], 'perQuestion': per_question}, sys.stdout, allow_nan=False)

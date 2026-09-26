import { writeFile } from 'node:fs/promises'
import { normalizeQasperEntry, type QasperEntry } from '../../src/datasets/qasper'
import { benchPath } from '../../src/paths'
import type { EvalSample } from '../../src/types'

const ROWS_URL = 'https://datasets-server.huggingface.co/rows'
const DATASET = 'allenai/qasper'
const CONFIG = 'qasper'
const SPLIT = 'validation'
const PAGE_SIZE = 100
/**
 * 输出路径。默认仍是原位——但**补齐格式的副本务必用 `QASPER_OUT` 指到新文件**：
 * 直接覆写会换掉已记录基线所依赖的 gold 页，而该文件是 gitignored 的，
 * 覆写之后**无法从 git 恢复**。副本生成后必须先过保真门（逐篇 `pages`、逐题
 * `evidencePages` 与冻结文件全一致）才能拿去做对照。
 */
const OUT_PATH = () => process.env.QASPER_OUT ?? benchPath(import.meta.url, './qasper.jsonl')

/** 目标论文篇数；QASPER validation split 共 281 篇。 */
const LIMIT = Number(process.env.QASPER_LIMIT ?? '60')

async function fetchRows(offset: number, length: number) {
  const url = `${ROWS_URL}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=${length}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`QASPER 拉取失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = await res.json()
  return data.rows as Array<{ row: QasperEntry & { id: string } }>
}

/** 标注的答案结构（实际字段比 QasperEntry 声明多 yes_no 等，此处只取需要用的）。 */
type RawAnswer = QasperEntry['qas']['answers'][number][number]['answer']

/**
 * datasets-server 会把「list of struct」列式化：线上返回的 qas.answers[i] 是
 * `{ answer: RawAnswer[], annotation_id: string[], worker_id: string[] }`（问题 i 的
 * 各标注者答案横排），而 normalizeQasperEntry 消费的是
 * `answers[i] = [{ answer: RawAnswer }]`（标注者数组纵排）。
 * 此处做一层转置适配，保持归一化逻辑与单测的口径不变。
 */
function toCanonicalQas(row: QasperEntry): QasperEntry {
  const raw = row as unknown as {
    qas: { answers: Array<{ answer?: RawAnswer[] } | undefined> }
  }
  return {
    ...row,
    qas: {
      ...row.qas,
      answers: raw.qas.answers.map(perQuestion => (perQuestion?.answer ?? []).map(a => ({ answer: a }))),
    },
  }
}

const samples: EvalSample[] = []
for (let offset = 0; offset < LIMIT; offset += PAGE_SIZE) {
  const length = Math.min(PAGE_SIZE, LIMIT - offset)
  process.stdout.write(`拉取 offset=${offset} length=${length}...\n`)
  const rows = await fetchRows(offset, length)
  if (rows.length === 0) break

  for (const { row } of rows) {
    const sample = normalizeQasperEntry(row.id, toCanonicalQas(row))
    // 剔除没有任何可评测问题的论文
    if (sample.questions.length > 0 && sample.pages.length > 0) samples.push(sample)
  }
}

await writeFile(OUT_PATH(), samples.map(s => JSON.stringify(s)).join('\n') + '\n')

const questionCount = samples.reduce((n, s) => n + s.questions.length, 0)
const unanswerableCount = samples.reduce(
  (n, s) => n + s.questions.filter(q => q.unanswerable).length, 0,
)
const noEvidenceCount = samples.reduce(
  (n, s) => n + s.questions.filter(q => !q.unanswerable && q.evidencePages.length === 0).length, 0,
)

process.stdout.write(
  `\n已写入 ${OUT_PATH()}\n` +
  `论文 ${samples.length} 篇，问题 ${questionCount} 个\n` +
  `其中 unanswerable ${unanswerableCount} 个，evidence 反查失败 ${noEvidenceCount} 个\n`,
)

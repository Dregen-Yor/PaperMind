/**
 * 从上游**只读**拉取 QASPER 原始行（含 `full_text` 节结构），供人工冒烟脚本使用。
 *
 * 刻意不读 `bench/datasets/qasper/qasper.jsonl`：那是已归一化的冻结产物、不含节结构字段
 * （`loadQasperDataset` 只做 JSON.parse，不重跑 normalizeQasperEntry），且是既有基线的语料，
 * 重跑 `fetch.ts` 会覆写它。人工冒烟需要节结构时只能走这里。
 */
export interface QasperRawRow {
  id: string
  title: string
  /** 与 `qas.answers` 同序的并列数组——datasets-server 把「list of struct」列式化了。 */
  qas: { question: string[] }
  full_text: { section_name: string[]; paragraphs: string[][] }
}

const ROWS_URL = 'https://datasets-server.huggingface.co/rows'
const PAGE_SIZE = 100

export async function fetchQasperRows(limit = 60): Promise<QasperRawRow[]> {
  const rows: QasperRawRow[] = []
  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const url = `${ROWS_URL}?dataset=allenai%2Fqasper&config=qasper&split=validation`
      + `&offset=${offset}&length=${Math.min(PAGE_SIZE, limit - offset)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`QASPER 拉取失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = await res.json() as { rows: Array<{ row: QasperRawRow }> }
    rows.push(...data.rows.map(r => r.row))
  }
  return rows
}

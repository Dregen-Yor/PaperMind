import { describe, it, expect } from 'vitest'
import type { EvidenceBlock } from '../../../src/utils/evidenceBlock'
import type { SemanticTree } from '../../../src/utils/semanticTree'
import { renderTreeOutline, renderTreeReport } from '../treeInspect'

const blocks: EvidenceBlock[] = [
  { id: 'B001', rawText: 'ABSTRACT_TEXT', normalizedText: 'abstract', pieces: [{ page: 0, text: 'ABSTRACT_TEXT' }], startPage: 0, endPage: 0, order: 0, previousId: null, nextId: 'B002', sourceType: 'body' },
  { id: 'B002', rawText: 'We propose an attention-only architecture.', normalizedText: 'we propose', pieces: [{ page: 1, text: 'We propose an ' }, { page: 2, text: 'attention-only architecture.' }], startPage: 1, endPage: 2, order: 1, previousId: 'B001', nextId: 'B003', sourceType: 'body' },
  { id: 'B003', rawText: 'RESULTS_TEXT', normalizedText: 'results', pieces: [{ page: 3, text: 'RESULTS_TEXT' }], startPage: 3, endPage: 3, order: 2, previousId: 'B002', nextId: null, sourceType: 'table-caption' },
]

const tree: SemanticTree = {
  schemaVersion: 1,
  promptVersion: 'v1',
  root: {
    id: 'r', label: '自注意力替代循环结构的可行性', description: '中心主张', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [
      {
        id: 'n1', label: '跨位置并行对齐', description: '支撑该主张的机制', relationToParent: 'constitutes',
        evidenceRefs: ['B002', 'B003'], children: [],
      },
      {
        id: 'n2', label: '序列长度带来的平方代价', description: '该主张的适用边界', relationToParent: 'limits',
        evidenceRefs: ['B003'], children: [],
      },
    ],
  },
}

describe('renderTreeOutline — 人工结构检查（§阶段 E 第 4 步）', () => {
  it('逐层打印节点名、语义关系与页码', () => {
    const md = renderTreeOutline(tree, blocks)
    expect(md).toContain('自注意力替代循环结构的可行性')
    expect(md).toContain('跨位置并行对齐')
    expect(md).toContain('constitutes')
    expect(md).toContain('limits')
    // 页码用原始 1-based 表达，人工核对时与 PDF 直接对上
    expect(md).toContain('p.2–3')
  })

  it('列出每个节点的证据块 ID 与原文片段，方便判断是否只是目录复刻', () => {
    const md = renderTreeOutline(tree, blocks)
    expect(md).toContain('B002')
    expect(md).toContain('We propose an attention-only architecture.')
  })

  it('节点描述只作为导航元数据单独标注', () => {
    const md = renderTreeOutline(tree, blocks)
    expect(md).toContain('中心主张')
    expect(md).toContain('（导航元数据，非事实依据）')
  })

  it('引用不存在的块不会抛错，原样列入待查清单', () => {
    const broken: SemanticTree = {
      ...tree,
      root: { ...tree.root, evidenceRefs: ['B404'], children: [] },
    }
    const md = renderTreeOutline(broken, blocks)
    expect(md).toContain('B404')
  })
})

describe('renderTreeReport', () => {
  it('逐篇输出小节，并标注建树失败', () => {
    const md = renderTreeReport([
      { paperId: 'p1', outcome: { tree, blocks } },
      { paperId: 'p2', failure: 'invalid-structure' },
    ])
    expect(md).toContain('## p1')
    expect(md).toContain('跨位置并行对齐')
    expect(md).toContain('## p2')
    expect(md).toContain('invalid-structure')
  })
})

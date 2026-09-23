import { describe, expect, it } from 'vitest'
import { isHeadingLine } from '../utils/sectionHeadings'

describe('isHeadingLine', () => {
  it('识别 Markdown 标题并去掉井号', () => {
    expect(isHeadingLine('## 3.2 Model Architecture')).toBe('3.2 Model Architecture')
  })

  it('识别中文「第N章/节」与中文序号标题', () => {
    expect(isHeadingLine('第二章 相关工作')).toBe('第二章 相关工作')
    expect(isHeadingLine('一、研究背景')).toBe('一、研究背景')
  })

  it('识别常见英文章节名', () => {
    expect(isHeadingLine('Introduction')).toBe('Introduction')
    expect(isHeadingLine('Experiments')).toBe('Experiments')
  })

  it('长句子带编号时按正文处理，避免假阳性', () => {
    expect(isHeadingLine('1. 我们发现模型在 Europarl 上的表现显著优于此前所有基线，尤其是在低资源语言对上。')).toBeNull()
  })

  it('普通正文行返回 null', () => {
    expect(isHeadingLine('We evaluate on Europarl and MultiUN.')).toBeNull()
    expect(isHeadingLine('')).toBeNull()
  })
})

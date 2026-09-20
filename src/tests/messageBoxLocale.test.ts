import { describe, expect, it } from 'vitest'
import { elementPlusOptions } from '../plugins/element'

describe('Element Plus 全局选项（#4）', () => {
  it('挂载 zh-cn locale，确认框按钮文案为中文', () => {
    expect(elementPlusOptions.locale.name).toBe('zh-cn')
    const messagebox = (elementPlusOptions.locale as any).el?.messagebox
    expect(messagebox?.confirm).toBe('确定')
    expect(messagebox?.cancel).toBe('取消')
  })
})

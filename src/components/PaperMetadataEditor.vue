<template>
  <el-dialog :model-value="true" title="编辑论文信息" width="min(520px, calc(100vw - 32px))" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @update:model-value="!saving && emit('close')">
    <form id="paper-metadata-form" class="metadata-form" @submit.prevent="save">
      <label>标题<input v-model="title" aria-label="论文标题" :disabled="saving" required /></label>
      <label>作者<textarea v-model="authors" aria-label="论文作者" :disabled="saving" rows="3" /></label>
      <p class="field-hint">多位作者可用分号或换行分隔，也支持逗号。</p>
      <label>年份<input v-model="year" aria-label="发表年份" type="number" min="1" max="9999" step="1" :disabled="saving" placeholder="可留空" /></label>
      <label>标签<input v-model="tags" aria-label="论文标签" :disabled="saving" placeholder="用逗号、分号或换行分隔" /></label>
      <p v-if="error" role="alert" class="metadata-error">{{ error }}</p>
    </form>
    <template #footer>
      <el-button :disabled="saving" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!title.trim() || saving" native-type="submit" form="paper-metadata-form">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { usePaperStore, type Paper } from '../stores/paper'

const props = defineProps<{ paper: Paper }>()
const emit = defineEmits<{ close: [] }>()
const store = usePaperStore()
const title = ref(props.paper.title || props.paper.fileName || '')
const authors = ref((props.paper.authors ?? []).join('\n'))
const year = ref<string | number>(props.paper.year ? String(props.paper.year) : '')
const tags = ref((props.paper.tags ?? []).join('，'))
const saving = ref(false)
const error = ref('')

function entries(value: string) {
  return [...new Set(value.split(/[,，;；\n]+/).map(item => item.trim()).filter(Boolean))]
}

async function save() {
  if (saving.value) return
  error.value = ''
  if (!title.value.trim()) { error.value = '请输入论文标题'; return }
  const yearText = String(year.value).trim()
  const numericYear = yearText ? Number(yearText) : 0
  if (!Number.isInteger(numericYear) || (yearText && numericYear < 1) || numericYear > 9999) {
    error.value = '年份须为 1–9999 的整数，或留空'
    return
  }
  saving.value = true
  try {
    if (!store.getPaper(props.paper.id)) throw new Error('论文已不存在，请关闭编辑窗口')
    await store.updatePaper(props.paper.id, {
      title: title.value.trim(), authors: entries(authors.value), year: numericYear, tags: entries(tags.value),
    })
    emit('close')
  } catch (cause) {
    error.value = `保存失败：${cause instanceof Error ? cause.message : String(cause)}。请重试。`
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.metadata-form { display: flex; flex-direction: column; gap: 16px; }
.metadata-form label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-secondary); }
.metadata-form input, .metadata-form textarea { width: 100%; box-sizing: border-box; padding: 9px 12px; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; font: inherit; resize: vertical; }
.metadata-form input:focus, .metadata-form textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.field-hint { margin-top: -10px; color: var(--text-muted); font-size: 12px; }
.metadata-error { color: var(--danger); font-size: 13px; }
</style>

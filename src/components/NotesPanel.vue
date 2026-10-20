<template>
  <div class="notes-panel">
    <div class="notes-header">
      <span class="notes-title">高亮与笔记</span>
      <span class="notes-count tabular-nums">{{ highlights.length }} 条</span>
    </div>
    <p v-if="error" class="notes-error" role="alert">{{ error }}</p>
    <el-scrollbar class="notes-body">
      <div v-if="highlights.length === 0" class="notes-empty">
        <el-icon :size="30" aria-hidden="true"><EditPen /></el-icon>
        <h3 class="font-display">记下值得回看的地方</h3>
        <p>在原文中选中一段文字，点击「高亮」，<br />就能在这里写下你的理解。</p>
      </div>
      <div v-for="h in highlights" :key="h.id" class="note-item">
        <button type="button" class="note-jump" @click="emit('jump', h.pageNum)">
          第 {{ h.pageNum }} 页
        </button>
        <blockquote class="note-text">{{ h.text }}</blockquote>
        <el-input
          :model-value="draftNotes[h.id] ?? h.note"
          @update:model-value="draftNotes[h.id] = $event"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="写下你的思考…"
          :aria-label="'第 ' + h.pageNum + ' 页高亮的笔记'"
          @blur="save(h)"
        />
        <button type="button" class="note-del" @click="del(h)">删除</button>
      </div>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { EditPen } from '@element-plus/icons-vue'
import { usePaperStore, type Highlight } from '../stores/paper'

const props = defineProps<{ paperId: string }>()
const emit = defineEmits<{ (e: 'jump', page: number): void }>()

const paperStore = usePaperStore()
const highlights = computed(() => paperStore.highlightsByPaper[props.paperId] ?? [])
const draftNotes = ref<Record<string, string>>(Object.create(null))
const error = ref('')
let generation = 0

watch(() => props.paperId, async (id) => {
  const current = ++generation
  error.value = ''
  try {
    await paperStore.loadHighlights(id)
  } catch {
    if (current === generation) error.value = '加载高亮失败，请重新打开论文'
  }
}, { immediate: true })

async function save(h: Highlight) {
  const current = generation
  const note = draftNotes.value[h.id] ?? h.note
  error.value = ''
  try {
    await paperStore.updateHighlight(h.id, { note }, h.paperId)
    if (current === generation && draftNotes.value[h.id] === note) delete draftNotes.value[h.id]
  } catch {
    if (current === generation) error.value = '保存笔记失败，请重试'
  }
}

async function del(h: Highlight) {
  const { id, paperId } = h
  const current = generation
  try {
    await ElMessageBox.confirm('删除这条高亮？', '删除', { type: 'warning' })
    if (current === generation) error.value = ''
  } catch { return }
  try {
    await paperStore.removeHighlight(id, paperId)
  } catch {
    if (current === generation) error.value = '删除高亮失败，请重试'
  }
}
</script>

<style scoped>
.notes-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg-surface); }
.notes-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px 14px; }
.notes-title { font-size: 12px; font-weight: 500; color: var(--text-secondary); }
.notes-count { font-size: 11px; color: var(--text-muted); background: var(--bg-elevated); padding: 2px 7px; border-radius: 4px; }
.notes-error { margin: 0 22px 12px; color: var(--danger); font-size: 12px; }
.notes-body { flex: 1; min-height: 0; padding: 0 20px 20px; }
.notes-empty { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 70px 4px; color: var(--text-muted); text-align: center; }
.notes-empty .el-icon { color: var(--accent); margin-bottom: 6px; }
.notes-empty h3 { font-size: 22px; font-weight: 500; color: var(--text-primary); }
.notes-empty p { font-size: 12px; line-height: 1.95; }
.note-item { display: flex; flex-direction: column; gap: 12px; padding: 18px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-base); }
.note-jump { align-self: flex-start; border: 0; background: var(--gold-dim); color: var(--gold); font-size: 11px; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
.note-jump:hover { background: #eadebf; }
.note-text { font-family: var(--font-reading); font-size: 14px; color: var(--text-secondary); line-height: 1.85; border-left: 2px solid #c5aa70; padding-left: 12px; overflow-wrap: anywhere; }
.note-item :deep(.el-textarea__inner) { font-size: 12px; padding: 10px 12px; line-height: 1.9; }
.note-del { align-self: flex-end; border: 0; background: transparent; color: var(--text-muted); font-size: 11px; cursor: pointer; padding: 4px 7px; border-radius: 4px; }
.note-del:hover { color: var(--danger); background: var(--danger-dim); }
</style>

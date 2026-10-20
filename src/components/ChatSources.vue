<template>
  <div class="chat-sources">

      <div class="left-header">
        <div class="source-heading">
          <h2><el-icon aria-hidden="true"><Files /></el-icon> 参考文献</h2>
          <button v-if="collapsible" type="button" class="source-close" aria-label="关闭参考文献面板" @click="emit('close')"><el-icon aria-hidden="true"><Close /></el-icon></button>
        </div>
        <el-select :model-value="activeKbId" @update:model-value="emit('update:activeKbId', $event)" aria-label="选择知识库" style="width:100%">
          <el-option v-for="kb in paperStore.knowledgeBases" :key="kb.id" :label="kb.name" :value="kb.id" />
        </el-select>
      </div>
      <div class="left-subheader"><span>选择本次问答的论文</span><span class="selected-count tabular-nums">{{ selectedPaperIds.length }} 已选</span></div>
      <section v-if="selectedPaperIds.length" class="selected-papers" aria-label="已选论文">
        <h3>已选论文（所有知识库）</h3>
        <ul>
          <li v-for="paper in selectedPapers" :key="paper.id">
            <span>{{ paper.title }}</span>
            <button type="button" :aria-label="'移除论文 ' + paper.id" @click="emit('toggle-paper', paper.id)">移除</button>
          </li>
        </ul>
      </section>
      <el-scrollbar class="paper-list">
        <div v-for="p in kbPapers" :key="p.id" class="paper-list-item" :class="{ selected: selectedPaperIds.includes(p.id) }">
          <el-checkbox :model-value="selectedPaperIds.includes(p.id)" :aria-label="'选择论文 ' + (p.title || p.fileName)" @change="emit('toggle-paper', p.id)">
            <span class="pli-info">
              <span class="pli-title">{{ p.title || p.fileName }}</span>
              <span class="pli-meta">{{ p.authors?.[0] || '作者待补充' }}<span v-if="p.year">, {{ p.year }}</span></span>
            </span>
          </el-checkbox>
          <div class="pli-index">
            <el-tooltip v-if="chatStore.indexedPapers.has(p.id)" content="已建立索引" placement="right"><el-icon class="index-done" aria-label="已建立索引"><CircleCheck /></el-icon></el-tooltip>
            <el-icon v-else-if="chatStore.indexingPapers.has(p.id)" class="index-loading is-loading" aria-label="正在建立索引"><Loading /></el-icon>
            <el-tooltip v-else content="建立索引以检索论文内容" placement="right"><el-button size="small" text @click="emit('index-paper', p.id)" :aria-label="'为论文建立索引：' + (p.title || p.fileName)"><el-icon aria-hidden="true"><Download /></el-icon></el-button></el-tooltip>
          </div>
        </div>
        <div v-if="kbPapers.length === 0" class="sources-empty"><p>这个知识库还没有论文。</p><router-link to="/library">去文献库导入 PDF</router-link></div>
      </el-scrollbar>

      <div class="left-footer">
        <h3 class="conv-list-label">历史对话</h3>
        <el-scrollbar max-height="230px">
          <div v-for="c in allConversations" :key="c.id" class="conv-item" :class="{ active: activeConvId === c.id }">
            <button type="button" class="conv-open" :aria-current="activeConvId === c.id ? 'true' : undefined" @click="emit('select-conversation', c)">
              <el-icon aria-hidden="true"><ChatLineRound /></el-icon><span class="conv-title">{{ c.title }}</span>
            </button>
            <button type="button" class="conv-del" :aria-label="'删除对话 ' + c.title" @click="emit('delete-conversation', c.id)"><el-icon aria-hidden="true"><Close /></el-icon></button>
          </div>
          <p v-if="allConversations.length === 0" class="no-conversations">你的讨论会保留在这里。</p>
        </el-scrollbar>
      </div>
      </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChatLineRound, Close, Files, CircleCheck, Loading, Download } from '@element-plus/icons-vue'
import { usePaperStore } from '../stores/paper'
import { useChatStore, type Conversation } from '../stores/chat'

const props = defineProps<{
  activeKbId: string
  selectedPaperIds: string[]
  activeConvId: string
  collapsible?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:activeKbId', id: string): void
  (e: 'toggle-paper', id: string): void
  (e: 'index-paper', id: string): void
  (e: 'select-conversation', conversation: Conversation): void
  (e: 'delete-conversation', id: string): void
  (e: 'close'): void
}>()
const paperStore = usePaperStore()
const chatStore = useChatStore()
const selectedPapers = computed(() => props.selectedPaperIds.map(id => {
  const paper = paperStore.papers.find(record => record.id === id)
  return { id, title: paper ? paper.title || paper.fileName || id : `论文记录已缺失（${id}）` }
}))
const kbPapers = computed(() => paperStore.getPapersByKb(props.activeKbId).value)
const allConversations = computed(() => chatStore.conversations)
</script>

<style scoped>
.selected-papers { margin: 0 20px 12px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; max-height: 200px; overflow-y: auto; font-size: 11px; }
.selected-papers h3 { font-size: 11px; font-weight: 500; color: var(--text-muted); margin-bottom: 8px; }
.selected-papers ul { list-style: none; padding: 0; margin: 0; }
.selected-papers li { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; }
.selected-papers li span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.selected-papers button { flex-shrink: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 11px; }
.chat-sources { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); }
.left-header { padding: 26px 20px 14px; }
.source-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.source-heading h2 { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.source-heading .el-icon { color: var(--accent); font-size: 17px; }
.source-close { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; }
.left-header :deep(.el-select__placeholder) { font-size: 12px; }
.left-subheader { display: flex; justify-content: space-between; padding: 4px 20px 14px; font-size: 11px; color: var(--text-muted); }
.selected-count { color: var(--accent); }
.paper-list { flex: 1; min-height: 0; padding: 0 10px; }
.paper-list-item { display: flex; align-items: center; gap: 3px; padding: 12px 10px; border-radius: 6px; margin-bottom: 4px; border: 1px solid transparent; transition: background 0.15s, border-color 0.15s; }
.paper-list-item:hover { background: var(--bg-elevated); }
.paper-list-item.selected { background: var(--accent-dim); border-color: #d9c9b4; }
.paper-list-item :deep(.el-checkbox) { height: auto; align-items: flex-start; margin: 0; flex: 1; min-width: 0; }
.paper-list-item :deep(.el-checkbox__input) { margin-top: 3px; }
.paper-list-item :deep(.el-checkbox__label) { min-width: 0; padding-left: 9px; white-space: normal; }
.pli-info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pli-title { font-size: 12px; line-height: 1.65; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.pli-meta { font-size: 10px; line-height: 1.5; color: var(--text-muted); }
.pli-index { flex-shrink: 0; width: 22px; display: flex; align-items: center; justify-content: center; }
.pli-index .el-button { padding: 4px; }
.index-done { color: var(--success); font-size: 13px; }
.index-loading { color: var(--text-muted); font-size: 13px; }
.sources-empty { padding: 28px 12px; font-size: 12px; color: var(--text-muted); line-height: 1.8; text-align: center; }
.sources-empty a { display: inline-block; margin-top: 10px; color: var(--accent); text-underline-offset: 3px; }
.left-footer { border-top: 1px solid var(--border); padding: 20px 10px; }
.conv-list-label { font-size: 11px; font-weight: 500; color: var(--text-muted); padding: 0 10px 12px; }
.conv-item { display: flex; align-items: center; gap: 4px; border-radius: 6px; color: var(--text-secondary); }
.conv-item:hover { background: var(--bg-elevated); }
.conv-item.active { background: var(--accent-dim); color: var(--accent); }
.conv-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: inherit; font-size: 12px; text-align: left; padding: 10px; cursor: pointer; border-radius: 6px; }
.conv-open .el-icon { flex-shrink: 0; font-size: 14px; }
.conv-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-del { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 5px; flex-shrink: 0; border: 0; background: transparent; color: var(--text-muted); border-radius: 4px; cursor: pointer; opacity: 0; }
.conv-item:hover .conv-del, .conv-item:focus-within .conv-del { opacity: 1; }
.conv-del:hover { color: var(--danger); background: var(--danger-dim); }
.no-conversations { padding: 8px 10px; font-size: 11px; color: var(--text-muted); }
@media (hover: none) {
  .conv-del { opacity: 1; }
}
</style>

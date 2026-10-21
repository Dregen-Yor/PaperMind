<template>
  <div class="abstract-panel">
    <div v-if="loadingCache" class="abstract-state" role="status">正在读取已保存的摘要…</div>

    <div v-else-if="!report" class="abstract-state abstract-empty">
      <div class="abstract-mark" aria-hidden="true"><el-icon><Document /></el-icon></div>
      <h2>从原文，读懂整篇论文</h2>
      <p>生成一份带原文依据的图文摘要，梳理研究问题、方法、结果与局限。生成后会保存在本机。</p>
      <el-button type="primary" size="large" :loading="generating" @click="generate()">生成摘要</el-button>
      <p v-if="generating" class="abstract-progress" role="status">{{ progress }}</p>
      <p v-if="error" class="abstract-error" role="alert">{{ error }}</p>
    </div>

    <div v-else class="abstract-document">
      <header class="abstract-document-header">
        <div>
          <h2>论文摘要</h2>
          <p>已保存于本机</p>
        </div>
        <el-button v-if="!report.truncated" text size="small" :loading="generating" @click="generate(true)">重新生成</el-button>
      </header>
      <p v-if="generating && !report.truncated" class="abstract-progress" role="status">{{ progress }}</p>
      <div v-if="report.truncated" class="abstract-continuation">
        <span>摘要尚未生成完毕</span>
        <el-button :loading="generating" @click="generate()">继续生成</el-button>
        <p v-if="generating" role="status">{{ progress }}</p>
      </div>
      <p v-if="error" class="abstract-error" role="alert">{{ error }}</p>
      <MarkdownContent class="abstract-content" :content="report.content" @open-source="emit('open-source', $event)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Document } from '@element-plus/icons-vue'
import MarkdownContent from './MarkdownContent.vue'
import { useChatStore } from '../stores/chat'
import type { SourceRef } from '../utils/sourceRef'
import type { PaperAbstractReport } from '../utils/paperAbstract'

const props = defineProps<{ paperId: string }>()
const emit = defineEmits<{ (event: 'open-source', source: SourceRef): void }>()
const chatStore = useChatStore()
const cachedReport = ref<PaperAbstractReport | null>(null)
const readingCache = ref(true)
const cacheError = ref('')
const state = computed(() => chatStore.paperAbstractStates[props.paperId])
const report = computed(() => state.value?.report ?? cachedReport.value)
const loadingCache = computed(() => readingCache.value && !state.value)
const generating = computed(() => state.value?.generating ?? false)
const error = computed(() => state.value?.error ?? cacheError.value)
const progress = computed(() => chatStore.abstractProgress[`paper-abstract:${props.paperId}`] || '正在生成摘要…')
let generation = 0

watch(() => props.paperId, async paperId => {
  const current = ++generation
  cachedReport.value = null
  cacheError.value = ''
  readingCache.value = true
  try {
    const saved = await window.db.paperAbstract.get(paperId)
    if (current === generation) cachedReport.value = saved
  } catch (cause) {
    if (current === generation) cacheError.value = cause instanceof Error ? cause.message : '摘要读取失败，请重试'
  } finally {
    if (current === generation) readingCache.value = false
  }
}, { immediate: true })

async function generate(force = false) {
  if (generating.value) return
  const paperId = props.paperId
  const current = generation
  cacheError.value = ''
  try {
    const saved = await chatStore.generatePaperAbstract(paperId, force)
    if (current === generation) cachedReport.value = saved
  } catch (cause) {
    if (current === generation) cacheError.value = cause instanceof Error ? cause.message : '摘要生成失败，请重试'
  }
}
</script>

<style scoped>
.abstract-panel { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg-surface); }
.abstract-state, .abstract-document { max-width: 760px; margin: 0 auto; padding: 34px 32px 64px; }
.abstract-state { color: var(--text-secondary); font-size: 13px; }
.abstract-empty { padding-top: min(13vh, 112px); text-align: left; }
.abstract-mark { display: grid; place-items: center; width: 52px; height: 52px; margin-bottom: 28px; border: 1px solid var(--border-light); border-radius: 12px; color: var(--accent); background: var(--bg-base); font-size: 25px; }
.abstract-empty h2, .abstract-document-header h2 { font-family: var(--font-reading); font-size: clamp(24px, 2.5vw, 31px); font-weight: 600; line-height: 1.3; color: var(--text-primary); }
.abstract-empty > p:not(.abstract-progress, .abstract-error) { max-width: 36ch; margin: 17px 0 28px; font-size: 14px; line-height: 1.85; color: var(--text-secondary); }
.abstract-empty .el-button { min-width: 128px; }
.abstract-progress { margin-top: 18px; color: var(--text-secondary); line-height: 1.6; }
.abstract-error { margin-top: 18px; color: var(--danger); font-size: 13px; line-height: 1.6; }
.abstract-document-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.abstract-document-header p { margin-top: 8px; color: var(--text-muted); font-size: 12px; }
.abstract-content { padding-top: 26px; font-size: 14px; line-height: 1.9; }
.abstract-continuation { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 22px; padding: 12px 15px; border-left: 3px solid var(--gold); background: var(--gold-dim); color: var(--text-secondary); font-size: 12px; }
.abstract-continuation p { flex-basis: 100%; }
@media (max-width: 520px) {
  .abstract-state, .abstract-document { padding: 28px 20px 48px; }
  .abstract-empty { padding-top: 64px; }
}
</style>

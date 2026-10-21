<template>
  <section class="web-abstract-panel" aria-label="网页摘要">
    <div v-if="loading" class="abstract-state" role="status">正在读取已保存的摘要…</div>
    <div v-else-if="!snapshot" class="abstract-state">
      <h2>从原网页，读懂核心内容</h2>
      <p>先打开并保存网页，或在问答面板中选择一个已保存的网页。</p>
    </div>
    <div v-else-if="!content" class="abstract-state">
      <h2>从原网页，读懂核心内容</h2>
      <p>根据“{{ snapshot.title }}”的已保存快照生成图文摘要，保留关键原图、公式及出处。仅覆盖此快照，不包含链接中的其他页面；动画以保存时的静态画面为准。</p>
      <p class="source-note">快照保存于 {{ new Date(snapshot.capturedAt).toLocaleString() }} · 摘要生成后保存在本机</p>
      <el-button type="primary" size="large" :loading="busy" @click="emit('generate', false)">生成摘要</el-button>
      <p v-if="busy" role="status">{{ progress }} <el-button text size="small" @click="emit('stop')">停止</el-button></p>
      <p v-if="error" class="abstract-error" role="alert">{{ error }}</p>
    </div>
    <article v-else class="abstract-document">
      <header>
        <div><h2>网页摘要</h2><p class="source-note">{{ snapshot.title }} · 依据已保存的当前页面快照</p></div>
        <el-button text size="small" :loading="busy" @click="emit('generate', true)">重新生成</el-button>
      </header>
      <p v-if="busy" role="status">{{ progress }} <el-button text size="small" @click="emit('stop')">停止</el-button></p>
      <p v-if="truncated" class="abstract-error">摘要尚未生成完整，请继续生成。</p>
      <el-button v-if="truncated" :loading="busy" @click="emit('generate', false)">继续生成</el-button>
      <p v-if="error" class="abstract-error" role="alert">{{ error }}</p>
      <MarkdownContent :content="content" />
    </article>
  </section>
</template>
<script setup lang="ts">
import MarkdownContent from './MarkdownContent.vue'
import type { WebSnapshotPreview } from '../types/webQa'
defineProps<{ snapshot: WebSnapshotPreview | null; content: string; busy: boolean; loading: boolean;
  progress: string; error: string; truncated: boolean }>()
const emit = defineEmits<{ (event: 'generate', force: boolean): void; (event: 'stop'): void }>()
</script>
<style scoped>
.web-abstract-panel { height: 100%; overflow-y: auto; background: var(--bg-surface); }
.abstract-state, .abstract-document { max-width: 760px; margin: 0 auto; padding: 34px 32px 64px; font-size: 14px; line-height: 1.85; color: var(--text-secondary); }
.abstract-state { padding-top: min(13vh, 112px); }
h2 { font-family: var(--font-reading); font-size: clamp(24px, 2.5vw, 31px); font-weight: 600; line-height: 1.3; color: var(--text-primary); }
p { margin: 17px 0; }
.source-note { font-size: 12px; color: var(--text-muted); }
.abstract-error { color: var(--danger); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 26px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
@media (max-width: 520px) { .abstract-state, .abstract-document { padding: 28px 20px 48px; } }
</style>

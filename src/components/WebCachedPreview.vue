<template>
  <article class="cached-page" aria-label="本地缓存网页">
    <header class="cached-header">
      <span class="cached-kicker">本地缓存 · {{ new Date(snapshot.capturedAt).toLocaleString('zh-CN') }}</span>
      <h1>{{ snapshot.title || snapshot.finalUrl }}</h1>
      <span class="cached-url">{{ snapshot.finalUrl }}</span>
      <button type="button" data-action="open-source" @click="emit('open-source')">打开原网页 ↗</button>
    </header>
    <div class="cached-body">
      <p v-if="loadError" class="cached-note" role="status">{{ loadError }}</p>
      <p v-else-if="!snapshot.hasOriginalAppearance" class="cached-note">这份旧缓存只保存了阅读内容。点击上方“更新缓存”可保存网站原貌；已有对话仍依据原快照。</p>
      <p v-if="!snapshot.preview.blocks.length" class="cached-note">缓存预览不可用；已保存的问答会话仍可查看。</p>
      <article v-for="(block, index) in snapshot.preview.blocks" :key="index" class="cached-block">
        <component :is="`h${Math.min(6, Math.max(1, block.level ?? 2))}`" v-if="block.kind === 'heading'">{{ block.text }}</component>
        <pre v-else-if="block.kind === 'code'">{{ block.text }}</pre>
        <blockquote v-else-if="block.kind === 'quote'">{{ block.text }}</blockquote>
        <p v-else>{{ block.text }}</p>
      </article>
      <p v-if="snapshot.preview.truncated" class="cached-note">缓存预览已截断；问答仍依据完整快照。</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { WebSnapshotPreview } from '../types/webQa'
defineProps<{ snapshot: WebSnapshotPreview; loadError?: string }>()
const emit = defineEmits<{ 'open-source': [] }>()
</script>

<style scoped>
.cached-page { height: 100%; overflow-y: auto; color: var(--text-primary); background: var(--bg-surface); }
.cached-header { display: flex; flex-direction: column; gap: 8px; padding: 30px clamp(22px, 6vw, 70px) 24px; border-bottom: 1px solid var(--border); }
.cached-kicker { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .1em; }
.cached-header h1 { font: 500 clamp(23px, 3vw, 34px)/1.3 var(--font-reading); overflow-wrap: anywhere; }
.cached-url { color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
.cached-header button { align-self: flex-start; border: 0; padding: 4px 0; color: var(--accent); background: transparent; cursor: pointer; font-size: 12px; }
.cached-body { max-width: 800px; padding: 30px clamp(22px, 6vw, 70px) 80px; font: 15px/1.9 var(--font-reading); }
.cached-block { margin-bottom: 18px; overflow-wrap: anywhere; }
.cached-block h1, .cached-block h2, .cached-block h3, .cached-block h4, .cached-block h5, .cached-block h6 { margin: 26px 0 12px; line-height: 1.4; }
.cached-block p { white-space: pre-wrap; }
.cached-block pre { overflow-x: auto; padding: 14px; background: var(--bg-base); font: 12px/1.6 monospace; white-space: pre-wrap; }
.cached-block blockquote { padding-left: 16px; border-left: 2px solid var(--accent); color: var(--text-secondary); }
.cached-note { color: var(--text-muted); font-size: 12px; }
</style>

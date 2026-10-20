<template>
  <div :class="{ 'paper-report': hasPaperEvidence }">
    <div ref="root" v-html="html" @click="activate" @keydown="onKeydown" />
    <el-dialog v-model="previewVisible" title="原文图片" width="min(1000px, 94vw)" append-to-body>
      <img class="asset-preview" :src="previewSource" :alt="previewAlt" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElDialog } from 'element-plus'
import { renderMarkdown } from '../utils/markdown'
import { IMAGE_DATA_PATTERN, MAX_IMAGE_BYTES } from '../utils/doclingDocument'
import type { SourceRef } from '../utils/sourceRef'
import { validEvidenceRegion } from '../utils/sourceRef'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ (event: 'open-source', source: SourceRef): void }>()
const html = computed(() => renderMarkdown(props.content))
const hasPaperEvidence = computed(() => props.content.includes('paper-source:'))
const root = ref<HTMLElement>()
const previewVisible = ref(false)
const previewSource = ref('')
const previewAlt = ref('')
const localAssets = new Map<string, Promise<string | null>>()
let generation = 0

watch(() => props.content, async () => {
  const current = ++generation
  await nextTick()
  if (!root.value || current !== generation) return
  const images = Array.from(root.value.querySelectorAll<HTMLImageElement>('img[data-asset-id]'))
  await Promise.all(images.map(async image => {
    const id = image.dataset.assetId!
    let request = localAssets.get(id)
    if (!request) {
      request = window.db.docling.readAsset(id).catch(() => null)
      localAssets.set(id, request)
    }
    const data = await request
    if (current !== generation || !root.value?.contains(image)) return
    if (data && IMAGE_DATA_PATTERN.test(data) && data.length <= MAX_IMAGE_BYTES * 1.4) {
      image.src = data
      image.tabIndex = 0
      image.setAttribute('role', 'button')
      image.setAttribute('aria-label', `放大原图：${image.alt}`)
      image.addEventListener('error', () => showMissing(image), { once: true })
    } else showMissing(image)
  }))
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => { generation++; localAssets.clear() })

function showMissing(image: HTMLImageElement) {
  const feedback = document.createElement('span')
  feedback.className = 'asset-error'
  feedback.textContent = `${image.alt || '原文图片'}（原图不可用）`
  image.replaceWith(feedback)
}
function activate(event: Event) {
  const target = event.target instanceof Element ? event.target : null
  const source = target?.closest<HTMLElement>('[data-paper-id][data-page]')
  if (source && root.value?.contains(source)) {
    event.preventDefault()
    const page = Number(source.dataset.page)
    const end = Number(source.dataset.endPage ?? page)
    if (source.dataset.paperId && Number.isSafeInteger(page) && page >= 0) {
      const values = source.dataset.region?.split(',').map(Number)
      const region = values?.length === 4 ? { x: values[0], y: values[1], width: values[2], height: values[3] } : undefined
      emit('open-source', { label: source.textContent || `p${page + 1}`, paperId: source.dataset.paperId, startPage: page, endPage: Number.isSafeInteger(end) && end >= page ? end : page,
        ...(validEvidenceRegion(region) ? { region } : {}), ...(source.dataset.quote ? { quote: source.dataset.quote } : {}) })
    }
    return
  }
  const image = target?.closest<HTMLImageElement>('img[data-asset-id]')
  if (image?.src && root.value?.contains(image)) {
    event.preventDefault()
    previewSource.value = image.src
    previewAlt.value = image.alt
    previewVisible.value = true
  }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') activate(event)
}
</script>

<style scoped>
:deep(img[data-asset-id]) { display: block; max-width: 100%; height: auto; margin: 1rem auto; border-radius: 5px; cursor: zoom-in; }
:deep(img[data-asset-id]:focus-visible), :deep(.paper-source:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
:deep(.paper-source) { color: var(--accent); cursor: pointer; font-size: .82em; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.paper-report :deep(p), .paper-report :deep(h1), .paper-report :deep(h2), .paper-report :deep(h3) { max-inline-size: 76ch; text-wrap: pretty; line-break: strict; }
.paper-report :deep(p .paper-source) { margin-inline: .12em; vertical-align: .08em; }
:deep(.paper-evidence) { margin: 1.35rem 0 1.55rem; padding-left: 13px; border-left: 2px solid var(--border-light); max-width: min(100%, 780px); }
:deep(.paper-evidence-media) { min-width: 0; overflow-x: auto; background: var(--bg-surface); }
:deep(.paper-evidence--image .paper-evidence-media) { display: flex; justify-content: center; align-items: center; padding: 10px; border: 1px solid var(--border); border-radius: 5px; }
:deep(.paper-evidence--image img[data-asset-id]) { max-height: 520px; width: auto; object-fit: contain; margin: 0; }
:deep(.paper-evidence--formula .paper-evidence-media) { padding: 12px 4px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
:deep(.paper-evidence--formula .katex-display) { margin: 0; padding: 0; }
:deep(.paper-evidence figcaption) { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding-top: 7px; font-family: var(--font-ui); font-size: 11px; line-height: 1.5; color: var(--text-secondary); }
:deep(.paper-evidence-label) { font-weight: 600; }
:deep(.paper-evidence-pages) { display: inline-flex; flex-wrap: wrap; gap: 7px; }
:deep(.paper-evidence-pages .paper-source) { font-size: 11px; font-weight: 500; vertical-align: baseline; }
:deep(.asset-error) { display: block; margin: 1rem 0; color: var(--text-secondary); }
.asset-preview { display: block; max-width: 100%; height: auto; margin: auto; }
@media (max-width: 560px) {
  :deep(.paper-evidence) { padding-left: 9px; }
  :deep(.paper-evidence--image .paper-evidence-media) { padding: 5px; }
  :deep(.paper-evidence--image img[data-asset-id]) { max-height: 380px; }
}
</style>

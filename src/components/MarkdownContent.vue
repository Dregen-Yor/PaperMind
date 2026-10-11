<template>
  <div>
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

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ (event: 'open-source', source: SourceRef): void }>()
const html = computed(() => renderMarkdown(props.content))
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
    if (source.dataset.paperId && Number.isSafeInteger(page) && page >= 0) {
      emit('open-source', { label: source.textContent || `p${page + 1}`, paperId: source.dataset.paperId, startPage: page, endPage: page })
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
:deep(img[data-asset-id]) { display: block; max-width: 100%; height: auto; margin: 1rem auto; border-radius: 8px; cursor: zoom-in; }
:deep(img[data-asset-id]:focus-visible), :deep(.paper-source:focus-visible) { outline: 2px solid var(--color-primary, #3db8a0); outline-offset: 3px; }
:deep(.paper-source) { color: var(--color-primary, #3db8a0); cursor: pointer; font-size: .9em; white-space: nowrap; }
:deep(.asset-error) { display: block; margin: 1rem 0; color: var(--text-secondary); }
.asset-preview { display: block; max-width: 100%; height: auto; margin: auto; }
</style>

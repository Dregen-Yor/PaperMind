<template>
  <div class="chat-view" @keydown.esc="showParams = false; showSources = false">
    <aside v-if="!compactSources" class="chat-left" aria-label="参考文献与历史对话">
      <ChatSources
        v-model:active-kb-id="activeKbId"
        :selected-paper-ids="selectedPaperIds"
        :active-conv-id="activeConvId"
        @toggle-paper="toggleSelect"
        @index-paper="doIndex"
        @select-conversation="selectConv"
        @delete-conversation="delConv" />
    </aside>
    <el-drawer
      v-else
      v-model="showSources"
      direction="ltr"
      size="min(310px, 90vw)"
      :with-header="false"
      destroy-on-close
      class="paper-sources-drawer"
      title="参考文献与历史对话"
      aria-label="参考文献与历史对话"
    >
      <ChatSources
        v-model:active-kb-id="activeKbId"
        :selected-paper-ids="selectedPaperIds"
        :active-conv-id="activeConvId"
        @toggle-paper="toggleSelect"
        @index-paper="doIndex"
        @select-conversation="selectConv"
        @delete-conversation="delConv"
        collapsible
        @close="showSources = false"
      />
    </el-drawer>

    <section class="chat-center" aria-label="论文问答">
      <header class="center-header">
        <div class="ch-left">
          <h1 class="font-display">{{ activeConv?.title || '论文问答' }}</h1>
          <span v-if="selectedPaperIds.length" class="ctx-badge"><el-icon aria-hidden="true"><Files /></el-icon> 已关联 {{ selectedPaperIds.length }} 篇论文</span>
          <p v-else>围绕一篇或多篇论文，深入讨论。</p>
        </div>
        <div class="chat-actions">
          <el-button class="sources-toggle" @click="showSources = !showSources" aria-label="选择参考文献" :aria-expanded="showSources" title="参考文献"><el-icon aria-hidden="true"><Files /></el-icon></el-button>
          <el-button @click="startNewConv" class="new-conversation" aria-label="新建对话" title="新建对话"><el-icon aria-hidden="true"><Plus /></el-icon><span>新对话</span></el-button>
          <el-button @click="showParams = !showParams" aria-label="对话设置" :aria-expanded="showParams" title="对话设置"><el-icon aria-hidden="true"><Setting /></el-icon></el-button>
        </div>
      </header>
      <ChatPanel ref="chatPanelRef" :conversation="activeConv" @create="startNewConv" @open-source="onOpenSource" />
    </section>

    <el-drawer
      v-model="showParams"
      size="min(320px, 90vw)"
      :with-header="false"
      destroy-on-close
      class="paper-settings-drawer"
      title="对话设置"
      aria-label="对话设置"
    >
      <ParamPanel @close="showParams = false" />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Files, Plus, Setting } from '@element-plus/icons-vue'
import ChatPanel from '../components/ChatPanel.vue'
import ParamPanel from '../components/ParamPanel.vue'
import ChatSources from '../components/ChatSources.vue'
import { usePaperStore } from '../stores/paper'
import { useChatStore, type Conversation } from '../stores/chat'
import type { SourceRef } from '../utils/sourceRef'

const paperStore = usePaperStore()
const chatStore = useChatStore()
const router = useRouter()

const activeKbId = ref(paperStore.knowledgeBases[0]?.id ?? 'default')
const selectedPaperIds = ref<string[]>([])
const activeConvId = ref('')
const showParams = ref(false)
const showSources = ref(false)
const sourceMedia = window.matchMedia('(max-width: 980px)')
const compactSources = ref(sourceMedia.matches)
function updateSourceLayout(event: MediaQueryListEvent) {
  compactSources.value = event.matches
  if (!event.matches) showSources.value = false
}
sourceMedia.addEventListener('change', updateSourceLayout)
onBeforeUnmount(() => sourceMedia.removeEventListener('change', updateSourceLayout))
const chatPanelRef = ref<InstanceType<typeof ChatPanel>>()

const activeConv = computed(() => chatStore.conversations.find(c => c.id === activeConvId.value) ?? null)

onMounted(async () => {
  await chatStore.init()
  for (const conversation of chatStore.conversations) {
    void chatStore.autoTitleConversation(conversation.id)
  }
})

async function doIndex(paperId: string) {
  try {
    await chatStore.indexPaper(paperId)
  } catch (e: any) {
    ElMessage.error(`建立索引失败：${e.message}`)
  }
}

function toggleSelect(id: string) {
  const idx = selectedPaperIds.value.indexOf(id)
  if (idx === -1) selectedPaperIds.value.push(id)
  else selectedPaperIds.value.splice(idx, 1)
  // sync context into active conversation
  if (activeConv.value) chatStore.syncPaperIds(activeConv.value.id, selectedPaperIds.value)
}

async function startNewConv() {
  const conv = await chatStore.newConversation('新对话', [...selectedPaperIds.value])
  activeConvId.value = conv.id
  showSources.value = false
}

function selectConv(c: Conversation) {
  activeConvId.value = c.id
  selectedPaperIds.value = [...c.paperIds]
  showSources.value = false
}

/** 来源芯片跳页：论文问答页直接跳到对应论文的阅读页并定位（#1）。 */
function onOpenSource(ref: SourceRef) {
  if (!ref.paperId || ref.startPage === undefined) return
  void router.push({ path: '/library/' + ref.paperId, query: { page: String(ref.startPage + 1) } })
}

async function delConv(id: string) {
  const conv = chatStore.conversations.find(c => c.id === id)
  await ElMessageBox.confirm(`确认删除对话《${conv?.title ?? '未命名'}》？`, '删除', { type: 'warning' })
  await chatStore.removeConversation(id)
  if (activeConvId.value === id) activeConvId.value = ''
}
</script>

<style scoped>
.chat-view { display: flex; height: 100%; overflow: hidden; position: relative; }
.chat-left { width: 248px; flex-shrink: 0; min-height: 0; border-right: 1px solid var(--border); }
.chat-center { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; container-type: inline-size; background: var(--bg-surface); }
.center-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 28px; border-bottom: 1px solid var(--border); flex-shrink: 0; min-height: 100px; }
.ch-left { min-width: 0; }
.ch-left h1 { font-size: 25px; font-weight: 500; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ch-left p { font-size: 11px; color: var(--text-muted); margin-top: 8px; }
.ctx-badge { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); margin-top: 8px; }
.chat-actions { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
.chat-actions .el-button { height: 32px; font-size: 12px; padding: 0 10px; }
.chat-actions .sources-toggle { display: none; }

:global(.paper-sources-drawer .el-drawer__body),
:global(.paper-settings-drawer .el-drawer__body) { padding: 0; min-height: 0; overflow: hidden; }
@media (max-width: 1280px) {
  .chat-left { width: 230px; }
  .center-header { padding: 22px; }
}
@media (max-width: 980px) {
  .chat-actions .sources-toggle { display: inline-flex; }
}
@media (max-width: 520px) {
  .center-header { padding: 18px 16px; gap: 12px; min-height: 90px; }
  .ch-left h1 { font-size: 22px; }
  .ch-left p { font-size: 10px; }
  .chat-actions { gap: 5px; }
  .chat-actions .el-button { padding: 0 8px; }
  .new-conversation span { display: none; }
}
</style>

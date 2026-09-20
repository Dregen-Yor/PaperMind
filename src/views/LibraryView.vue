<template>
  <div class="library-view">
    <header class="view-header">
      <div class="header-left">
        <h1 class="font-display">我的文献库</h1>
        <p class="header-description">收藏值得细读的论文，留下自己的思考。<span class="paper-count tabular-nums">{{ allPapers.length }} 篇文献</span></p>
      </div>
      <div class="header-actions">
          <div v-if="chatStore.profiles.length > 1" class="index-model-select">
            <span class="index-label">索引模型</span>
            <el-select :model-value="chatStore.indexProfileId" @update:model-value="chatStore.setIndexProfileId($event)" size="small" aria-label="索引模型" style="width:140px">
              <el-option v-for="p in chatStore.profiles" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
          </div>
        <el-button @click="showNewKbDialog = true">
          <el-icon aria-hidden="true"><FolderAdd /></el-icon> 新建知识库
        </el-button>
        <el-button type="primary" @click="triggerUpload">
          <el-icon aria-hidden="true"><Upload /></el-icon> 导入 PDF
        </el-button>
        <input ref="fileInput" type="file" accept=".pdf" multiple class="file-input" aria-label="选择 PDF 文件" @change="onFilesSelected" />
      </div>
    </header>

    <div class="library-body">
      <div class="kb-tabs" aria-label="知识库">
        <div v-for="kb in store.knowledgeBases" :key="kb.id" class="kb-tab-wrap">
          <button
            type="button"
            class="kb-tab"
            :class="{ active: activeKbId === kb.id }"
            :aria-current="activeKbId === kb.id ? 'true' : undefined"
            @click="activeKbId = kb.id"
          >
            <span class="kb-dot" :style="{ background: kb.id === 'default' ? 'var(--accent)' : kb.color }" aria-hidden="true" />
            <span class="kb-name">{{ kb.name }}</span>
            <span class="kb-count tabular-nums">{{ store.getPapersByKb(kb.id).value.length }}</span>
          </button>
          <button v-if="kb.id !== 'default'" type="button" class="kb-remove" :aria-label="'删除知识库 ' + kb.name" @click="removeKb(kb.id)">
            <el-icon aria-hidden="true"><Close /></el-icon>
          </button>
        </div>
      </div>

      <div class="library-toolbar">
        <div class="status-filters" aria-label="按阅读状态筛选">
          <button
            v-for="filter in statusFilters"
            :key="filter.value"
            type="button"
            class="status-filter"
            :class="{ active: statusFilter === filter.value }"
            :aria-pressed="statusFilter === filter.value"
            @click="statusFilter = filter.value"
          >{{ filter.label }}<span v-if="filter.value === 'all'" class="tabular-nums">{{ activePapers.length }}</span></button>
        </div>
        <div class="search-sort">
          <el-input v-model="searchQuery" :prefix-icon="Search" clearable placeholder="搜索标题、作者或标签" aria-label="搜索论文" class="paper-search" />
          <el-select v-model="sortOrder" aria-label="论文排序" class="paper-sort">
            <el-option label="最近添加" value="recent" />
            <el-option label="标题排序" value="title" />
          </el-select>
        </div>
      </div>

      <div class="paper-area">
        <div v-if="activePapers.length === 0" class="empty-state">
          <div class="empty-visual" aria-hidden="true"><el-icon :size="40"><Reading /></el-icon></div>
          <h2 class="font-display">从一篇论文开始</h2>
          <p>导入 PDF，把阅读、批注和提问留在同一个地方。</p>
          <el-button type="primary" @click="triggerUpload"><el-icon aria-hidden="true"><Upload /></el-icon> 导入论文</el-button>
          <span class="empty-hint">支持一次导入多篇 PDF</span>
        </div>
        <div v-else-if="filteredPapers.length === 0" class="empty-state search-empty" role="status">
          <el-icon :size="30" aria-hidden="true"><Search /></el-icon>
          <h2>没有找到匹配的论文</h2>
          <p>试试其他关键词，或清除阅读状态筛选。</p>
          <el-button @click="clearFilters">清除筛选</el-button>
        </div>

        <div v-else class="paper-list">
          <article v-for="paper in filteredPapers" :key="paper.id" class="paper-card">
            <router-link :to="'/library/' + paper.id" class="card-link">
              <div class="paper-mark" aria-hidden="true">
                <el-icon :size="23"><Document /></el-icon>
                <span>PDF</span>
              </div>
              <div class="card-content">
                <h3 class="card-title font-display">{{ paper.title || paper.fileName }}</h3>
                <p class="card-authors">{{ paper.authors?.join(', ') || '作者信息待补充' }}<span v-if="paper.year" class="card-year tabular-nums">{{ paper.year }}</span></p>
                <p v-if="paper.abstract" class="card-abstract">{{ paper.abstract }}</p>
                <p v-else class="card-abstract no-abstract">打开论文，开始阅读与批注。</p>
                <div class="card-footer">
                  <div class="card-tags"><el-tag v-for="tag in paper.tags?.slice(0, 3)" :key="tag" size="small">{{ tag }}</el-tag></div>
                  <span class="read-link"><el-icon aria-hidden="true"><Reading /></el-icon> 阅读论文</span>
                </div>
              </div>
            </router-link>
            <div class="card-actions">
              <span class="status-pill" :data-status="paper.status"><span aria-hidden="true" />{{ statusLabel[paper.status] }}</span>
              <el-dropdown trigger="click">
                <button type="button" class="card-menu-btn" :aria-label="'论文操作：' + (paper.title || paper.fileName)">
                  <el-icon aria-hidden="true"><MoreFilled /></el-icon>
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="movePaper(paper)">移动到知识库</el-dropdown-item>
                    <el-dropdown-item @click="store.updatePaper(paper.id, { status: 'done' })">标记完成</el-dropdown-item>
                    <el-dropdown-item divided @click="deletePaper(paper)"><span class="danger-text">删除</span></el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </article>
        </div>
        <div v-if="activePapers.length" class="library-footer">
          <span class="tabular-nums">{{ searchQuery || statusFilter !== 'all' ? '筛选结果' : '当前知识库' }} {{ filteredPapers.length }} 篇</span>

        </div>
      </div>
    </div>

    <!-- ── 导入进度面板 ── -->
    <transition name="slide-up">
      <div v-if="showImportPanel" class="import-panel" role="status" aria-live="polite">
        <div class="import-panel-header">
          <span class="import-panel-title">
            导入进度
            <span class="import-counter tabular-nums">
              {{ doneCount }} / {{ importItems.length }}
            </span>
          </span>
          <button
            v-if="allDone"
            type="button"
            class="import-close-btn"
            aria-label="关闭"
            @click="showImportPanel = false"
          >✕</button>
        </div>

        <el-progress
          :percentage="importPercent"
          :status="importHasError ? 'exception' : allDone ? 'success' : undefined"
          :stroke-width="3"
          :show-text="false"
          class="import-progress-bar"
        />

        <ul class="import-list">
          <li
            v-for="item in importItems"
            :key="item.name"
            class="import-item"
            :data-status="item.status"
          >
            <span class="import-item-icon" aria-hidden="true">
              <span v-if="item.status === 'done'">✓</span>
              <span v-else-if="item.status === 'error'">✕</span>
              <span v-else class="spin">⟳</span>
            </span>
            <span class="import-item-name">{{ item.name }}</span>
            <span class="import-item-stage">{{ stageLabel[item.status] }}</span>
            <span v-if="item.error" class="import-item-error" :title="item.error">{{ item.error }}</span>
          </li>
        </ul>
      </div>
    </transition>

    <el-dialog v-model="showNewKbDialog" title="新建知识库" width="400px">
      <el-form :model="newKbForm" label-position="top" size="default">
        <el-form-item label="名称">
          <el-input v-model="newKbForm.name" name="kb-name" autocomplete="off" placeholder="如：深度学习、NLP…" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="newKbForm.description" name="kb-desc" autocomplete="off" placeholder="简短描述（可选）" />
        </el-form-item>
        <el-form-item label="颜色">
          <div class="color-options" role="radiogroup" aria-label="知识库颜色">
            <button
              v-for="c in colorOptions"
              :key="c"
              type="button"
              role="radio"
              class="color-dot"
              :style="{ background: c }"
              :class="{ selected: newKbForm.color === c }"
              :aria-label="`选择颜色 ${c}`"
              :aria-checked="newKbForm.color === c"
              @click="newKbForm.color = c"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNewKbDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!newKbForm.name" @click="createKb">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderAdd, Upload, Close, MoreFilled, Document, Search, Reading } from '@element-plus/icons-vue'
import { usePaperStore, type Paper } from '../stores/paper'
import { useChatStore } from '../stores/chat'
import { parsePdfMeta } from '../utils/pdfUtils'
import { filterLibraryPapers, type LibraryFilters } from '../utils/libraryFilters'

const store = usePaperStore()
const chatStore = useChatStore()
const fileInput = ref<HTMLInputElement>()
const activeKbId = ref(store.knowledgeBases[0]?.id ?? 'default')
const showNewKbDialog = ref(false)

const DEFAULT_KB_COLOR = '#73543c'
const newKbForm = ref({ name: '', description: '', color: DEFAULT_KB_COLOR })
const colorOptions = ['#73543c', '#65765a', '#7d8c96', '#b28b4f', '#a56858', '#92809b', '#817b70']

const allPapers = computed(() => store.papers)
const activePapers = computed(() => store.getPapersByKb(activeKbId.value).value)

const statusLabel: Record<string, string> = { unread: '未读', reading: '阅读中', done: '已完成' }
const searchQuery = ref('')
const statusFilter = ref<LibraryFilters['status']>('all')
const sortOrder = ref<LibraryFilters['sort']>('recent')
const statusFilters = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'reading', label: '阅读中' },
  { value: 'done', label: '已完成' },
] as const
const filteredPapers = computed(() => filterLibraryPapers(activePapers.value, {
  query: searchQuery.value,
  status: statusFilter.value,
  sort: sortOrder.value,
}))

function clearFilters() {
  searchQuery.value = ''
  statusFilter.value = 'all'
}

// ── 导入进度状态 ──────────────────────────────────────────
type ImportStatus = 'pending' | 'parsing' | 'saving' | 'done' | 'error'

interface ImportItem {
  name: string
  status: ImportStatus
  error?: string
}

const stageLabel: Record<ImportStatus, string> = {
  pending: '等待中',
  parsing: '解析 PDF…',
  saving:  '写入中…',
  done:    '完成',
  error:   '失败',
}

const importItems = ref<ImportItem[]>([])
const showImportPanel = ref(false)

const doneCount = computed(() =>
  importItems.value.filter(i => i.status === 'done' || i.status === 'error').length,
)
const allDone = computed(() => doneCount.value === importItems.value.length && importItems.value.length > 0)
const importHasError = computed(() => importItems.value.some(i => i.status === 'error'))
const importPercent = computed(() =>
  importItems.value.length === 0 ? 0 : Math.round((doneCount.value / importItems.value.length) * 100),
)

function triggerUpload() { fileInput.value?.click() }

async function onFilesSelected(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files || files.length === 0) return

  // 初始化进度列表
  importItems.value = Array.from(files).map(f => ({ name: f.name, status: 'pending' as ImportStatus }))
  showImportPanel.value = true

  for (let i = 0; i < importItems.value.length; i++) {
    const file = files[i]
    const item = importItems.value[i]
    try {
      item.status = 'parsing'
      const meta = await parsePdfMeta(file)

      item.status = 'saving'
      const id = await store.addPaper({
        ...meta,
        fileName: file.name,
        knowledgeBaseId: activeKbId.value,
        status: 'unread',
        tags: [],
      })
      item.status = 'done'

      // 后台触发 pageIndex 预处理，不阻塞导入流程
      chatStore.indexPaper(id).catch(() => {})
    } catch (err) {
      item.status = 'error'
      item.error = err instanceof Error ? err.message : '未知错误'
    }
  }

  ;(e.target as HTMLInputElement).value = ''
}

function createKb() {
  store.addKnowledgeBase(newKbForm.value.name, newKbForm.value.description, newKbForm.value.color)
  showNewKbDialog.value = false
  newKbForm.value = { name: '', description: '', color: DEFAULT_KB_COLOR }
}

async function removeKb(id: string) {
  const kb = store.knowledgeBases.find(k => k.id === id)
  await ElMessageBox.confirm(`删除知识库《${kb?.name ?? '未命名'}》会同时删除其中所有论文，确认继续？`, '删除知识库', { type: 'warning' })
  await store.removeKnowledgeBase(id)
  if (activeKbId.value === id) activeKbId.value = 'default'
}

async function deletePaper(paper: Paper) {
  await ElMessageBox.confirm(`确认删除《${paper.title || paper.fileName}》？`, '删除', { type: 'warning' })
  await store.removePaper(paper.id)
}

function movePaper(paper: any) {
  const kbs = store.knowledgeBases
  const idx = kbs.findIndex(k => k.id === paper.knowledgeBaseId)
  const next = kbs[(idx + 1) % kbs.length]
  store.updatePaper(paper.id, { knowledgeBaseId: next.id })
  ElMessage.success(`已移至「${next.name}」`)
}
</script>

<style scoped>
.library-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.view-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 36px 40px 30px; flex-shrink: 0; }
.header-left { min-width: 0; }
.view-header h1 { font-size: 30px; font-weight: 600; line-height: 1.3; letter-spacing: 0.5px; }
.header-description { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 11px; font-size: 12px; line-height: 1.7; color: var(--text-muted); }
.paper-count { white-space: nowrap; }
.header-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.header-actions .el-button { height: 36px; font-size: 12px; }
.file-input { display: none; }
.library-body { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.kb-tabs { display: flex; gap: 20px; margin: 0 40px; border-bottom: 1px solid var(--border); flex-shrink: 0; overflow-x: auto; }
.kb-tab-wrap { display: flex; align-items: stretch; position: relative; flex-shrink: 0; }
.kb-tab { display: flex; align-items: center; gap: 8px; padding: 12px 2px 14px; font-size: 13px; color: var(--text-muted); cursor: pointer; border: 0; border-bottom: 2px solid transparent; background: transparent; white-space: nowrap; }
.kb-tab:hover { color: var(--accent); }
.kb-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.kb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.kb-count { color: var(--text-muted); font-size: 10px; background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; }
.kb-tab.active .kb-count { background: var(--accent-dim); color: var(--accent); }
.kb-remove { display: flex; align-items: center; justify-content: center; width: 24px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.kb-remove:hover { color: var(--danger); }
.library-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 23px 40px 18px; flex-shrink: 0; }
.status-filters { display: flex; gap: 3px; padding: 3px; background: var(--bg-elevated); border-radius: 7px; }
.status-filter { border: 0; border-radius: 5px; background: transparent; padding: 7px 12px; color: var(--text-muted); font-size: 12px; white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 7px; }
.status-filter:hover { color: var(--accent); }
.status-filter.active { color: var(--accent); background: var(--bg-surface); box-shadow: var(--shadow-sm); }
.status-filter span { font-size: 10px; }
.search-sort { display: flex; align-items: center; gap: 10px; min-width: 0; }
.paper-search { width: 236px; }
.paper-sort { width: 112px; }
.paper-search :deep(.el-input__inner), .paper-sort :deep(.el-select__placeholder) { font-size: 12px; }
.paper-area { flex: 1; min-height: 0; overflow-y: auto; padding: 0 40px 24px; }
.paper-list { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); }
.paper-card { position: relative; display: flex; gap: 20px; padding: 24px; transition: background 0.15s; }
.paper-card + .paper-card { border-top: 1px solid var(--border); }
.paper-card:first-child { border-radius: 10px 10px 0 0; }
.paper-card:last-child { border-radius: 0 0 10px 10px; }
.paper-card:only-child { border-radius: 10px; }
.paper-card:hover { background: #faf7f0; }
.card-link { display: flex; gap: 18px; min-width: 0; flex: 1; text-decoration: none; color: inherit; border-radius: 3px; }
.paper-mark { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; flex-shrink: 0; width: 43px; height: 57px; margin-top: 2px; color: #9a8063; background: var(--bg-base); border: 1px solid #e7ddce; border-radius: 3px 6px 6px 3px; box-shadow: inset 3px 0 0 #ede4d5; }
.paper-mark span { font-size: 8px; font-weight: 600; letter-spacing: 0.5px; }
.card-content { flex: 1; min-width: 0; }
.card-title { font-size: 21px; font-weight: 600; line-height: 1.4; color: var(--text-primary); overflow-wrap: anywhere; text-wrap: pretty; }
.card-link:hover .card-title { color: var(--accent); }
.card-authors { margin-top: 7px; font-size: 12px; line-height: 1.7; color: var(--text-muted); overflow-wrap: anywhere; }
.card-year { display: inline-block; margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--border); }
.card-abstract { margin-top: 10px; max-width: 78ch; font-size: 12px; color: var(--text-secondary); line-height: 1.85; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.no-abstract { color: var(--text-muted); }
.card-footer { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
.card-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.read-link { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--accent); white-space: nowrap; }
.card-actions { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 16px; flex-shrink: 0; padding-top: 5px; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; padding: 4px 8px; border-radius: 5px; white-space: nowrap; }
.status-pill > span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.status-pill[data-status='unread'] { background: var(--bg-elevated); color: var(--text-secondary); }
.status-pill[data-status='reading'] { background: var(--gold-dim); color: var(--gold); }
.status-pill[data-status='done'] { background: var(--success-dim); color: var(--success); }
.card-menu-btn { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; }
.card-menu-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.library-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 2px 0; font-size: 11px; color: var(--text-muted); }
.index-model-select { display: flex; align-items: center; gap: 8px; }
.index-label { font-size: 11px; white-space: nowrap; }
.empty-state { height: 100%; min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 30px 20px; }
.empty-visual { display: flex; align-items: center; justify-content: center; width: 90px; height: 96px; margin-bottom: 8px; color: var(--accent); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 5px 12px 12px 5px; box-shadow: -5px 4px 0 var(--bg-elevated), -6px 4px 0 var(--border); }
.empty-state h2 { font-size: 25px; font-weight: 500; }
.empty-state p { font-size: 13px; color: var(--text-muted); line-height: 1.8; max-width: 36ch; }
.empty-state .el-button { margin-top: 9px; }
.empty-hint { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.search-empty h2 { font-size: 18px; }
.search-empty > .el-icon { color: var(--text-muted); margin-bottom: 6px; }
.danger-text { color: var(--danger); }
.color-options { display: flex; gap: 12px; flex-wrap: wrap; }
.color-dot { width: 26px; height: 26px; border-radius: 50%; cursor: pointer; border: 0; padding: 0; }
.color-dot.selected { outline: 2px solid var(--text-primary); outline-offset: 3px; }

@media (min-width: 1600px) {
  .view-header, .library-toolbar { padding-left: max(40px, calc((100% - 1160px) / 2)); padding-right: max(40px, calc((100% - 1160px) / 2)); }
  .kb-tabs { margin-left: max(40px, calc((100% - 1160px) / 2)); margin-right: max(40px, calc((100% - 1160px) / 2)); }
  .paper-area { padding-left: max(40px, calc((100% - 1160px) / 2)); padding-right: max(40px, calc((100% - 1160px) / 2)); }
}
@media (max-width: 1200px) {
  .view-header { padding: 30px 28px 24px; align-items: flex-start; flex-wrap: wrap; }
  .header-actions { margin-left: auto; }
  .kb-tabs { margin: 0 28px; }
  .library-toolbar { padding: 20px 28px 16px; flex-wrap: wrap; }
  .paper-area { padding-left: 28px; padding-right: 28px; }
  .paper-search { width: 210px; }
}
@media (max-width: 850px) {
  .view-header { align-items: flex-start; flex-direction: column; gap: 20px; }
  .header-description { font-size: 12px; }
  .paper-card { padding: 20px; gap: 12px; }
  .paper-mark { display: none; }
  .card-title { font-size: 19px; }
  .search-sort { flex: 1; }
  .paper-search { flex: 1; min-width: 130px; }
}
@media (max-width: 520px) {
  .view-header { padding: 24px 20px 18px; }
  .view-header h1 { font-size: 27px; }
  .header-description { gap: 5px 12px; }
  .header-actions { width: 100%; flex-wrap: wrap; }
  .header-actions .index-model-select { width: 100%; justify-content: flex-end; margin-bottom: 2px; }
  .header-actions .el-button { flex: 1; }
  .kb-tabs { margin: 0 20px; gap: 16px; }
  .library-toolbar { padding: 16px 20px; gap: 12px; }
  .status-filters, .search-sort { width: 100%; }
  .status-filter { flex: 1; justify-content: center; }
  .paper-area { padding-left: 14px; padding-right: 14px; }
  .paper-card { padding: 18px 16px; flex-direction: column-reverse; gap: 10px; }
  .card-actions { flex-direction: row; padding: 0; height: 24px; align-items: center; }
  .card-title { font-size: 20px; }
  .card-footer { flex-wrap: wrap; gap: 10px; }
  .library-footer { padding-left: 4px; padding-right: 4px; flex-wrap: wrap; }
  .empty-state { padding: 24px 12px; min-height: 300px; }
}

/* ── 导入进度面板 ─────────────────────────────────────── */
.import-panel {
  position: fixed;
  bottom: 24px;
  right: 16px;
  width: min(340px, calc(100vw - 32px));
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  z-index: 1000;
}

.import-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
}
.import-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-counter {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 1px 7px;
  border-radius: 999px;
}
.import-close-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-muted);
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out);
}
.import-close-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

.import-progress-bar { padding: 0 14px 6px; }

.import-list {
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
  padding: 0 0 6px;
}
.import-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 14px;
  font-size: 12px;
  line-height: 1.5;
  transition: background 0.1s;
}
.import-item:hover { background: var(--bg-hover); }

.import-item-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 11px;
}
.import-item[data-status='done'] .import-item-icon  { color: var(--success); }
.import-item[data-status='error'] .import-item-icon { color: var(--danger); }
.import-item[data-status='parsing'] .import-item-icon,
.import-item[data-status='saving'] .import-item-icon  { color: var(--accent); }
.import-item[data-status='pending'] .import-item-icon { color: var(--text-muted); }

.import-item-name {
  flex: 1;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.import-item-stage {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}
.import-item[data-status='done'] .import-item-stage   { color: var(--success); }
.import-item[data-status='error'] .import-item-stage  { color: var(--danger); }
.import-item[data-status='parsing'] .import-item-stage,
.import-item[data-status='saving']  .import-item-stage { color: var(--accent); }

.import-item-error {
  display: block;
  font-size: 11px;
  color: var(--danger);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

/* 旋转动画 */
.spin {
  display: inline-block;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 滑入动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.25s var(--ease-out), opacity 0.25s var(--ease-out);
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(16px);
  opacity: 0;
}
</style>

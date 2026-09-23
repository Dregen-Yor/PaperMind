<template>
  <div class="settings-view">
    <header class="view-header">
      <h1 class="font-display">设置</h1>
      <p class="header-desc">管理你的阅读模型与本地数据。</p>
    </header>

    <div class="settings-body">

      <!-- ── LLM 配置列表 ── -->
      <section class="settings-card">
        <div class="card-title-row">
          <div>
            <h3>模型配置</h3>
            <p class="card-desc">为精读、问答和索引分别配置合适的模型，随时切换使用。</p>
          </div>
          <el-button type="primary" size="small" @click="openNew">
            <el-icon><Plus /></el-icon> 新增配置
          </el-button>
        </div>

        <div class="profile-list">
          <div
            v-for="p in profiles"
            :key="p.id"
            class="profile-row"
            :class="{ 'is-chat': chatProfileId === p.id, 'is-index': indexProfileId === p.id }"
          >
            <div class="profile-info">
              <span class="profile-name">{{ p.name }}</span>
              <span class="profile-sub">{{ p.provider }} · {{ p.model }}</span>
              <div class="profile-badges">
                <span v-if="chatProfileId === p.id" class="badge badge-chat">对话</span>
                <span v-if="indexProfileId === p.id" class="badge badge-index">索引</span>
              </div>
            </div>
            <div class="profile-actions">
              <el-button size="small" plain @click="openEdit(p)">编辑</el-button>
              <el-tooltip content="至少保留一个配置" placement="top" :disabled="profiles.length > 1">
                <span class="tooltip-wrap">
                  <el-button
                    size="small"
                    plain
                    :disabled="profiles.length <= 1"
                    @click="doRemove(p.id)"
                  >删除</el-button>
                </span>
              </el-tooltip>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 默认选择 ── -->
      <section class="settings-card">
        <h3>默认使用配置</h3>
        <p class="card-desc">对话和论文索引可以分别使用不同的 LLM 配置。</p>

        <div class="setting-row">
          <label>对话</label>
          <el-select v-model="chatProfileIdLocal" @change="chatStore.setChatProfileId(chatProfileIdLocal)" style="width:240px">
            <el-option v-for="p in profiles" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </div>

        <div class="setting-row">
          <label>论文索引</label>
          <el-select v-model="indexProfileIdLocal" @change="chatStore.setIndexProfileId(indexProfileIdLocal)" style="width:240px">
            <el-option v-for="p in profiles" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </div>
      </section>

      <!-- ── 语义树检索 ── -->
      <section class="settings-card">
        <h3>语义树检索</h3>
        <p class="card-desc">
          论文导入后在后台额外构建一棵轻量语义导航树（每篇论文一次模型调用）。
          提问时先在树上做单轮路由，再回到原文证据块取证，不增加串行模型调用。
          关闭后全部检索退回原有平面路径，问答功能不受影响。
        </p>
        <div class="setting-row">
          <label>启用语义树</label>
          <el-switch
            v-model="treeEnabledLocal"
            @change="onTreeEnabledChange"
          />
          <span class="card-desc inline-hint">
            {{ treeReadyPapers.size }} 篇论文已有可用语义树
          </span>
        </div>
        <div class="setting-row">
          <el-button
            data-test="rebuild-trees"
            size="small"
            :loading="rebuildingTrees"
            @click="onRebuildTrees"
          >
            重建全部语义树
          </el-button>
          <span class="card-desc inline-hint">
            索引模型、提示词或分块参数变更后，旧树会在下次建树时自动失效；
            这里用于手动重来一遍（每篇论文一次模型调用，不重跑平面索引）。
          </span>
        </div>
      </section>

      <!-- ── 论文摘要模型 ── -->
      <section class="settings-card">
        <h3>论文摘要模型</h3>
        <p class="card-desc">
          对话中输入 <code>/abstract</code> 时，使用
          <code>{{ chatStore.ABSTRACT_MODEL }}</code> 为当前所选论文生成摘要。
          Token 仅保存在本地。
        </p>
        <div class="abstract-token-row">
          <el-input
            v-model="abstractTokenLocal"
            type="password"
            show-password
            autocomplete="off"
            spellcheck="false"
            placeholder="hf_…"
          />
          <el-button type="primary" @click="saveAbstractToken">保存 Token</el-button>
        </div>
      </section>

      <!-- ── 数据管理 ── -->
      <section class="settings-card">
        <h3>数据管理</h3>
        <p class="card-desc">所有论文与对话数据存储在本地，可随时导出备份。</p>
        <div class="action-row">
          <el-button @click="exportDialogVisible = true">导出数据</el-button>
          <el-button @click="triggerImport">导入数据</el-button>
          <el-button type="danger" plain @click="clearData">清空所有数据</el-button>
        </div>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          style="display:none"
          @change="onImportFile"
        />
      </section>

      <!-- ── 导出备份 Dialog ── -->
      <el-dialog v-model="exportDialogVisible" title="导出备份" width="460px">
        <p class="card-desc">备份包含：知识库、论文（含 PDF 原文）、对话与消息、高亮、索引与语义树、全部设置。</p>
        <el-checkbox v-model="exportIncludeApiKey">包含 API Key / Token（明文，分享前请谨慎）</el-checkbox>
        <template #footer>
          <el-button @click="exportDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="exporting" @click="doExport">导出</el-button>
        </template>
      </el-dialog>

      <!-- ── 关于 ── -->
      <section class="settings-card about">
        <div class="about-mark" aria-hidden="true">P</div>
        <div>
          <h3>关于</h3>
          <p class="card-desc">PaperMind 0.1.0 — 你的本地论文阅读助手</p>
        </div>
      </section>
    </div>

    <!-- ── Profile 编辑 Dialog ── -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑配置' : '新增配置'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-position="top" size="default" class="profile-form">
        <el-form-item label="配置名称">
          <el-input v-model="form.name" placeholder="如：GPT-4o 精读、Ollama 本地…" />
        </el-form-item>

        <el-form-item label="模型提供商">
          <el-select v-model="form.provider" style="width:100%" @change="onProviderChange">
            <el-option label="OpenAI" value="openai" />
            <el-option label="Anthropic" value="anthropic" />
            <el-option label="Ollama (本地)" value="ollama" />
          </el-select>
        </el-form-item>

        <el-form-item label="模型名称">
          <el-input v-model="form.model" autocomplete="off" spellcheck="false" placeholder="gpt-4o / claude-3-5-sonnet / llama3…" />
        </el-form-item>

        <el-form-item label="API 地址">
          <el-input v-model="form.baseUrl" type="url" autocomplete="off" spellcheck="false" />
        </el-form-item>

        <el-form-item v-if="form.provider !== 'ollama'" label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password autocomplete="off" spellcheck="false" placeholder="sk-…" />
        </el-form-item>

        <div class="form-row-two">
          <el-form-item label="Temperature">
            <div class="slider-row">
              <el-slider v-model="form.temperature" :min="0" :max="2" :step="0.1" style="flex:1" />
              <span class="slider-val tabular-nums">{{ form.temperature }}</span>
            </div>
          </el-form-item>

          <el-form-item label="Max Tokens">
            <div class="slider-row">
              <el-slider v-model="form.maxTokens" :min="256" :max="8192" :step="256" style="flex:1" />
              <span class="slider-val tabular-nums">{{ form.maxTokens }}</span>
            </div>
          </el-form-item>
        </div>

        <el-form-item label="Top-K（0 = 不限制）">
          <div class="slider-row">
            <el-slider v-model="form.topK" :min="0" :max="100" :step="1" style="flex:1" />
            <span class="slider-val tabular-nums">{{ form.topK === 0 ? '—' : form.topK }}</span>
          </div>
        </el-form-item>

        <el-form-item label="系统提示词">
          <el-input v-model="form.systemPrompt" type="textarea" :rows="5" resize="none" />
        </el-form-item>

        <el-form-item label="提示词模板（点击填入）">
          <div class="template-chips">
            <button
              v-for="t in PROMPT_TEMPLATES"
              :key="t.name"
              type="button"
              class="template-chip"
              @click="form.systemPrompt = t.prompt"
            >{{ t.name }}</button>
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!form.name || !form.model" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { useChatStore, PROMPT_TEMPLATES, type LLMProfile } from '../stores/chat'
import { storeToRefs } from 'pinia'

const chatStore = useChatStore()
const { profiles, chatProfileId, indexProfileId, abstractToken, treeEnabled, treeReadyPapers } =
  storeToRefs(chatStore)

// 本地绑定，避免直接修改 store ref（select @change 时再写入）
const chatProfileIdLocal = ref(chatProfileId.value)
const indexProfileIdLocal = ref(indexProfileId.value)
const abstractTokenLocal = ref(abstractToken.value)
const treeEnabledLocal = ref(treeEnabled.value)
const rebuildingTrees = ref(false)

// 本地镜像必须跟着 store 走：视图挂载时 store 往往还没 init（init 在 App 的 onMounted 里），
// 一次性快照会把「已存开启」显示成关闭（默认关闭后的新方向），诱使用户再拨一次
watch(treeEnabled, value => { treeEnabledLocal.value = value })

// ── Dialog state ──
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
}

const EMPTY_FORM = (): Omit<LLMProfile, 'id'> => ({
  name: '',
  provider: 'openai',
  model: '',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 4096,
  topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
})

const form = reactive<Omit<LLMProfile, 'id'>>(EMPTY_FORM())

function openNew() {
  editingId.value = null
  Object.assign(form, EMPTY_FORM())
  dialogVisible.value = true
}

function openEdit(p: LLMProfile) {
  editingId.value = p.id
  Object.assign(form, { ...p })
  dialogVisible.value = true
}

async function saveProfile() {
  if (editingId.value) {
    await chatStore.updateProfile(editingId.value, { ...form })
    ElMessage.success('配置已更新')
  } else {
    await chatStore.addProfile({ ...form })
    ElMessage.success('配置已添加')
  }
  dialogVisible.value = false
}

async function doRemove(id: string) {
  const profile = profiles.value.find(p => p.id === id)
  await ElMessageBox.confirm(`确认删除配置《${profile?.name ?? '未命名'}》？`, '删除配置', { type: 'warning' })
  await chatStore.removeProfile(id)
  // 同步本地选择器
  chatProfileIdLocal.value = chatProfileId.value
  indexProfileIdLocal.value = indexProfileId.value
  ElMessage.success('已删除')
}

async function saveAbstractToken() {
  await chatStore.setAbstractToken(abstractTokenLocal.value)
  ElMessage.success('Hugging Face Token 已保存')
}

async function onTreeEnabledChange(value: string | number | boolean) {
  await chatStore.setTreeEnabled(value === true)
  ElMessage.success(treeEnabled.value ? '语义树检索已启用' : '语义树检索已关闭，检索回到平面路径')
}

async function onRebuildTrees() {
  try {
    await ElMessageBox.confirm(
      '将为每篇已索引论文各发起一次模型调用重建语义树，是否继续？',
      '重建语义树',
      { type: 'warning' },
    )
  } catch {
    return // 用户取消
  }
  rebuildingTrees.value = true
  try {
    const { attempted, rebuilt, failed, skipped, firstReason } = await chatStore.rebuildAllTrees()
    // 「重建成 0 篇」有两种截然不同的原因，不能合并成一句话：
    // 没有候选（跳过）与真的失败（网络/输出非法/输入超限）必须分开报，
    // 失败还要带上首个原因，用户才知道该去改配置还是换论文（#13）
    if (attempted > 0 && rebuilt === 0) {
      ElMessage.error(`语义树重建失败（${failed}/${attempted} 篇）：${firstReason ?? '原因未知'}`)
    } else if (failed > 0) {
      ElMessage.warning(`已重建 ${rebuilt} 篇，${failed} 篇失败：${firstReason ?? '原因未知'}`)
    } else if (rebuilt > 0) {
      ElMessage.success(`已重建 ${rebuilt} 篇论文的语义树`)
    } else {
      ElMessage.info(skipped > 0 ? '没有可重建的论文（语义树已关闭，或正在建树中）' : '没有可重建的论文')
    }
  } finally {
    rebuildingTrees.value = false
  }
}

function onProviderChange() {
  const known = new Set(Object.values(PROVIDER_BASE_URLS))
  if (!form.baseUrl || known.has(form.baseUrl)) {
    form.baseUrl = PROVIDER_BASE_URLS[form.provider] ?? ''
  }
}

// ── Data management ──
const exportDialogVisible = ref(false)
const exportIncludeApiKey = ref(false)
const exporting = ref(false)

async function doExport() {
  exporting.value = true
  try {
    const result = await window.db.data.exportFile({ includeApiKey: exportIncludeApiKey.value })
    if (result.canceled) {
      ElMessage.info('已取消导出')
      return
    }
    ElMessage.success(`已导出到 ${result.filePath}`)
    exportDialogVisible.value = false
  } catch (err) {
    ElMessage.error(`导出失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    exporting.value = false
  }
}

const importInput = ref<HTMLInputElement>()

function triggerImport() { importInput.value?.click() }

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    await window.db.data.import(data)
    ElMessage.success('已导入，正在刷新…')
    setTimeout(() => location.reload(), 800)
  } catch (err) {
    ElMessage.error(`导入失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    input.value = ''
  }
}

async function clearData() {
  await ElMessageBox.confirm('将删除所有论文、对话和配置，此操作不可恢复。确认继续？', '清空数据', { type: 'warning' })
  await window.db.data.clear()
  ElMessage.success('已清空，刷新后生效')
  setTimeout(() => location.reload(), 800)
}
</script>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.view-header {
  padding: 34px 40px 26px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.view-header h1 { font-size: 30px; font-weight: 500; text-wrap: balance; }
.header-desc { margin-top: 10px; font-size: 12px; color: var(--text-muted); }

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 28px 40px 40px;
  width: 100%;
  max-width: 1000px;
  align-self: center;
}

.settings-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 25px 28px;
  margin-bottom: 18px;

}
.settings-card h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}
.card-desc {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.85;
  margin-bottom: 16px;
}
.card-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.card-title-row > div { flex: 1; }
.card-title-row .card-desc { margin-bottom: 0; }

/* Profile list */
.profile-list { display: flex; flex-direction: column; gap: 8px; }
.profile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  transition: border-color 0.15s var(--ease-out);
}
.profile-row:hover { border-color: var(--border-light); }
.profile-row.is-chat, .profile-row.is-index { border-color: var(--border-light); background: var(--bg-base); box-shadow: inset 3px 0 0 var(--accent); }
.profile-info { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; flex: 1; }
.profile-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.profile-sub { font-size: 12px; color: var(--text-muted); }
.profile-badges { display: flex; gap: 4px; margin-left: 4px; }
.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  letter-spacing: 0.3px;
}
.badge-chat { background: var(--accent-dim); color: var(--accent); }
.badge-index { background: var(--gold-dim); color: var(--gold); }
.profile-actions { display: flex; gap: 6px; flex-shrink: 0; }
.tooltip-wrap { display: inline-flex; }

/* Settings rows */
.setting-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
.setting-row label { width: 80px; font-size: 13px; color: var(--text-secondary); flex-shrink: 0; }

.card-desc.inline-hint { margin-bottom: 0; font-size: 12px; }

.action-row { display: flex; gap: 8px; flex-wrap: wrap; }
.abstract-token-row { display: flex; gap: 8px; }
.card-desc code {
  color: var(--accent);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}

/* About */
.about { display: flex; align-items: center; gap: 14px; }
.about .card-desc { margin-bottom: 0; }
.about-mark {
  width: 40px;
  height: 40px;
  border-radius: 3px 7px 7px 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-reading);
  font-weight: 700;
  font-size: 26px;
  color: var(--bg-surface);
  background: var(--accent);
  box-shadow: inset 3px 0 0 rgb(255 253 248 / 15%);
  flex-shrink: 0;
}

/* Dialog form */
.profile-form .form-row-two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.slider-row { display: flex; align-items: center; gap: 10px; width: 100%; }
.slider-val { font-size: 12px; color: var(--accent); min-width: 32px; text-align: right; }

.template-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.template-chip {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-base);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), color 0.15s var(--ease-out), background 0.15s var(--ease-out);
  font-family: inherit;
}
.template-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-dim);
}
@media (max-width: 900px) {
  .view-header { padding: 28px; }
  .settings-body { padding: 24px 28px; }
  .profile-info { align-items: flex-start; }
  .profile-sub { overflow-wrap: anywhere; }
}
@media (max-width: 600px) {
  .view-header { padding: 24px 20px 20px; }
  .settings-body { padding: 18px 16px 28px; }
  .settings-card { padding: 20px 18px; }
  .card-title-row { flex-direction: column; gap: 12px; }
  .profile-row { flex-wrap: wrap; gap: 14px; padding: 14px; }
  .profile-info { flex-basis: 100%; }
  .profile-sub { width: 100%; }
  .profile-badges { margin-left: 0; }
  .setting-row { flex-direction: column; align-items: flex-start; gap: 8px; }
  .setting-row :deep(.el-select) { max-width: 100%; width: 100% !important; }
  .abstract-token-row { flex-direction: column; align-items: stretch; }
  .profile-form .form-row-two { grid-template-columns: 1fr; gap: 0; }
  .action-row .el-button { font-size: 12px; }
  .card-desc code { overflow-wrap: anywhere; }
}
</style>

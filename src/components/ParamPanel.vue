<template>
  <div class="param-panel">
    <div class="param-header">
      <h3>对话设置</h3>
      <button type="button" class="collapse-btn" aria-label="收起面板" @click="$emit('close')">
        <el-icon aria-hidden="true"><DArrowRight /></el-icon>
      </button>
    </div>

    <el-scrollbar class="param-body">
      <!-- 模型选择 -->
      <div class="param-section">
        <label>对话模型</label>
        <el-select
          :model-value="chatProfileId"
          @update:model-value="chatStore.setChatProfileId($event)"
          style="width:100%"
        >
          <el-option
            v-for="p in profiles"
            :key="p.id"
            :label="p.name"
            :value="p.id"
          >
            <span class="opt-name">{{ p.name }}</span>
            <span class="opt-sub">{{ p.provider }} · {{ p.model }}</span>
          </el-option>
        </el-select>
      </div>

      <!-- 当前配置信息 -->
      <div class="profile-badge-row">
        <span class="meta-chip">{{ chatProfile?.provider }}</span>
        <span class="meta-chip">{{ chatProfile?.model }}</span>
      </div>

      <el-divider />

      <!-- Temperature -->
      <div class="param-section">
        <label>回答发散度 <span class="val tabular-nums">{{ chatProfile?.temperature ?? 0.7 }}</span></label>
        <el-slider
          :model-value="chatProfile?.temperature ?? 0.7"
          @update:model-value="updateCurrent('temperature', $event)"
          :min="0" :max="2" :step="0.1"
        />
      </div>

      <!-- Top-K -->
      <div class="param-section">
        <label>
          候选词范围（Top-K）
          <span class="val tabular-nums">{{ chatProfile?.topK === 0 ? '—' : chatProfile?.topK }}</span>
        </label>
        <el-slider
          :model-value="chatProfile?.topK ?? 0"
          @update:model-value="updateCurrent('topK', $event)"
          :min="0" :max="100" :step="1"
        />
        <p class="hint">0 = 不限制</p>
      </div>

      <!-- 回答长度上限 -->
      <div class="param-section">
        <label>
          回答长度上限（Max Tokens）
          <span class="val tabular-nums">{{ chatProfile?.maxTokens ?? 4096 }}</span>
        </label>
        <el-slider
          :model-value="chatProfile?.maxTokens ?? 4096"
          @update:model-value="updateCurrent('maxTokens', $event)"
          :min="256" :max="8192" :step="256"
        />
        <p class="hint">长回答（表格、推导）建议 ≥4096</p>
      </div>

      <el-divider />

      <!-- 前往设置 -->
      <router-link to="/settings" class="settings-link">
        <el-icon><Setting /></el-icon>
        管理模型配置
      </router-link>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { DArrowRight, Setting } from '@element-plus/icons-vue'
import { useChatStore } from '../stores/chat'
import { storeToRefs } from 'pinia'

defineEmits<{ (e: 'close'): void }>()

const chatStore = useChatStore()
const { profiles, chatProfileId, chatProfile } = storeToRefs(chatStore)

function updateCurrent(key: 'temperature' | 'topK' | 'maxTokens', value: number) {
  if (!chatProfile.value) return
  chatStore.updateProfile(chatProfile.value.id, { [key]: value })
}
</script>

<style scoped>
.param-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface);
  border-left: 1px solid var(--border);
}

.param-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 23px 22px;
  border-bottom: 1px solid var(--border);
}
.param-header h3 { font-size: 14px; font-weight: 600; color: var(--text-primary); }

.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  border-radius: 6px;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out);
}
.collapse-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

.param-body { flex: 1; min-height: 0; padding: 24px 22px; }

.param-section { margin-bottom: 20px; }
.param-section label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  font-weight: 500;
}
.param-section .val {
  color: var(--accent);
  float: right;
}
.hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* profile meta chips */
.profile-badge-row {
  display: flex;
  gap: 6px;
  margin-top: -8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.meta-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-muted);
  border: 1px solid var(--border);
}

/* select option layout */
:global(.el-select-dropdown__item:has(.opt-name)) { height: auto; min-height: 52px; padding-top: 7px; padding-bottom: 7px; line-height: 1.6; }
.opt-name { font-size: 13px; font-weight: 500; color: var(--text-primary); display: block; }
.opt-sub  { font-size: 11px; color: var(--text-muted); display: block; }

/* link to settings */
.settings-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: none;
  padding: 8px 0;
  transition: color 0.15s var(--ease-out);
}
.settings-link:hover { color: var(--accent); }
</style>

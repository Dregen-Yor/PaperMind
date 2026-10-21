<template>
  <label class="profile-select" :class="{ 'is-disabled': disabled || !profiles.length }" :title="selected ? `${selected.name} · ${selected.provider} · ${selected.model}` : fallbackName">
    <Cpu class="profile-icon" aria-hidden="true" />
    <select aria-label="选择对话配置" :value="modelValue" :disabled="disabled || !profiles.length" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-if="!profiles.length" value="">{{ fallbackName || '尚未配置模型' }}</option>
      <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.provider }} · {{ profile.model }}</option>
    </select>
    <ArrowDown class="profile-arrow" aria-hidden="true" />
  </label>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, Cpu } from '@element-plus/icons-vue'
import type { LLMProfile } from '../stores/chat'

export type ChatProfileOption = Pick<LLMProfile, 'id' | 'name' | 'provider' | 'model'>

const props = defineProps<{
  profiles: ChatProfileOption[]
  modelValue: string
  disabled?: boolean
  fallbackName?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const selected = computed(() => props.profiles.find(profile => profile.id === props.modelValue))
</script>

<style scoped>
.profile-select { display: inline-flex; position: relative; align-items: center; gap: 6px; min-width: 0; max-width: 210px; padding: 4px 6px; border-radius: 5px; color: var(--text-secondary); }
.profile-select:hover { background: var(--bg-base); }
.profile-select:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.profile-icon { width: 13px; height: 13px; flex-shrink: 0; }
select { min-width: 0; width: 100%; padding: 0 15px 0 0; appearance: none; border: 0; outline: 0; background: transparent; color: inherit; font: 11px var(--font-ui); cursor: pointer; text-overflow: ellipsis; }
option { background: var(--bg-surface); color: var(--text-primary); }
.profile-arrow { position: absolute; right: 6px; width: 10px; height: 10px; pointer-events: none; }
.is-disabled { opacity: .55; }
select:disabled { cursor: default; }
</style>

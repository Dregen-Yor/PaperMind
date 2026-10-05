<template>
  <div class="app-shell" :class="{ 'is-reading': isReading }">
    <aside class="sidebar" aria-label="主导航">
      <router-link to="/library" class="sidebar-logo" aria-label="PaperMind 文献库" title="PaperMind 文献库">
        <img class="logo-mark" :src="paperMindMark" alt="" />
        <div class="logo-copy">
          <img class="logo-text" :src="paperMindWordmark" alt="" />
          <span class="logo-sub">阅读，让想法生长</span>
        </div>
      </router-link>

      <nav class="sidebar-nav">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          :title="item.label"
          :aria-label="item.label"
          class="nav-item"
        >
          <el-icon aria-hidden="true"><component :is="item.icon" /></el-icon>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.path === '/library' && paperStore.papers.length" class="nav-count tabular-nums">{{ paperStore.papers.length }}</span>
        </router-link>
      </nav>

      <div v-if="readingPapers.length" class="reading-list">
        <p class="reading-label">正在阅读</p>
        <router-link
          v-for="paper in readingPapers"
          :key="paper.id"
          :to="'/library/' + paper.id"
          class="reading-link"
          :title="paper.title || paper.fileName"
        >
          <el-icon aria-hidden="true"><Document /></el-icon>
          <span>{{ paper.title || paper.fileName }}</span>
        </router-link>
      </div>

      <div class="sidebar-bottom">
        <div class="workspace-note">
          <span class="workspace-dot" aria-hidden="true" />
          <span>本地工作区</span>
        </div>
        <router-link to="/settings" class="nav-item" title="设置" aria-label="设置">
          <el-icon aria-hidden="true"><Setting /></el-icon>
          <span class="nav-label">设置</span>
        </router-link>
      </div>
    </aside>

    <main class="main-content" id="main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Collection, ChatDotRound, Document, Setting } from '@element-plus/icons-vue'
import { usePaperStore } from './stores/paper'
import { useChatStore } from './stores/chat'

const paperMindMark = new URL('../assets/brand/papermind-mark.svg', import.meta.url).href
const paperMindWordmark = new URL('../assets/brand/papermind-wordmark.svg', import.meta.url).href

const paperStore = usePaperStore()
const chatStore = useChatStore()
const route = useRoute()
const isReading = computed(() => route.path.startsWith('/library/'))
const readingPapers = computed(() => paperStore.papers.filter(paper => paper.status === 'reading').slice(0, 4))

onMounted(async () => {
  await Promise.all([paperStore.init(), chatStore.init()])
})

const navItems = [
  { path: '/library', icon: Collection, label: '文献库' },
  { path: '/chat', icon: ChatDotRound, label: '论文问答' },
]
</script>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  overflow: hidden;
}
.sidebar {
  width: var(--sidebar-width);
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 30px 22px 34px;
  text-decoration: none;
  color: inherit;
}
.logo-mark {
  width: 40px;
  height: 40px;
  display: block;
  flex-shrink: 0;
  object-fit: contain;
}
.logo-copy { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.logo-text { display: block; width: 126px; max-width: 100%; height: auto; }
.logo-sub { font-size: 10px; color: var(--text-muted); }
.sidebar-nav { padding: 0 14px; display: flex; flex-direction: column; gap: 6px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 43px;
  padding: 10px 13px;
  border-radius: 7px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: #e5ddd0; color: var(--text-primary); }
.nav-item.router-link-active { background: var(--bg-surface); color: var(--accent); box-shadow: var(--shadow-sm); }
.nav-item .el-icon { font-size: 18px; flex-shrink: 0; }
.nav-label { flex: 1; }
.nav-count { font-size: 11px; color: var(--text-muted); }
.reading-list { margin: 34px 14px 0; min-height: 0; overflow-y: auto; }
.reading-label { padding: 0 13px 10px; color: var(--text-muted); font-size: 11px; }
.reading-link { display: flex; align-items: flex-start; gap: 9px; padding: 10px 13px; border-radius: 6px; color: var(--text-secondary); text-decoration: none; }
.reading-link .el-icon { margin-top: 2px; flex-shrink: 0; font-size: 14px; }
.reading-link span { font-size: 12px; line-height: 1.65; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.reading-link:hover { background: var(--bg-hover); color: var(--accent); }
.sidebar-bottom { margin-top: auto; padding: 20px 14px; }
.workspace-note { display: flex; align-items: center; gap: 7px; padding: 12px 13px; margin-bottom: 6px; font-size: 11px; color: var(--text-muted); }
.workspace-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.main-content { flex: 1; min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

.is-reading .sidebar { width: 72px; }
.is-reading .sidebar-logo { margin: 25px auto 30px; }
.is-reading .logo-copy,
.is-reading .nav-label,
.is-reading .nav-count,
.is-reading .reading-list,
.is-reading .workspace-note { display: none; }
.is-reading .sidebar-nav, .is-reading .sidebar-bottom { padding-left: 12px; padding-right: 12px; }
.is-reading .nav-item { justify-content: center; padding: 12px; }

@media (max-width: 1050px) {
  .sidebar { width: 184px; }
  .sidebar-logo { margin-left: 16px; margin-right: 16px; gap: 10px; }
  .logo-mark { width: 36px; height: 36px; }
  .logo-text { width: 104px; }
  .sidebar-nav, .sidebar-bottom { padding-left: 10px; padding-right: 10px; }
}
@media (max-width: 760px) {
  .sidebar, .is-reading .sidebar { width: 64px; }
  .sidebar-logo, .is-reading .sidebar-logo { margin: 22px auto 26px; }
  .logo-copy, .nav-label, .nav-count, .reading-list, .workspace-note { display: none; }
  .sidebar-nav, .sidebar-bottom, .is-reading .sidebar-nav, .is-reading .sidebar-bottom { padding-left: 8px; padding-right: 8px; }
  .nav-item { justify-content: center; padding: 12px; }
}
@media (max-width: 520px) {
  .app-shell { flex-direction: column; }
  .sidebar, .is-reading .sidebar { width: 100%; height: 62px; flex-direction: row; align-items: center; border-right: 0; border-bottom: 1px solid var(--border); padding: 0 14px; }
  .sidebar-logo, .is-reading .sidebar-logo { margin: 0 auto 0 0; }
  .logo-mark { width: 36px; height: 36px; }
  .sidebar-nav, .is-reading .sidebar-nav { flex-direction: row; padding: 0; gap: 6px; }
  .sidebar-bottom, .is-reading .sidebar-bottom { margin: 0 0 0 6px; padding: 0; }
  .nav-item { min-height: 40px; width: 42px; }
}
</style>

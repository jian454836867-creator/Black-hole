<template>
  <div class="card article-card">
    <div class="article-head">
      <span class="article-icon">📄</span>
      <span class="article-title">{{ article.title || domain }}</span>
      <span class="article-time">{{ time }}</span>
    </div>
    <div class="article-body" :class="{ collapsed: !expanded }">
      {{ article.summary || (article.content || '').slice(0, 120) }}
    </div>
    <div class="article-meta">
      <span class="tag">{{ (article.content || '').length }} 字</span>
      <a v-if="article.url && !article.url.startsWith('merged://')" :href="article.url" target="_blank" class="article-link">{{ domain }}</a>
      <span v-else-if="article.url?.startsWith('merged://')" class="tag merged">🔗 合并摘要</span>
      <span v-if="!expanded" class="expand-hint" @click="expanded = true">展开 ▾</span>
      <span v-else class="expand-hint" @click="expanded = false">收起 ▴</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
const props = defineProps({ article: { type: Object, default: () => ({}) } });
const expanded = ref(false);

const domain = computed(() => {
  try { return new URL(props.article.url).hostname; } catch { return props.article.url || ''; }
});
const time = computed(() => (props.article.created_at || '').replace('T', ' ').slice(0, 16));
</script>

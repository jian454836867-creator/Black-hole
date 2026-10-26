<template>
  <div class="card">
    <div class="content">{{ item.content }}</div>
    <div class="meta">
      <span v-for="t in tags" :key="t" class="tag">{{ t }}</span>
      <span class="time">{{ time }}</span>
    </div>
    <!-- 碰撞块：1×2 网格 -->
    <div class="rel-grid" v-if="badges.length">
      <div
        v-for="b in badges"
        :key="b.id"
        class="rel-block"
        :class="[b.relation_type, { confirmed: b.user_confirmed === 1, ignored: b.user_confirmed === -1 }]"
        @click.stop="emitBadge(b)"
      >
        <div class="rel-type">
          {{ b.relation_type === 'merge' ? '✨ 融合' : '⚖️ 冲突' }}
          <span class="rel-status" :class="statusClass(b)">{{ statusLabel(b) }}</span>
        </div>
        <div class="rel-other">{{ otherContent(b) }}</div>
        <div class="rel-actions">
          <button
            v-if="b.user_confirmed === 0"
            class="btn-accept"
            @click.stop="$emit('confirm', b, 1)"
          >✓ 收录</button>
          <button
            v-if="b.user_confirmed === 0"
            class="btn-dismiss"
            @click.stop="$emit('confirm', b, -1)"
          >✕ 忽略</button>
          <span v-if="b.user_confirmed === 1" class="status-done">已收录</span>
          <span v-if="b.user_confirmed === -1" class="status-done dim">已忽略</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ item: { type: Object, default: () => ({}) } });
const emit = defineEmits(['badge', 'confirm']);

const tags = computed(() => {
  try { return JSON.parse(props.item?.tags || '[]'); } catch { return []; }
});
const time = computed(() => (props.item?.created_at || '').replace('T', ' ').slice(0, 16));
const badges = computed(() => (props.item?.relations || []).filter(r => r.user_confirmed !== -1));

function otherContent(b) {
  const other = b.content_a === props.item.content ? b.content_b : b.content_a;
  return (other || '').slice(0, 40);
}
function statusClass(b) {
  if (b.user_confirmed === 1) return 'ok';
  if (b.user_confirmed === -1) return 'dim';
  return 'warn';
}
function statusLabel(b) {
  if (b.user_confirmed === 1) return '✓ 已收录';
  if (b.user_confirmed === -1) return '✕ 已忽略';
  return '● 待确认';
}
function emitBadge(b) { emit('badge', props.item, b); }
</script>

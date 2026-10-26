<template>
  <template v-if="open">
    <div class="overlay" @click="$emit('close')"></div>
    <div class="panel">
      <span class="close" @click="$emit('close')">×</span>
      <h3>观点碰撞 · {{ item.content.slice(0, 18) }}…</h3>
      <div v-for="r in item.relations" :key="r.id" class="rel">
        <div class="type" :class="r.relation_type">
          {{ r.relation_type === 'merge' ? '✨ 同构升华（merge）' : '⚖️ 冲突（conflict）' }}
          <span v-if="r.user_confirmed === 1" style="color:var(--ok)"> · 已收录</span>
          <span v-else-if="r.user_confirmed === -1" style="color:var(--dim)"> · 已忽略</span>
          <span v-else style="color:var(--warn)"> · 待确认</span>
        </div>
        <div>对方观点：{{ r.content_a === item.content ? r.content_b : r.content_a }}</div>
        <div v-if="r.explanation" class="other">逻辑：{{ r.explanation }}</div>
      </div>
      <div class="actions" v-if="pending.length">
        <button class="primary" @click="confirm(1)">确认收录</button>
        <button @click="confirm(-1)">忽略</button>
      </div>
      <div class="actions" v-else>
        <button @click="$emit('close')">关闭</button>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed } from 'vue';
import { confirmRelation } from '../api.js';

const props = defineProps({ open: Boolean, item: Object });
const emit = defineEmits(['close', 'updated']);

const pending = computed(() => (props.item?.relations || []).filter(r => r.user_confirmed === 0));

async function confirm(state) {
  for (const r of pending.value) {
    await confirmRelation(r.id, state);
  }
  emit('updated');
}
</script>

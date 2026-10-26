<template>
  <div class="screen">
    <!-- ===== 上区 60%：输出（答案/回执）+ 碰撞时间线 ===== -->
    <div class="pane pane-out">
      <SetupGuide @cleared="load" />
      <div v-if="lastResult || answer" class="answer-wrap">
        <div class="answer-head">🔍 线索浮现</div>
        <div class="answer-body">
          <div v-if="lastResult?.localOnly" class="local-note">⚠️ 未触网（本地模式）</div>
          {{ answer }}
          <div class="cites" v-if="lastResult?.citations?.length">
            <div v-for="(c, i) in lastResult.citations" :key="c.id" class="cite">[{{ i + 1 }}] {{ c.content.slice(0, 50) }}</div>
          </div>
        </div>
      </div>

      <div class="toolbar">
        <span class="count">🕳️ Black hole · 已入库 {{ items.length }} 条<span v-if="articles.length"> · {{ articles.length }} 篇</span><span v-if="relCount"> · {{ relCount }} 碰撞</span></span>
      </div>
      <div class="timeline">
        <ArticleCard
          v-for="a in articles"
          :key="a.id"
          :article="a"
        />
        <TimelineCard
          v-for="item in visibleItems"
          :key="item.id"
          :item="item"
          @badge="onBadge"
          @confirm="onConfirm"
        />
        <div v-if="!visibleItems.length && !articles.length" class="empty-blank"></div>
      </div>
    </div>

    <!-- ===== 下区 40%：统一输入框（默认提问，拖文件变上传） ===== -->
    <div class="pane pane-in" :class="{ 'is-drag': dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
      <!-- 拖拽覆盖层 -->
      <div v-if="dragging" class="drop-overlay">
        <div class="drop-icon">📥</div>
        <div>松开文件即入库</div>
        <div class="privacy" style="margin-top:8px">
          隐私级别：
          <select v-model="privacy" @click.stop>
            <option value="normal">normal（可触网）</option>
            <option value="private">private（绝不触网，微信默认）</option>
          </select>
        </div>
      </div>
      <!-- 默认：提问输入框 -->
      <div class="inbox" v-show="!dragging">
        <form @submit.prevent="submit">
          <div class="ta-wrap">
            <div class="ta-top">
              <span class="ta-hint"></span>
              <button type="button" class="btn-settings" @click="openSettings">⚙️ 设置</button>
            </div>
            <textarea v-model="question" placeholder="输入文字：提问 / 文章 / 短句（拖入文件自动入库）" :disabled="busy"></textarea>
            <div class="ta-bottom">
              <select v-model="privacy" class="sel-privacy">
                <option value="normal">可触网</option>
                <option value="private">不触网</option>
              </select>
              <button type="button" class="btn-ingest" @click="ingestTyped" :disabled="busy || !question.trim()">✨ 灵感汇入</button>
              <button type="submit" class="btn-ask" :disabled="busy || !question.trim()">🔍 线索浮现</button>
            </div>
          </div>
        </form>
        <div v-if="ingestMsg" style="margin-top:6px;font-size:12px" :style="{color: ingestMsg.ok ? 'var(--ok)' : 'var(--conflict)'}">{{ ingestMsg.text }}</div>
      </div>
      <input ref="fileInput" type="file" accept=".txt,.md,.markdown,.html,.htm" style="display:none" @change="onPick" />
    </div>
  </div>

  <RelationPanel :open="!!panel" :item="panel?.item" @close="panel = null" @updated="load" />
  <SettingsPanel :open="showSettings" @close="showSettings = false" @cleared="load" />
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import TimelineCard from './components/TimelineCard.vue';
import ArticleCard from './components/ArticleCard.vue';
import RelationPanel from './components/RelationPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import { getTimeline, getArticles, ask, ingestText, health } from './api.js';

const items = ref([]);
const articles = ref([]);
const privacy = ref('normal');
const dragging = ref(false);
const question = ref('');
const answer = ref('');
const busy = ref(false);
const panel = ref(null);
const lastResult = ref(null);
const ingestMsg = ref(null);
const fileInput = ref(null);

// 黑盒语义：纯词条永不展示，只显示有碰撞（relations）的观点
const visibleItems = computed(() => items.value.filter(i => (i.relations || []).length > 0));
const relCount = ref(0);

async function load() {
  try { items.value = (await getTimeline(10000)).items; } catch { items.value = []; }
  try { articles.value = (await getArticles(10000)).items; } catch { articles.value = []; }
  relCount.value = items.value.reduce((n, i) => n + (i.relations || []).length, 0);
}
async function checkHealth() {
  try {
    const h = await health();
    healthOk.value = !!h.ok;
  } catch { healthOk.value = false; }
}
const healthOk = ref(false);

async function onDrop(e) {
  dragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) await doIngest(f);
}
function onPick(e) {
  const f = e.target.files?.[0];
  if (f) doIngest(f);
  e.target.value = '';
}
async function doIngest(f) {
  try {
    const text = await f.text();
    const r = await ingestText(text, privacy.value, f.name);
    const n = r.insights?.length || 0;
    ingestMsg.value = { ok: true, text: `✅ 已入库：提取 ${n} 条观点（${f.name}）` };
    setTimeout(load, 2500);
  } catch (err) {
    ingestMsg.value = { ok: false, text: '❌ ' + err.message };
  }
}

const showSettings = ref(false);
function openSettings() { showSettings.value = true; }

async function ingestTyped() {
  const text = question.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  ingestMsg.value = null;
  try {
    const r = await ingestText(text, privacy.value, 'typed');
    const n = r.insights?.length || 0;
    const rej = r.rejected?.length || 0;
    const mgd = r.merged?.length || 0;
    if (r.filtered || (n === 0 && rej === 0)) {
      ingestMsg.value = { ok: false, text: '⚠️ 无价值内容，未入库（太短/寒暄/纯标点）' };
    } else if (rej > 0 && n === 0) {
      ingestMsg.value = { ok: false, text: '🚫 已拒绝：' + (r.rejected[0]?.reason || '与已有内容重复') };
    } else {
      let msg = '';
      if (mgd > 0) msg += `🔄 合并 ${mgd} 条（旧→新） `;
      if (n > 0) msg += `✅ 入库 ${n} 条 `;
      if (rej > 0) msg += `🚫 拒绝 ${rej} 条`;
      ingestMsg.value = { ok: true, text: msg };
      question.value = '';
    }
    setTimeout(load, 1500);
  } catch (err) {
    ingestMsg.value = { ok: false, text: '❌ ' + err.message };
  } finally {
    busy.value = false;
  }
}

function onBadge(item, rel) { panel.value = { item, rel }; }
async function onConfirm(rel, state) {
  try {
    const { confirmRelation } = await import('./api.js');
    await confirmRelation(rel.id, state);
    load();
  } catch {}
}

async function submit() {
  if (!question.value.trim() || busy.value) return;
  busy.value = true;
  answer.value = '思考中…';
  lastResult.value = null;
  try {
    lastResult.value = await ask(question.value, { privacy: privacy.value });
    answer.value = lastResult.value.answer;
  } catch (err) {
    answer.value = '❌ ' + err.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => { load(); checkHealth(); setInterval(checkHealth, 10000); });
</script>

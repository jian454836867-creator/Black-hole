<template>
  <template v-if="open">
    <div class="overlay" @click="$emit('close')"></div>
    <div class="settings-panel">
      <span class="close" @click="$emit('close')">×</span>
      <h3>⚙️ 设置</h3>

      <div class="step">
        <div class="step-head">
          <span class="step-ico">🔑</span>
          <b>DeepSeek API Key</b>
          <span :class="['pill', cfg.llmConfigured ? 'pill-ok' : 'pill-off']">{{ cfg.llmConfigured ? '已配置' : '未配置' }}</span>
        </div>
        <div class="key-row">
          <input v-model="apiKey" type="password" placeholder="sk-...（platform.deepseek.com 创建）" class="key-input" />
          <button :disabled="!apiKey.trim() || saving" @click="saveKey">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>

      <div class="step">
        <div class="step-head">
          <span class="step-ico">💬</span>
          <b>微信 iLink 接入</b>
          <span :class="['pill', cfg.weixinConfigured ? 'pill-ok' : 'pill-off']">{{ cfg.weixinConfigured ? '已接入' : '未接入' }}</span>
        </div>
        <div class="wx-area">
          <button v-if="!wxQr" @click="genQr" :disabled="wxLoading">{{ wxLoading ? '获取中…' : '📱 生成登录二维码' }}</button>
          <div v-else class="wx-qr">
            <img :src="wxQr" alt="微信扫码" />
            <div class="wx-status">
              <template v-if="wxStatus === 'waiting'">等待扫码…</template>
              <template v-else-if="wxStatus === 'scaned'">✅ 已扫码，请在手机上确认</template>
              <template v-else-if="wxStatus === 'confirmed'">🎉 登录成功！</template>
              <template v-else-if="wxStatus === 'expired'">二维码已过期</template>
              <template v-else-if="wxStatus === 'already_bound'">✅ 已绑定</template>
            </div>
            <div v-if="wxStatus === 'need_verifycode'" class="verify-row">
              <input v-model="verifyCode" type="text" placeholder="手机显示的数字" @keyup.enter="submitCode" />
              <button @click="submitCode">提交</button>
            </div>
            <button @click="closeQr">关闭</button>
          </div>
        </div>
      </div>

      <div class="step step-danger">
        <div class="step-head">
          <span class="step-ico">🗑️</span>
          <b>清空数据库</b>
          <span class="pill pill-danger">危险操作</span>
        </div>
        <p class="step-desc">删除所有观点、文章、碰撞关系，完全清空。不可撤销。</p>
        <button class="btn-clear" :disabled="clearing" @click="clearDb">{{ clearing ? '清空中…' : '🗑️ 清空数据库' }}</button>
      </div>
    </div>
  </template>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import QRCode from 'qrcode';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close', 'cleared']);

const cfg = ref({ llmConfigured: false, weixinConfigured: false });
const apiKey = ref('');
const saving = ref(false);
const clearing = ref(false);

const wxQr = ref('');
const wxStatus = ref('');
const wxLoading = ref(false);
const verifyCode = ref('');
let wxPollTimer = null;
let wxLoginId = null;
let polling = false;

async function check() {
  try { cfg.value = await api('/config/check'); } catch { cfg.value = { llmConfigured: false, weixinConfigured: false }; }
}
async function saveKey() {
  saving.value = true;
  try {
    await api('/config/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: apiKey.value.trim() }) });
    await check();
    apiKey.value = '';
  } catch (e) { alert('保存失败：' + e.message); } finally { saving.value = false; }
}

async function genQr() {
  wxLoading.value = true;
  wxQr.value = '';
  wxStatus.value = 'waiting';
  verifyCode.value = '';
  try {
    const r = await api('/weixin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    wxLoginId = r.id;
    wxQr.value = await QRCode.toDataURL(r.qrcodeUrl, { width: 180, margin: 1 });
    startPolling();
  } catch (e) {
    wxStatus.value = 'expired';
    alert('生成失败：' + e.message);
  } finally { wxLoading.value = false; }
}
async function pollOnce() {
  if (polling || !wxLoginId) return;
  polling = true;
  try {
    const r = await api(`/weixin/login/${wxLoginId}`);
    wxStatus.value = r.status;
    if (['confirmed', 'expired', 'already_bound'].includes(r.status)) {
      stopPolling();
      if (r.status === 'confirmed') { wxLoginId = null; setTimeout(check, 1500); }
    }
  } catch {}
  finally { polling = false; }
}
function startPolling() { stopPolling(); pollOnce(); wxPollTimer = setInterval(pollOnce, 1000); }
function stopPolling() { if (wxPollTimer) { clearInterval(wxPollTimer); wxPollTimer = null; } }
async function submitCode() {
  if (!verifyCode.value.trim() || !wxLoginId) return;
  try {
    await api(`/weixin/login/${wxLoginId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: verifyCode.value.trim() }) });
    verifyCode.value = '';
    pollOnce();
  } catch (e) { alert('提交失败：' + e.message); }
}
function closeQr() { wxQr.value = ''; wxStatus.value = ''; wxLoginId = null; stopPolling(); }

async function clearDb() {
  if (!confirm('确定清空数据库？所有观点、文章、碰撞关系将删除，重置为 20 条种子数据。不可撤销。')) return;
  clearing.value = true;
  try {
    await api('/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    emit('cleared');
  } catch (e) { alert('清空失败：' + e.message); } finally { clearing.value = false; }
}

onMounted(check);
onUnmounted(stopPolling);
</script>

<style scoped>
.settings-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 420px; max-width: 92vw; max-height: 80vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; z-index: 100; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
.close { position: absolute; top: 12px; right: 16px; font-size: 22px; color: var(--dim); cursor: pointer; }
.close:hover { color: var(--text); }
h3 { font-size: 15px; margin-bottom: 14px; }
.step { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: rgba(30,41,59,.4); }
.step-danger { border-color: var(--conflict); }
.step-head { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.step-ico { font-size: 15px; }
.pill { font-size: 11px; border-radius: 999px; padding: 1px 9px; margin-left: auto; border: 1px solid; }
.pill-ok { color: var(--ok); border-color: var(--ok); background: rgba(74,222,128,.1); }
.pill-off { color: var(--warn); border-color: var(--warn); background: rgba(251,191,36,.08); }
.pill-danger { color: var(--conflict); border-color: var(--conflict); background: rgba(248,113,113,.1); }
.step-desc { font-size: 12px; color: var(--dim); margin-bottom: 8px; line-height: 1.5; }
.key-row { display: flex; gap: 8px; }
.key-input { flex: 1; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 12px; padding: 7px 10px; font-family: Consolas, monospace; }
.key-row button { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
.key-row button:disabled { opacity: .4; cursor: not-allowed; }
.wx-area > button { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
.wx-area > button:disabled { opacity: .5; cursor: wait; }
.wx-qr { display: inline-block; border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #fff; margin-top: 8px; }
.wx-qr img { display: block; width: 160px; height: 160px; }
.wx-qr .wx-status { color: #334155; font-size: 12px; margin-top: 8px; text-align: center; }
.wx-qr button { margin-top: 8px; width: 100%; background: var(--panel2); border: 1px solid var(--border); color: #0f172a; border-radius: 8px; padding: 6px 0; cursor: pointer; font-size: 12px; }
.verify-row { display: flex; gap: 6px; margin-top: 6px; }
.verify-row input { flex: 1; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; color: #0f172a; font-size: 13px; padding: 6px 10px; text-align: center; letter-spacing: 4px; }
.verify-row button { background: #2563eb; border: none; color: #fff; border-radius: 8px; padding: 0 16px; cursor: pointer; font-size: 12px; }
.btn-clear { background: rgba(248,113,113,.1); border: 1px solid var(--conflict); color: var(--conflict); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all .15s; }
.btn-clear:hover { background: var(--conflict); color: #fff; transform: scale(1.03); }
.btn-clear:disabled { opacity: .5; cursor: wait; }
</style>

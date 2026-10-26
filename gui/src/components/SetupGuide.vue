<template>
  <div class="setup-wrap">
    <!-- 首次引导（未完成时覆盖上区） -->
    <div v-if="showGuide" class="setup-card setup-overlay">
      <h2>⚙️ 首次配置 Black hole</h2>
      <p class="sub">两项配置都是可选的：不配置也能用（本地降级模式）。</p>

      <div class="step">
        <div class="step-head">
          <span class="step-ico">🔑</span>
          <b>DeepSeek API Key</b>
          <span :class="['pill', cfg.llmConfigured ? 'pill-ok' : 'pill-off']">{{ cfg.llmConfigured ? '已配置' : '未配置' }}</span>
        </div>
        <p class="step-desc">观点智能提取 + 三态判定 + 生成式问答。不填 = 本地降级（按行入库 / 合成判定 / 词条回答）。</p>
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
        <p class="step-desc">微信发文字 → 自动 private 入库 → 回「👌 已入库」，每天 20:00 聚合推送碰撞。点击生成二维码，用微信扫一次即可。</p>
        <div class="wx-cmds">微信命令：直接发文字＝入库；<b>「问xxx」</b>＝提问（DeepSeek 回答）；<b>「/clear」</b>＝清空重置</div>
        <div class="wx-area">
          <button v-if="!wxQr" @click="genQr" :disabled="wxLoading">{{ wxLoading ? '获取中…' : '📱 生成登录二维码' }}</button>
          <div v-else class="wx-qr">
            <img v-if="wxQr" :src="wxQr" alt="微信扫码" />
            <div class="wx-status">
              <template v-if="wxStatus === 'waiting'">等待扫码…（每 1 秒自动刷新状态）</template>
              <template v-else-if="wxStatus === 'scaned'">✅ 已扫码，请在手机上确认登录</template>
              <template v-else-if="wxStatus === 'confirmed'">🎉 登录成功！微信桥已自动启动</template>
              <template v-else-if="wxStatus === 'expired'">二维码已过期，点下面按钮重新生成</template>
              <template v-else-if="wxStatus === 'already_bound'">✅ 该微信已绑定过本实例，可直接使用</template>
              <template v-else-if="wxStatus === 'blocked'">⛔ 配对码多次输入错误，请重新生成二维码</template>
            </div>
            <div v-if="wxStatus === 'need_verifycode'" class="verify-row">
              <input v-model="verifyCode" type="text" placeholder="手机微信上显示的数字" @keyup.enter="submitCode" />
              <button @click="submitCode">提交</button>
            </div>
            <button v-if="['expired', 'blocked'].includes(wxStatus)" @click="genQr" :disabled="wxLoading">重新生成</button>
            <button v-else @click="closeQr">关闭</button>
          </div>
        </div>
      </div>

      <div class="step" style="border-color:var(--conflict)">
        <div class="step-head">
          <span class="step-ico">🗑️</span>
          <b>清空数据库</b>
          <span class="pill pill-danger">危险操作</span>
        </div>
        <p class="step-desc">删除所有观点、文章、碰撞关系，重置为 20 条种子数据。不可撤销。</p>
        <button class="btn-clear" :disabled="clearing" @click="clearDb">{{ clearing ? '清空中…' : '🗑️ 清空数据库' }}</button>
      </div>

      <div class="foot">
        <button class="primary" @click="done">完成</button>
        <button @click="skip">跳过</button>
      </div>
    </div>

    <!-- 内容页配置入口（常驻） -->
    <div v-else class="cfg-chip" @click.stop="reopen">
      ⚙️
      <span :class="['dot', cfg.llmConfigured ? 'on' : 'off']"></span>
      <span :class="['dot', cfg.weixinConfigured ? 'on' : 'off']"></span>
      <span class="lbl">{{ cfg.llmConfigured && cfg.weixinConfigured ? '已配置' : '配置' }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import QRCode from 'qrcode';

const emit = defineEmits(['close', 'cleared']);
const clearing = ref(false);
const cfg = ref({ llmConfigured: false, weixinConfigured: false });
const apiKey = ref('');
const saving = ref(false);
const showGuide = ref(true);

// 微信扫码登录
const wxQr = ref('');
const wxStatus = ref('');
const wxLoading = ref(false);
const verifyCode = ref('');
let wxPollTimer = null;
let wxLoginId = null;
let polling = false;

async function genQr() {
  wxLoading.value = true;
  wxQr.value = '';
  wxStatus.value = 'waiting';
  verifyCode.value = '';
  try {
    const r = await api('/weixin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    wxLoginId = r.id;
    wxQr.value = await QRCode.toDataURL(r.qrcodeUrl, { width: 200, margin: 1 });
    startPolling();
  } catch (e) {
    wxStatus.value = 'expired';
    wxQr.value = '';
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
      if (r.status === 'confirmed') {
        wxLoginId = null;
        setTimeout(check, 1500);
      }
    }
  } catch { /* 网络抖动忽略，下次再试 */ }
  finally { polling = false; }
}
function startPolling() {
  stopPolling();
  pollOnce();
  wxPollTimer = setInterval(pollOnce, 1000);
}
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
async function clearDb() {
  if (!confirm('确定清空数据库？所有观点、文章、碰撞关系将删除，重置为 20 条种子数据。不可撤销。')) return;
  clearing.value = true;
  try {
    await api('/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    alert('✅ 已清空');
    emit('cleared');
  } catch (e) { alert('清空失败：' + e.message); } finally { clearing.value = false; }
}
function done() { localStorage.setItem('ocm_setup_done', '1'); check(); showGuide.value = false; emit('done'); }
function skip() { localStorage.setItem('ocm_setup_done', '1'); showGuide.value = false; emit('done'); }
function reopen() { showGuide.value = true; check(); }

onMounted(check);
onUnmounted(stopPolling);
</script>

<style scoped>
.setup-wrap { position: relative; min-height: 48px; }
.setup-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
.setup-overlay { position: absolute; inset: 0; z-index: 20; overflow-y: auto; background: var(--bg); border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px rgba(0,0,0,.6); }
.setup-card h2 { font-size: 16px; margin-bottom: 4px; }
.setup-card .sub { font-size: 12px; color: var(--dim); margin-bottom: 14px; }
.step { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: rgba(30,41,59,.4); }
.step-head { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.step-ico { font-size: 15px; }
.pill { font-size: 11px; border-radius: 999px; padding: 1px 9px; margin-left: auto; border: 1px solid; }
.pill-ok { color: var(--ok); border-color: var(--ok); background: rgba(74,222,128,.1); }
.pill-off { color: var(--warn); border-color: var(--warn); background: rgba(251,191,36,.08); }
.pill-danger { color: var(--conflict); border-color: var(--conflict); background: rgba(248,113,113,.1); }
.btn-clear { background: rgba(248,113,113,.1); border: 1px solid var(--conflict); color: var(--conflict); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all .15s; }
.btn-clear:hover { background: var(--conflict); color: #fff; transform: scale(1.03); }
.btn-clear:disabled { opacity: .5; cursor: wait; }
.step-desc { font-size: 12px; color: var(--dim); margin-bottom: 8px; line-height: 1.5; }
.key-row { display: flex; gap: 8px; }
.key-input { flex: 1; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 12px; padding: 7px 10px; font-family: Consolas, monospace; }
.key-row button, .foot button { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
.key-row button:disabled { opacity: .4; cursor: not-allowed; }
.cmds { margin: 4px 0 0 18px; padding: 0; font-size: 12px; color: var(--dim); line-height: 1.8; font-family: Consolas, monospace; }
.wx-area { margin-top: 6px; }
.wx-area > button { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
.wx-area > button:disabled { opacity: .5; cursor: wait; }
.wx-qr { display: inline-block; border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #fff; margin-top: 8px; }
.wx-qr img { display: block; width: 180px; height: 180px; }
.wx-qr .wx-status { color: #334155; font-size: 12px; margin-top: 8px; text-align: center; }
.wx-qr button { margin-top: 8px; width: 100%; background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 0; cursor: pointer; font-size: 12px; }
.verify-row { display: flex; gap: 6px; margin-top: 8px; }
.verify-row input { flex: 1; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; color: #0f172a; font-size: 13px; padding: 6px 10px; text-align: center; letter-spacing: 4px; }
.verify-row button { background: #2563eb; border: none; color: #fff; border-radius: 8px; padding: 0 16px; cursor: pointer; font-size: 12px; }
.wx-cmds { margin-top: 8px; font-size: 12px; color: var(--dim); line-height: 1.7; }
.wx-cmds b { color: var(--text); }
.foot { display: flex; gap: 10px; margin-top: 14px; }
.foot button.primary { background: var(--accent); border-color: var(--accent); color: #04263a; font-weight: 600; }
.cfg-chip { display: inline-flex; align-items: center; gap: 7px; background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 5px 14px; cursor: pointer; font-size: 12px; color: var(--text); user-select: none; transition: border-color .15s; }
.cfg-chip:hover { border-color: var(--accent); }
.cfg-chip .lbl { color: var(--dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot.on { background: var(--ok); }
.dot.off { background: var(--warn); }
</style>

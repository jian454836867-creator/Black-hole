// 本地 API 客户端
const BASE = import.meta.env.VITE_API || 'http://127.0.0.1:7700';

export async function api(path, opts = {}) {
  const resp = await fetch(BASE + path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export function health() { return api('/health'); }
export function getTimeline(limit = 100) { return api(`/timeline?limit=${limit}`); }
export function ask(question, { deep = false, privacy = 'normal', k = 5 } = {}) {
  return api('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, deep, privacy, k }) });
}
export function ingestText(text, privacyLevel = 'normal', sourceUrl = null) {
  return api('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, privacyLevel, sourceUrl }) });
}
export function ingestFile(file, privacyLevel = 'normal') {
  const form = new FormData();
  form.append('file', file);
  form.append('privacyLevel', privacyLevel);
  return api('/ingest', { method: 'POST', body: form });
}
export function confirmRelation(id, state) {
  return api('/relations/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state }) });
}
export function getArticles(limit = 50) { return api(`/articles?limit=${limit}`); }

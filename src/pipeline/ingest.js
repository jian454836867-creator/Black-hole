// 入库流：文件 → 纯文本 → raw_files → 观点提取 → insights → 异步向量化
import fs from 'node:fs';
import path from 'node:path';
import { insertRawFile, insertInsight, attachVector, getInsight, relationsForInsight } from '../db/repo.js';
import { embedder } from '../model/embedder.js';
import { extractInsights, llmAvailable, LlmUnavailable } from './llm.js';
import { isValuable } from './filter.js';

// 文本提取（Step 2 只支持纯文本类；图片/web 留到后续）
export function extractText(filePath, fileType) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.md', '.markdown', '.log', '.csv'].includes(ext) || fileType === 'text') {
    return fs.readFileSync(filePath, 'utf8');
  }
  // html：粗提取
  if (['.html', '.htm'].includes(ext) || fileType === 'web') {
    const html = fs.readFileSync(filePath, 'utf8');
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  throw new Error(`暂不支持的文件类型: ${ext || fileType}（Step 2 支持 .txt/.md/.html）`);
}

// 启发式提取（无 DeepSeek Key 时的降级：按行/句切分短句）
export const MAX_INSIGHTS_PER_FILE = 2000; // 单文件观点上限（防超大文件打爆库）
export function heuristicInsights(text) {
  // 优先按行切（短句文件每行一条），行内再按句号兜底
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length >= 4);
  const sentences = lines.length >= 2
    ? lines.flatMap(l => l.length <= 120 ? [l] : l.split(/(?<=[。！？!?\.])\s*/).map(s => s.trim()).filter(s => s.length >= 4))
    : text.split(/(?<=[。！？!?\.])\s*/).map(s => s.trim()).filter(s => s.length >= 4);
  const uniq = [...new Set(sentences)].filter(s => s.length <= 120);
  return uniq.slice(0, MAX_INSIGHTS_PER_FILE).map(s => ({ content: s, summary: '', tags: [] }));
}

/**
 * 入库主入口
 * @param {object} opts { filePath, sourceUrl, privacyLevel ('private'|'normal'), fileType }
 * @returns {Promise<{fileId, insights:[{id, content}], usedLlm}>}
 */
export async function ingest({ filePath, sourceUrl = null, privacyLevel = 'normal', fileType = null }) {
  const rawText = extractText(filePath, fileType || 'text');
  const fileId = insertRawFile({
    privacyLevel,
    fileType: fileType || path.extname(filePath).slice(1) || 'text',
    sourceUrl,
    rawText,
  });

  // 价值过滤（先过滤原文，再决定是否调 LLM）
  const originalVerdict = isValuable(rawText);

  // 观点提取：有 Key 走 DeepSeek，无 Key 走启发式
  let items;
  let usedLlm = false;
  try {
    if (llmAvailable() && privacyLevel !== 'private') {
      items = await extractInsights(rawText);
      usedLlm = true;
    } else {
      items = heuristicInsights(rawText);
    }
  } catch (e) {
    console.error('[ingest] LLM 提取失败，降级启发式:', e.message);
    items = heuristicInsights(rawText);
  }
  // 过滤提取出的句子（只过滤无价值的）；如果原文本身有价值（事实陈述），提取结果不丢
  items = items.filter(it => isValuable(it.content || '').valuable);
  if (!items.length && originalVerdict.valuable) {
    // 原文有价值但 LLM 没提取到 → 用原文兜底
    items = [{ content: rawText.slice(0, 80), summary: '', tags: [] }];
  }
  if (!items.length) return { fileId, insights: [], usedLlm, filtered: true };

  // ===== 智能入库 v2：全部入库 → 向量化 → claim 级 8 类关系判定 =====
  // 不再用 cos 三档硬阈值做入库前决策；
  // 所有条目先入库 + 向量化，然后 onInsightCreated 里用 claim 判定器精细分类。
  // EQUIVALENT 判定后自动归档新条目（保留旧条目）；
  // CONTAINS/VERSION 判定后自动归档被替代的旧条目。
  const db = getDb();
  const created = [];
  for (const item of items) {
    const { id } = insertInsight({ content: item.content, summary: item.summary || '', tags: item.tags || [], sourceFileId: fileId });
    created.push({ id, content: item.content, summary: item.summary, tags: item.tags });
  }
  if (items.length >= MAX_INSIGHTS_PER_FILE) console.error(`[ingest] ⚠️ 达到单文件上限 ${MAX_INSIGHTS_PER_FILE} 条，超出部分未入库`);

  // 异步向量化 → claim 关系判定（comparator v2）
  const BATCH = 10;
  (async () => {
    let compared = 0;
    for (const ins of created) {
      const [vec] = await embedder.embed([ins.content]);
      attachVector(ins.id, vec);
      if (++compared % BATCH === 0 || compared === created.length) {
        for (const j of created.slice(Math.max(0, compared - BATCH), compared)) onInsightCreated(j.id);
      }
    }
    console.error(`[ingest] 已向量化 ${created.length} 条 insights，claim 判定完成`);
  })().catch(e => console.error('[ingest] 向量化失败:', e.message));

  return { fileId, insights: created, usedLlm, rejected: [], merged: [], updated: [] };
}

// 合成引擎挂钩 v2：claim 级 8 类关系判定（替代旧 cos 三档硬阈值）
import { compareNewInsight } from '../synth/comparator.js';
console.error('[ingest] 合成引擎 v2：claim 级 8 类关系判定');
export function onInsightCreated(insightId) {
  compareNewInsight(insightId)
    .then(r => {
      if (r.relations.length) console.error(`[synth-v2] ${insightId} 产生 ${r.relations.length} 条关系边`);
    })
    .catch(e => console.error('[synth-v2] 比对失败:', e.message));
  return undefined;
}

// 时间线查询（供 API / GUI）—— 排除已归档条目
export function timeline({ limit = 100 } = {}) {
  const { getDb } = require_db();
  return getDb().prepare('SELECT * FROM insights WHERE archived = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
    .map(row => ({ ...row, relations: relationsForInsight(row.id) }));
}

import { getDb } from '../db/db.js';
function require_db() { return { getDb }; }

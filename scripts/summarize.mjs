/**
 * 每条新闻要点（规则层 · LLM 生成）
 * ------------------------------------------------------------
 * - 走 OpenAI 兼容接口（用户自己的中转端点），每条新闻生成 2-4 条要点 + 一句「为什么重要」
 * - 结果进缓存跨天复用，只生成新增；预算/时间用尽不丢进度，次日继续补
 * - 任何失败都不阻断出刊：LLM 不可用时回落「抽取式要点」（从中文摘要切句），前端能区分来源
 * - 零依赖，仅用 node: 内置模块
 *
 * 环境变量：
 *   LLM_BASE_URL   如 https://api.example.com/v1（不含 /chat/completions）
 *   LLM_API_KEY    Bearer 令牌
 *   LLM_MODEL      模型名
 * 可选：
 *   SUMMARY_OFF=1         整层关闭
 *   SUMMARY_CONCURRENCY   并发数（默认 5）
 *   SUMMARY_TIMEOUT_MS    单条超时（默认 45000）
 * CLI：
 *   --summary-budget N    本次最多生成 N 条（缓存命中不计入）
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/* --------------------------- 配置 --------------------------- */

export const llmConfig = () => {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  const ok = !!(baseUrl && apiKey && model);
  return { baseUrl, apiKey, model, ok };
};

const CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_CONCURRENCY || 5));
const TIMEOUT_MS = Math.max(8000, Number(process.env.SUMMARY_TIMEOUT_MS || 45000));
const CACHE_MAX = 4000;

/* --------------------------- 缓存 --------------------------- */

export class SummaryCache {
  constructor(filePath) {
    this.path = filePath || null;
    this.map = new Map();
    this.hits = 0;
    if (filePath && existsSync(filePath)) {
      try {
        const d = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const [k, v] of Object.entries(d.entries || {})) this.map.set(k, v);
      } catch { /* 缓存坏了当没有 */ }
    }
  }
  key(model, it) {
    const t = (it.i18n?.zhTitle || it.title || '').trim();
    const u = it.url || '';
    return sha1(`${model}|${t}|${u}`);
  }
  get(k) {
    const v = this.map.get(k);
    if (v) this.hits += 1;
    return v || null;
  }
  set(k, v) {
    this.map.set(k, { ...v, ts: new Date().toISOString() });
  }
  save() {
    if (!this.path) return;
    try {
      // 容量上限：最旧的先淘汰，防止仓库无限膨胀
      if (this.map.size > CACHE_MAX) {
        const arr = [...this.map.entries()].sort((a, b) =>
          String(a[1]?.ts || '').localeCompare(String(b[1]?.ts || '')));
        for (const [k] of arr.slice(0, this.map.size - CACHE_MAX)) this.map.delete(k);
      }
      const obj = { schema: 'ai-horizon/summary-v1', updatedAt: new Date().toISOString(), entries: Object.fromEntries(this.map) };
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.path);
    } catch (e) {
      console.warn('  ⚠ summary cache 保存失败：', e.message);
    }
  }
}

/* --------------------------- LLM 调用 --------------------------- */

const SYS = `你是 AI 产业新闻编辑，为中文读者提炼新闻要点。只依据给定材料写，禁止编造材料里没有的数字、年份、投资方。
输出严格 JSON（不要 markdown 代码块）：{"points":["...","..."],"why":"..."}
规则：
- points：2~4 条，每条 ≤42 字，短句；有数字/名字就写数字/名字；按重要性排序。
- why：一句话 ≤50 字，说这件事对 AI 产业的含义（钱流、竞争格局、技术趋势等），材料不足以判断时写最保守的一句。`;

function parseTakeaways(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const points = Array.isArray(obj.points)
    ? obj.points.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 60)).slice(0, 4)
    : [];
  const why = typeof obj.why === 'string' ? obj.why.trim().slice(0, 80) : '';
  if (!points.length && !why) return null;
  return { points, why };
}

async function chatOnce(cfg, userMsg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
        temperature: 0.3,
        max_tokens: 300,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return d?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------- 抽取式兜底（无 LLM 时） ----------------------- */

function extractFallback(it) {
  const text = String(it.i18n?.zhSummary || it.summary || '').trim();
  if (!text) return null;
  const sents = text
    .split(/(?<=[。！？!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .slice(0, 3)
    .map((s) => (s.length > 60 ? `${s.slice(0, 58)}…` : s));
  if (!sents.length) return null;
  return { points: sents, why: '', src: 'fallback' };
}

/* --------------------------- 主入口 --------------------------- */

/** 给条目补 takeaways（传入的 items 应已按重要度排序）。返回统计。 */
export async function attachTakeaways(items, { cache } = {}) {
  const cfg = llmConfig();
  const off = process.env.SUMMARY_OFF === '1' || !cfg.ok;
  const need = items.filter((i) => !i.takeaways);
  const stat = { need: need.length, done: 0, llm: 0, fallback: 0, cached: 0, secs: 0, off };
  if (!need.length || off) return stat;

  const t0 = Date.now();
  const c = cache || new SummaryCache(null);
  const budget = Number(process.env.SUMMARY_BUDGET || Infinity);

  // 队列：先做有 LLM 配额且值得做的
  let llmQuota = budget;
  let idx = 0;
  const jobs = need.map((it) => ({ it }));

  const worker = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const it = job.it;
      const k = c.key ? c.key(cfg.model, it) : null;
      const hit = k ? c.get(k) : null;
      if (hit) {
        it.takeaways = { ...hit, src: hit.src || 'llm' };
        stat.done += 1; stat.cached += 1;
        if (hit.src === 'fallback') stat.fallback += 1; else stat.llm += 1;
        continue;
      }
      if (!cfg.ok || llmQuota <= 0) {
        const fb = extractFallback(it);
        if (fb) {
          it.takeaways = fb;
          if (k) c.set(k, fb);
          stat.done += 1; stat.fallback += 1;
        }
        continue;
      }
      llmQuota -= 1;
      const zhTitle = it.i18n?.zhTitle || it.title || '';
      const zhSum = it.i18n?.zhSummary || it.summary || '';
      const user =
        `标题：${zhTitle}\n` +
        `来源：${it.source || ''}（${it.region || ''}）\n` +
        `主题：${(it.topics || []).map((t) => t?.name || t).join('、')}\n` +
        `实体：${(it.entities || []).join('、')}\n` +
        `正文摘要：${zhSum.slice(0, 600) || '（无，仅标题）'}`;
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          const parsed = parseTakeaways(await chatOnce(cfg, user));
          if (parsed) {
            it.takeaways = { ...parsed, src: `llm:${cfg.model}` };
            if (k) c.set(k, { ...parsed, src: 'llm' });
            stat.done += 1; stat.llm += 1;
            ok = true;
          }
        } catch {
          if (attempt === 1) {
            const fb = extractFallback(it);
            if (fb) {
              it.takeaways = fb;
              if (k) c.set(k, fb);
              stat.done += 1; stat.fallback += 1;
            }
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  stat.secs = +((Date.now() - t0) / 1000).toFixed(1);
  return stat;
}

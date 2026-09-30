/**
 * 翻译层（规则层，零依赖）
 *
 * 目标：让每条海外要闻都能被中文读者读懂——
 *   - 非中文条目：产出中文标题 / 中文摘要
 *   - 非英文条目（日/韩/阿…）：额外产出英文标题 / 英文摘要
 *   - 原文始终保留，供对照
 *
 * 设计原则（与项目其它规则层一致）：
 *   1. 零依赖：只用 node 内置 crypto / fetch
 *   2. 永远可用：翻译失败不影响当天部署，未翻译的条目保留原文
 *   3. 可累积：结果落盘缓存，只翻新增；预算用尽也不丢进度，次日继续
 *   4. 多源降级：Google gtx（质量好、无硬配额，境外可用）→ MyMemory（境内亦可达）
 *
 * 环境变量：
 *   TRANSLATE_BUDGET      每日字符预算（默认 45000）
 *   TRANSLATE_DE_EMAIL    MyMemory 提额邮箱（匿名仅 5000 字符/天，带邮箱可到 50000）
 *   TRANSLATE_OFF=1       完全关闭翻译
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const TARGETS = { zh: { gtx: 'zh-CN', mm: 'zh-CN' }, en: { gtx: 'en', mm: 'en-US' } };

// 缓存是要入库的（否则每天重翻），不能无限膨胀。
// 每天约新增 270 条译文，留 4000 条约合 15 天，远大于 7 天的跨天去重窗口。
const MAX_CACHE_ENTRIES = 4000;

export function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 20);
}

/** 按句子/词边界截断，避免把半个句子送去翻译 */
export function clip(text, max = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const stop = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('.'),
    head.lastIndexOf('！'),
    head.lastIndexOf('!'),
    head.lastIndexOf('？'),
    head.lastIndexOf('?'),
    head.lastIndexOf(' ')
  );
  return (stop > max * 0.5 ? head.slice(0, stop + 1) : head).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(url, init = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- 翻译源 ------------------------------- */

async function viaGoogle(text, from, to) {
  const tl = TARGETS[to]?.gtx || to;
  const sl = from && from !== 'auto' ? from : 'auto';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await withTimeout(url, {}, 10000);
  if (!res.ok) throw new Error('gtx HTTP ' + res.status);
  const d = await res.json();
  if (!Array.isArray(d) || !Array.isArray(d[0])) throw new Error('gtx bad shape');
  const out = d[0].map((x) => (Array.isArray(x) ? x[0] : '')).join('');
  return out ? out.trim() : null;
}

async function viaMyMemory(text, from, to, email) {
  const tl = TARGETS[to]?.mm || to;
  const sl = from && from !== 'auto' ? from : 'autodetect';
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sl + '|' + tl)}`;
  if (email) url += `&de=${encodeURIComponent(email)}`;
  const res = await withTimeout(url, {}, 12000);
  if (!res.ok) throw new Error('mm HTTP ' + res.status);
  const d = await res.json();
  const txt = d?.responseData?.translatedText;
  // MyMemory 额度耗尽时会在 responseDetails 里回一段提示，且译文为空或与原文相同
  if (!txt) throw new Error('mm empty');
  const detail = String(d?.responseDetails || '');
  if (/QUERY LENGTH LIMIT|MYMEMORY WARNING|USAGE LIMIT/i.test(detail)) throw new Error('mm limited: ' + detail.slice(0, 60));
  if (/^MYMEMORY WARNING/i.test(txt)) throw new Error('mm limited');
  return txt.trim();
}

/* ------------------------------- 翻译器 ------------------------------- */

export class Translator {
  /**
   * @param {object} o
   * @param {string} o.cachePath  缓存文件（应入库，保证跨天累积）
   * @param {number} o.budget     本轮字符预算
   * @param {string} [o.email]    MyMemory 提额邮箱
   * @param {number} [o.gapMs]    两次请求间隔
   */
  constructor({ cachePath, budget = 45000, email = '', gapMs = 160 } = {}) {
    this.cachePath = cachePath;
    this.budget = budget;
    this.email = email || process.env.TRANSLATE_DE_EMAIL || '';
    this.gapMs = gapMs;
    this.cache = new Map();
    this.deadSources = new Set();
    this.spent = 0;
    this.calls = 0;
    this.hits = 0;
    this.fails = 0;
    this.bySrc = {};
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (this.cachePath && existsSync(this.cachePath)) {
        const d = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        for (const [k, v] of Object.entries(d.entries || {})) this.cache.set(k, v);
      }
    } catch {
      /* 缓存损坏就当没有，不影响主流程 */
    }
  }

  save() {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      let entries = [...this.cache.entries()];
      if (entries.length > MAX_CACHE_ENTRIES) {
        // 超出上限就淘汰最老的：旧译文对应的要闻早已轮出，留着只是占仓库体积
        entries.sort((a, b) => String(a[1]?.at || '').localeCompare(String(b[1]?.at || '')));
        entries = entries.slice(entries.length - MAX_CACHE_ENTRIES);
        this.cache = new Map(entries);
      }
      const obj = { schema: 'ai-horizon/i18n-v1', updatedAt: new Date().toISOString(), entries: Object.fromEntries(this.cache) };
      writeFileSync(this.cachePath, JSON.stringify(obj));
    } catch (e) {
      console.warn('  ⚠ 翻译缓存写入失败：', e.message);
    }
  }

  get remaining() {
    return Math.max(0, this.budget - this.spent);
  }

  /**
   * 翻译一段文本。返回 { text, src } 或 null（预算不足/失败/空）
   */
  async translate(text, from = 'auto', to = 'zh') {
    this.load();
    const src = String(text || '').trim();
    if (!src) return null;
    if (process.env.TRANSLATE_OFF === '1') return null;
    if (this.remaining <= 0) return null;

    const key = `${to}|${from}|${sha1(src)}`;
    const hit = this.cache.get(key);
    if (hit && hit.text) {
      this.hits++;
      return { text: hit.text, src: hit.src || 'cache' };
    }

    const order = ['google', 'mymemory'];
    for (const name of order) {
      if (this.deadSources.has(name)) continue;
      try {
        await sleep(this.gapMs);
        const out = name === 'google' ? await viaGoogle(src, from, to) : await viaMyMemory(src, from, to, this.email);
        if (out && out !== src) {
          this.cache.set(key, { text: out, src: name, at: new Date().toISOString() });
          this.spent += src.length;
          this.calls++;
          this.bySrc[name] = (this.bySrc[name] || 0) + 1;
          return { text: out, src: name };
        }
        if (out === src) {
          // 译文与原文一致：通常是源语言 == 目标语言，不算失败
          this.cache.set(key, { text: out, src: name, at: new Date().toISOString() });
          return { text: out, src: name };
        }
      } catch (e) {
        this.fails++;
        const msg = String(e.message || e.name);
        // 网络不通/超时：整源拉黑，避免后续每条都干等
        if (/abort|timeout|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(msg)) this.deadSources.add(name);
        if (/limited/i.test(msg)) this.deadSources.add(name); // 额度耗尽也不必再试
      }
    }
    return null;
  }
}

/**
 * 给一条要闻补 i18n（中英对照 + 保留原文）
 * @returns {Promise<object|null>} i18n 对象；无需翻译或全部失败则返回 null
 */
export async function buildI18n(item, tr, { summaryMax = 240 } = {}) {
  const lang = (item.lang || 'en').toLowerCase();
  if (lang === 'zh' || lang === 'zh-cn') return null;

  const title = clip(item.title || '', 160);
  const summary = clip(item.summary || '', summaryMax);

  const out = { origLang: lang, src: '', pending: [] };
  const needEn = lang !== 'en'; // 英文条目：原文即英文，无需再译英文

  // 中文（必须）
  const zhT = await tr.translate(title, lang, 'zh');
  if (zhT) out.zhTitle = zhT.text;
  else out.pending.push('zhTitle');

  if (summary) {
    const zhS = await tr.translate(summary, lang, 'zh');
    if (zhS) out.zhSummary = zhS.text;
    else out.pending.push('zhSummary');
  }

  // 英文（仅非英文原文需要，用于「中日英三语」对照）
  if (needEn) {
    const enT = await tr.translate(title, lang, 'en');
    if (enT) out.enTitle = enT.text;
    else out.pending.push('enTitle');

    if (summary) {
      const enS = await tr.translate(summary, lang, 'en');
      if (enS) out.enSummary = enS.text;
      else out.pending.push('enSummary');
    }
  }

  out.src = [zhT?.src, needEn ? undefined : 'orig'].filter(Boolean).join('+') || 'unknown';
  out.ts = new Date().toISOString();

  const got = ['zhTitle', 'zhSummary', 'enTitle', 'enSummary'].filter((k) => out[k]);
  if (!got.length) return null;
  out.partial = out.pending.length > 0;
  return out;
}

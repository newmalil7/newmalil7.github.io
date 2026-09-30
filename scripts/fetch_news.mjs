#!/usr/bin/env node
/**
 * AI 瞭望台 · 多区域要闻抓取器（零依赖）
 *
 * 用法:
 *   node scripts/fetch_news.mjs                 # 抓取全部区域
 *   node scripts/fetch_news.mjs --region CN,NA  # 仅抓指定区域
 *   node scripts/fetch_news.mjs --limit 40      # 每源最多取条数(默认 25)
 *   node scripts/fetch_news.mjs --max-age 72    # 时效硬上限(小时，默认 168=7 天)
 *   node scripts/fetch_news.mjs --fresh 48      # 「新鲜」窗口(小时，默认 72)
 *   node scripts/fetch_news.mjs --digest-only   # 只按现有归档重建每日总结与索引
 *   node scripts/fetch_news.mjs --rebuild-from-raw  # 用 data/raw 重跑策展，不重新抓取
 *
 * 输出:
 *   data/raw/<date>.json      原始归一化结果（供解读层消费）
 *   data/news-latest.json     规则版解读结果（让站点永远有可用内容）
 *   data/archive/<date>.json  按日归档
 *   data/companies.json       各公司在历次归档中出现的足迹（供每日剖析画时间线）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

/* ---------------------------------- 参数 --------------------------------- */

const argv = process.argv.slice(2);
const getArg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const ONLY_REGIONS = (getArg('--region') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const PER_SOURCE_LIMIT = Number(getArg('--limit') || 25);
const PER_REGION_CAP = Number(getArg('--per-region') || 24);
const FULL = argv.includes('--full');
const CONCURRENCY = Number(getArg('--concurrency') || 5);

/**
 * 时效控制（避免把源里积压的旧文当成今日要闻）
 * - MAX_AGE_HOURS：硬上限。超过这个年龄的条目直接丢弃（默认 7 天）。
 * - FRESH_HOURS：  「新鲜」窗口。区域配额优先用窗口内的条目填，填不满才回落到更旧的。
 * - STALE_HOURS：  超过这个年龄按"偏旧"扣分（默认 72 小时）。
 */
const MAX_AGE_HOURS = Number(getArg('--max-age') || 168);
const FRESH_HOURS = Number(getArg('--fresh') || 72);
const STALE_HOURS = Number(getArg('--stale') || 72);
/** 跨天去重的回看窗口（天）与降权幅度 */
const SEEN_WINDOW_DAYS = Number(getArg('--seen-window') || 7);
const SEEN_PENALTY = Number(getArg('--seen-penalty') || 16);

// 轮换 UA：部分站点对固定 UA 会临时限流
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

/* ------------------------------ 极简 XML 解析 ----------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', deg: '°', times: '×',
  copy: '©', reg: '®', trade: '™', bull: '•', shy: '', zwj: '', zwnj: '',
  euro: '€', pound: '£', yen: '¥', sect: '§', para: '¶', dagger: '†',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

/** 取第一个命中标签的纯文本内容 */
function pick(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = block.match(re);
    if (m && m[1] && m[1].trim()) return m[1];
  }
  return '';
}

/** 取某标签的全部出现 */
function pickAll(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** 取链接：优先 <link>文字</link>（可能被 CDATA 包裹），其次 Atom 的 <link href=""/>，再兜底 guid */
function pickLink(block) {
  const textLink = clean(pick(block, ['link']), 500);
  if (textLink && /^https?:/i.test(textLink)) return textLink;
  const atom = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
  if (atom && /^https?:/i.test(atom[1])) return clean(atom[1], 500);
  const guid = clean(pick(block, ['guid', 'id', 'origLink', 'feedburner:origLink']), 500);
  if (guid && /^https?:/i.test(guid)) return guid;
  return '';
}

/** 清洗为纯文本：去 CDATA 包裹、去标签、解码实体、压缩空白 */
function clean(input, maxLen = 600) {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/p>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\u200b-\u200f\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (maxLen && s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/[\s,，。、;；:：-]+$/, '') + '…';
  }
  return s;
}

/** 解析一个 feed，返回条目数组 */
function parseFeed(xml) {
  const blocks = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) blocks.push(m[1]);
  if (!blocks.length) while ((m = entryRe.exec(xml)) !== null) blocks.push(m[1]);
  // RDF (RSS 1.0)
  if (!blocks.length) {
    const rdfRe = /<item\b[^>]*\/>|<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    while ((m = rdfRe.exec(xml)) !== null) if (m[1]) blocks.push(m[1]);
  }

  const channelTitle = clean(pick(xml.split(/<item\b|<entry\b/i)[0] || '', ['title']), 120);

  return blocks.map((b) => {
    const title = clean(pick(b, ['title']), 300);
    const rawBody =
      pick(b, ['content:encoded']) ||
      pick(b, ['content']) ||
      pick(b, ['description']) ||
      pick(b, ['summary']) ||
      '';
    const summary = clean(rawBody, 380);
    const dateStr =
      pick(b, ['pubDate']) || pick(b, ['published']) || pick(b, ['updated']) ||
      pick(b, ['dc:date']) || pick(b, ['date']) || '';
    const categories = pickAll(b, 'category').map((c) => clean(c, 60)).filter(Boolean);
    return { title, summary, url: pickLink(b), dateStr, categories, channelTitle };
  });
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(clean(str, 80));
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

/**
 * 有些 feed 不带日期（例如 Wamda），但链接里往往藏着年月：
 *   http://wamda.com/2026/09/tanami-raises-new-funding-expand-qatar
 * 命中就拿来用。注意精度：只有年月时按「该月 1 日」占位，并标记 precision='month'，
 * 后续不会拿它当精确日期去卡时效，也不会显示成一个假的"几号"。
 */
function inferDateFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/[/-](20\d{2})[/-](\d{1,2})(?:[/-](\d{1,2}))?(?:[/-]|$)/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (y < 2015) return null;
  const day = m[3] ? Math.min(Math.max(Number(m[3]), 1), 28) : 1;
  const dt = new Date(Date.UTC(y, mo - 1, day, 12, 0, 0));
  if (dt.getTime() > Date.now() + 86400000) return null; // 明显是未来的日期，不要
  return { date: dt, precision: m[3] ? 'day' : 'month' };
}

/** 按月精度占位日反推的日期，实际含义是「这个月内」，因此给一个更宽的时效上限 */
const MONTH_AGE_HOURS = 45 * 24;
function ageLimitFor(item) {
  return item?.datePrecision === 'month' ? MONTH_AGE_HOURS : MAX_AGE_HOURS;
}

/**
 * 计算「年龄」时用的参考时刻。
 * 实时抓取时就是现在；重跑历史归档时会设为那一天结束（北京时间），
 * 否则今天去看 9 月 28 日的归档，所有条目都会被算成"两天前"，新鲜度全失真。
 */
let REF_NOW = Date.now();
function setRefNow(ms) {
  REF_NOW = Number.isFinite(ms) ? ms : Date.now();
}
/** 某一天（北京时间）的结束时刻 */
function dayEndRef(date) {
  const t = Date.parse(`${date}T23:59:59+08:00`);
  return Number.isFinite(t) ? t : Date.now();
}
/**
 * 某个归档文件对应的「参考时刻」。
 * 用归档自己的 generatedAt（当天实际抓取的时刻）——因为站点是早上 9 点抓的，
 * 「24 小时内」指的是抓取那一刻往前 24 小时；若按当天 24 点算，
 * 上午抓到的内容会被平白算老 14 小时，新鲜度就失真了。
 */
function archiveRef(archiveJson, date) {
  const t = Date.parse(archiveJson?.generatedAt || '');
  return Number.isFinite(t) ? t : dayEndRef(date);
}

/** 条目年龄（小时）；没有日期返回 null */
function ageHours(item, now = REF_NOW) {
  if (!item?.publishedAt) return null;
  const t = new Date(item.publishedAt).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 36e5;
}

/* ------------------------------ 跨天去重索引 ------------------------------ */

/** URL 归一化：去掉查询串、末尾斜杠，统一小写，用于跨天比对 */
function urlKey(u) {
  return String(u || '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 读最近 N 天归档，建立「已经出现过」的索引。
 *
 * 为什么需要它：时效窗口是 7 天，同一篇文章会在这个窗口里连续多天被抓到，
 * 而重要度的日间变化很小 —— 结果就是「今天的要闻」和昨天几乎一样，
 * 读者感觉"刷新了也没换内容"。这里把见过的条目识别出来：
 *   - 打上 firstSeen（首次出现的日期）与 isNew 标记
 *   - 在排序上降权，让真正新增的内容浮上来
 *
 * 注意：只读「early days」（严格早于目标日期），这样同一天重跑（CI 兜底补刷）
 * 不会把当天自己的内容误判成旧闻。
 */
function loadSeenIndex(date, days = 7) {
  const seenUrl = new Map(); // urlKey -> 首次出现日期
  const seenId = new Map(); // id     -> 首次出现日期
  const dir = path.join(DATA, 'archive');
  const used = [];
  if (!fs.existsSync(dir)) return { seenUrl, seenId, used };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .filter((d) => d < date)
    .sort()
    .reverse()
    .slice(0, days);
  for (const d of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, `${d}.json`), 'utf8'));
      for (const it of j.items || []) {
        const k = urlKey(it.url);
        if (k && !seenUrl.has(k)) seenUrl.set(k, d);
        if (it.id && !seenId.has(it.id)) seenId.set(it.id, d);
      }
      used.push(d);
    } catch {
      /* 单个归档坏了不影响整体 */
    }
  }
  return { seenUrl, seenId, used };
}

/** 该条目是否在历史归档里出现过；返回首次出现日期或 null */
function firstSeenOf(item, idx) {
  const byId = item.id ? idx.seenId.get(item.id) : null;
  if (byId) return byId;
  const k = urlKey(item.url);
  return k ? idx.seenUrl.get(k) || null : null;
}

/* --------------------------------- 抓取 ---------------------------------- */

async function fetchWithTimeout(url, ms = 25000, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA_POOL[attempt % UA_POOL.length],
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: new URL(url).origin + '/',
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    if (!/<(item|entry|rdf:RDF)\b/i.test(text)) throw new Error('响应不是 feed（可能被拦截）');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 带退避重试的抓取 */
async function fetchFeed(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchWithTimeout(url, 25000 + i * 5000, i);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 简易并发池 */
async function pool(tasks, size) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------- 规则解读层 ------------------------------- */

/** 主题分类：面向小白的六大产业板块 */
const TOPIC_RULES = [
  {
    id: 'model',
    name: '模型与能力',
    plain: '又有人把 AI 的"脑子"升级了一代',
    color: '#6d5efc',
    kw: ['模型', '大模型', 'llm', 'gpt', 'claude', 'gemini', 'llama', 'qwen', 'deepseek',
      '参数', '多模态', '推理能力', 'benchmark', '基准', '发布新模型', 'foundation model',
      'ai model', 'frontier model', 'reasoning model', 'context window', '上下文'],
  },
  {
    id: 'compute',
    name: '算力与基建',
    plain: '支撑 AI 运转的"电力与厂房"又扩容了',
    color: '#0ea5e9',
    kw: ['芯片', '算力', 'gpu', 'nvidia', '英伟达', '台积电', 'tsmc', '数据中心', 'data center',
      '云端', 'cloud', 'h100', 'b200', 'asml', '光刻', '存储', '服务器', '液冷', '电力',
      'compute', 'semiconductor', 'accelerator', 'supercomputer', '超算'],
  },
  {
    id: 'capital',
    name: '资本与市场',
    plain: '钱在往哪里流，行业重心就在哪里',
    color: '#f59e0b',
    kw: ['融资', '估值', '投资', 'ipo', '上市', '并购', '收购', '财报', '营收', '亏损',
      'funding', 'raises', 'valuation', 'acquire', 'acquisition', 'series a', 'series b',
      'seed round', '营收增长', 'revenue', 'ipo', 'layoff', '裁员', '市值'],
  },
  {
    id: 'product',
    name: '产品与应用',
    plain: 'AI 具体被拿去做成了什么能用的东西',
    color: '#10b981',
    kw: ['产品', '应用', '发布', '上线', 'agent', '智能体', '助手', 'copilot', 'app', '功能',
      '用户体验', 'launch', 'rolls out', 'feature', 'assistant', 'chatbot', '工具',
      '落地', '场景', '客服', '编码', '写作', '生成视频', '生成图片'],
  },
  {
    id: 'policy',
    name: '政策与治理',
    plain: '规则制定者正在给 AI 划边界',
    color: '#ef4444',
    kw: ['监管', '政策', '法案', '合规', '标准', '安全', '隐私', '版权', '反垄断', '禁令',
      'regulation', 'policy', 'act', 'compliance', 'safety', 'privacy', 'copyright',
      'lawsuit', '诉讼', 'ethics', '伦理', '备案', '许可证', 'sovereign', '主权'],
  },
  {
    id: 'industry',
    name: '产业与生态',
    plain: '大厂、人才和开源社区在怎么重新排座次',
    color: '#8b5cf6',
    kw: ['开源', 'open source', '合作', '战略', '组织', '人事', '加盟', '离职', '招聘',
      '人才', '生态', '联盟', 'partner', 'partnership', 'hiring', 'talent', 'research',
      '论文', '研究', '实验室', 'lab', '开源社区', '会议'],
  },
];

const MAJOR_ENTITIES = [
  'openai', 'anthropic', 'google', 'deepmind', 'microsoft', 'meta', 'apple', 'amazon',
  'nvidia', '英伟达', 'intel', 'amd', 'tsmc', '台积电', 'samsung', '三星', 'sk hynix',
  'xai', 'mistral', 'cohere', 'perplexity', 'midjourney', 'stability',
  '阿里巴巴', '阿里', 'alibaba', '腾讯', 'tencent', '字节', 'bytedance', '百度', 'baidu',
  '华为', 'huawei', '小米', 'xiaomi', '商汤', '旷视', '月之暗面', 'moonshot', '智谱',
  'minimax', '百川', '零一万物', '科大讯飞', 'iflytek', 'deepseek', '深度求索', 'qwen',
  'softbank', '软银', 'g42', 'huawei cloud', 'stargate', 'coreweave', 'oracle',
  'salesforce', 'adobe', 'sap', 'siemens', 'asml', 'arm', 'qualcomm', 'broadcom',
  // 创业公司 / 新兴玩家：不只影响标签，也让「每日剖析」有足够的轮换对象
  'elevenlabs', 'hugging face', 'huggingface', 'scale ai', 'groq', 'cerebras', 'sambanova',
  'together ai', 'figure ai', 'physical intelligence', 'suno', 'runway ml', 'anysphere',
  'poolside', 'cognition ai', 'tempus', 'vast data', 'weights & biases', 'weights and biases',
  'nebius', 'lambda labs', 'stability ai', 'openrouter', 'fireworks ai', 'baseten', 'ollama',
  'langchain', 'securiti', 'sierra ai', 'ai21', 'aleph alpha', 'character.ai', 'inflection',
  '生数科技', '面壁智能', '阶跃星辰', '无问芯穹', '硅基流动', '壁仞', '摩尔线程', '燧原',
  '沐曦', '天数智芯', '宇树', 'unitree', '智元机器人', '银河通用', '星海图', '傅利叶',
  '深势科技', '潞晨', '澜舟', '元象', '燧原科技', '思必驰', '云从', '依图', '格灵深瞳',
];

const DIFFICULTY_ADVANCED = [
  'benchmark', '基准测试', '架构', 'architecture', '训练', 'training', '微调', 'fine-tun',
  '论文', 'paper', 'arxiv', '算法', 'algorithm', 'transformer', '扩散', 'diffusion',
  '蒸馏', 'distillation', '量化', 'quantization', 'moe', '混合专家', '强化学习',
  'rlhf', 'attention', '注意力机制', 'routing', '推理优化', 'kernel', 'cuda',
];
const DIFFICULTY_BASIC = [
  '融资', 'funding', 'raises', '发布', 'launch', '上线', '用户', 'app', '功能', 'feature',
  '收购', 'acquire', '裁员', 'layoff', '监管', 'regulation', '法案', '价格', '定价',
  'pricing', '合作', 'partnership', '招聘',
];

/**
 * 关键词命中（用于主题/难度打分）。
 * 单字英文按词匹配并允许常见词形变化，避免 app 命中 apple、act 命中 impact 之类的误判；
 * 带连字符的（如 fine-tun）按前缀处理，中文与短语按直接包含。
 */
const kwCache = new Map();
function kwHit(hay, w) {
  if (!w) return false;
  const word = String(w).toLowerCase();
  if (!ASCII_ONLY.test(word)) return hay.includes(word);
  if (word.includes(' ')) return hay.includes(word);
  let re = kwCache.get(word);
  if (!re) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = word.includes('-') ? '' : '(?:s|es|ing|ed|ion)?';
    re = new RegExp(`(?<![a-z0-9])${esc}${tail}(?![a-z0-9])`);
    kwCache.set(word, re);
  }
  return re.test(hay);
}

function countHits(haystack, words) {
  let n = 0;
  const matched = [];
  for (const w of words) {
    if (kwHit(haystack, w)) {
      n += 1;
      matched.push(w);
    }
  }
  return { n, matched };
}

/**
 * 实体命中判断。
 * 必须按「词」匹配而不是子串包含——否则 intel 会命中 intelligence、
 * arm 会命中 alarm/charm、meta 会命中 metaverse，实体标签会大面积失真。
 */
const ASCII_ONLY = /^[\x00-\x7f]+$/;
const boundaryCache = new Map();
function entityHit(hay, needle) {
  if (!needle) return false;
  const n = String(needle).toLowerCase();
  if (!ASCII_ONLY.test(n)) return hay.includes(n); // 中文等按直接包含
  let re = boundaryCache.get(n);
  if (!re) {
    re = new RegExp(`(?<![a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    boundaryCache.set(n, re);
  }
  return re.test(hay);
}

/** 实体别名 → 展示名（同时供分类与「公司足迹」索引复用） */
const ENTITY_LABEL = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepmind: 'DeepMind',
  microsoft: 'Microsoft', meta: 'Meta', apple: 'Apple', amazon: 'Amazon',
  nvidia: 'NVIDIA', 英伟达: 'NVIDIA', intel: 'Intel', amd: 'AMD', tsmc: '台积电',
  台积电: '台积电', samsung: '三星', 三星: '三星', 'sk hynix': 'SK 海力士',
  xai: 'xAI', mistral: 'Mistral AI', cohere: 'Cohere', perplexity: 'Perplexity',
  midjourney: 'Midjourney', stability: 'Stability AI',
  // 中文名优先，避免前端标签里出现 alibaba / tencent 这种小写原名
  阿里巴巴: '阿里巴巴', 阿里: '阿里巴巴', alibaba: '阿里巴巴',
  腾讯: '腾讯', tencent: '腾讯', 字节: '字节跳动', bytedance: '字节跳动',
  百度: '百度', baidu: '百度', 华为: '华为', huawei: '华为', 'huawei cloud': '华为云',
  小米: '小米', xiaomi: '小米', 商汤: '商汤', 旷视: '旷视', 云从: '云从科技',
  依图: '依图科技', 格灵深瞳: '格灵深瞳',
  月之暗面: '月之暗面', moonshot: '月之暗面', 智谱: '智谱AI', minimax: 'MiniMax',
  百川: '百川智能', 零一万物: '零一万物', 科大讯飞: '科大讯飞', iflytek: '科大讯飞',
  deepseek: 'DeepSeek', 深度求索: 'DeepSeek', qwen: '通义千问',
  softbank: '软银', 软银: '软银', g42: 'G42', oracle: 'Oracle', salesforce: 'Salesforce',
  adobe: 'Adobe', sap: 'SAP', siemens: 'Siemens', asml: 'ASML', arm: 'Arm',
  qualcomm: '高通', broadcom: '博通', coreweave: 'CoreWeave', stargate: 'Stargate',
  // 创业公司
  elevenlabs: 'ElevenLabs', 'hugging face': 'Hugging Face', huggingface: 'Hugging Face',
  'scale ai': 'Scale AI', groq: 'Groq', cerebras: 'Cerebras', sambanova: 'SambaNova',
  'together ai': 'Together AI', 'figure ai': 'Figure AI',
  'physical intelligence': 'Physical Intelligence', suno: 'Suno', 'runway ml': 'Runway',
  anysphere: 'Anysphere（Cursor）', poolside: 'Poolside', 'cognition ai': 'Cognition',
  tempus: 'Tempus AI', 'vast data': 'VAST Data', 'weights & biases': 'Weights & Biases',
  'weights and biases': 'Weights & Biases', nebius: 'Nebius', 'lambda labs': 'Lambda Labs',
  'stability ai': 'Stability AI', openrouter: 'OpenRouter', 'fireworks ai': 'Fireworks AI',
  baseten: 'Baseten', ollama: 'Ollama', langchain: 'LangChain', securiti: 'Securiti',
  'sierra ai': 'Sierra', ai21: 'AI21 Labs', 'aleph alpha': 'Aleph Alpha',
  'character.ai': 'Character.AI', inflection: 'Inflection AI',
  生数科技: '生数科技', 面壁智能: '面壁智能', 阶跃星辰: '阶跃星辰', 无问芯穹: '无问芯穹',
  硅基流动: '硅基流动', 壁仞: '壁仞科技', 摩尔线程: '摩尔线程', 燧原: '燧原科技',
  燧原科技: '燧原科技', 沐曦: '沐曦', 天数智芯: '天数智芯', 宇树: '宇树科技',
  unitree: '宇树科技', 智元机器人: '智元机器人', 银河通用: '银河通用', 星海图: '星海图',
  傅利叶: '傅利叶智能', 深势科技: '深势科技', 潞晨: '潞晨科技', 澜舟: '澜舟科技',
  元象: '元象 XVERSE', 思必驰: '思必驰',
};

function classify(item) {
  const hay = `${item.title} ${item.summary} ${item.categories.join(' ')}`.toLowerCase();

  // 主题：可多标签，按命中数排序取前 2
  const scored = TOPIC_RULES.map((t) => {
    const { n } = countHits(hay, t.kw);
    return { ...t, hits: n };
  })
    .filter((t) => t.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const topics = scored.slice(0, 2).map((t) => ({ id: t.id, name: t.name, color: t.color }));

  // 实体
  const entities = MAJOR_ENTITIES.filter((e) => entityHit(hay, e))
    .map((e) => ENTITY_LABEL[e] || e);
  const entityList = [...new Set(entities)].slice(0, 4);

  // 难度
  const adv = countHits(hay, DIFFICULTY_ADVANCED).n;
  const bas = countHits(hay, DIFFICULTY_BASIC).n;
  const topicIds = topics.map((t) => t.id);
  let difficulty = '进阶';
  if (adv >= 1 && adv > bas) difficulty = '高级';
  else if (topicIds.includes('compute')) difficulty = adv >= 2 ? '高级' : '进阶';
  else if (adv === 0 && bas >= 2) difficulty = '入门';
  else if (adv === 0 && bas >= 1 && topicIds.some((t) => ['policy', 'capital', 'product'].includes(t)))
    difficulty = '入门';
  else if (adv >= 1) difficulty = '进阶';

  // 重要度：35 ~ 99，避免大面积顶格
  // 时效权重被刻意放大：今日要闻里，「今天发生的」应当压过「很久以前但主角很大牌」的。
  // 只有日期精确到日的条目才按真实年龄打分；只剩年月（datePrecision='month'）或完全
  // 没日期的源，给一个中性分——不能因为"不知道多新"就把人家当旧闻踩下去。
  const precise = item.datePrecision !== 'month';
  const ageH = precise ? ageHours(item) : null;
  const freshBonus =
    ageH === null ? 13
      : ageH <= 6 ? 30
        : ageH <= 12 ? 26
          : ageH <= 24 ? 21
            : ageH <= 48 ? 13
              : ageH <= FRESH_HOURS ? 7
                : ageH <= MAX_AGE_HOURS ? 2
                  : 0;
  const stalePenalty = ageH !== null && ageH > STALE_HOURS ? -8 : 0;
  let importance =
    35 +
    Math.min(scored[0]?.hits || 0, 5) * 4 +
    Math.min(entityList.length, 3) * 6 +
    (item.sourceTier === 1 ? 9 : 0) +
    freshBonus +
    stalePenalty +
    (difficulty === '入门' ? 3 : 0) +
    (topics.length === 0 ? -8 : 0);
  importance = Math.max(20, Math.min(99, Math.round(importance)));

  // 难度对应的白话提示
  const plainHint = scored[0]?.plain || '行业又有了新动向';

  return { topics, entities: entityList, difficulty, importance, plainHint };
}

/* --------------------------- 每日总结（规则层） --------------------------- */

/** 列出某数据子目录里所有按日期命名的文件，按日期倒序 */
function readDated(sub) {
  const dir = path.join(DATA, sub);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
}

/** 精简条目：只保留前端展示所需字段 */
function slimItem(it) {
  return {
    id: it.id,
    title: it.title,
    source: it.source,
    region: it.region,
    url: it.url,
    importance: it.importance,
    difficulty: it.difficulty,
    publishedAt: it.publishedAt,
    topics: (it.topics || []).map((t) => t.name),
    entities: it.entities || [],
    firstSeen: it.firstSeen,
    isNew: it.isNew,
  };
}

/**
 * 生成一天的「规则层总结」。
 * 刻意不依赖 iMac / LLM：CI 每天跑完抓取就能产出，保证归档台每天都有内容。
 */
function buildDigest({ date, nowIso, curated, regions, stats }) {
  const byRegionItems = {};
  for (const r of regions) byRegionItems[r.code] = curated.filter((i) => i.region === r.code);

  const topicCounts = {};
  for (const it of curated) for (const t of it.topics || []) topicCounts[t.name] = (topicCounts[t.name] || 0) + 1;
  const themes = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name, n]) => ({ name, n }));

  const entCounts = {};
  for (const it of curated) for (const e of it.entities || []) entCounts[e] = (entCounts[e] || 0) + 1;
  const entities = Object.entries(entCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => ({ name, n }));

  const topOverall = curated.slice(0, 8).map(slimItem);

  const regionPicks = regions
    .map((r) => {
      const arr = byRegionItems[r.code] || [];
      return {
        code: r.code,
        name: r.name || r.short,
        short: r.short || r.code,
        flag: r.flag || '',
        count: arr.length,
        top: arr.slice(0, 3).map(slimItem),
      };
    })
    .filter((x) => x.count > 0);

  const [, mm, dd] = date.split('-');
  // 总览里优先引用中文标题的条目，读起来更顺（没有中文条目时再回落到重要度前 3）
  const CJK = /[\u4e00-\u9fff]/;
  const zhPicks = topOverall.filter((i) => CJK.test(i.title)).slice(0, 3);
  const pickSource = zhPicks.length >= 2 ? zhPicks : topOverall.slice(0, 3);
  const head3 = pickSource.map((i) => `「${i.title}」（${i.source}）`).join('、');
  const themeTxt = themes.slice(0, 2).map((t) => `「${t.name}」${t.n} 条`).join('、');

  // 当日新鲜度（供总览与前端展示）
  const within = (h) => curated.filter((i) => { const a = ageHours(i); return a !== null && a <= h; }).length;
  const freshness = {
    within24h: within(24),
    withinFresh: within(stats.freshness?.freshHours || FRESH_HOURS),
    freshHours: stats.freshness?.freshHours || FRESH_HOURS,
    monthPrecision: curated.filter((i) => i.datePrecision === 'month').length,
    undated: curated.filter((i) => ageHours(i) === null && i.datePrecision !== 'month').length,
    staleDropped: stats.freshness?.staleDropped || 0,
    newestAt: curated
      .map((i) => i.publishedAt)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null,
  };

  const freshTxt = freshness.within24h
    ? `其中有 ${freshness.within24h} 条发布于 24 小时内。`
    : `今日新发布的条目较少，多为近 ${Math.round(freshness.freshHours / 24)} 天内的内容。`;

  // 跨天去重：这一天里有多少条是「新面孔」，多少条是前几天已经推过的
  const newCount = curated.filter((i) => i.isNew).length;
  const repeatCount = curated.length - newCount;
  const newTxt = curated.length
    ? `其中 ${newCount} 条是此前未出现过的新增内容` +
      (repeatCount ? `，另有 ${repeatCount} 条为近 ${stats.seenWindowDays || SEEN_WINDOW_DAYS} 天内的延续报道（已降权排后）。` : '。')
    : '';

  const overview =
    `${Number(mm)} 月 ${Number(dd)} 日，共从 ${stats.sourceOk} 个信息源抓取 ${stats.total} 条 AI 产业动态，` +
    `其中 ${curated.length} 条进入当日精选，覆盖 ${regionPicks.length} 个区域。` +
    freshTxt +
    newTxt +
    (themeTxt ? `当日最集中的板块是${themeTxt}。` : '') +
    (head3 ? `值得优先关注的几条：${head3}。` : '');

  return {
    schema: 'ai-horizon/digest-v1',
    date,
    generatedAt: nowIso,
    mode: 'rule',
    counts: {
      crawled: stats.total,
      published: curated.length,
      newCount,
      repeatCount,
      byRegion: Object.fromEntries(regionPicks.map((r) => [r.code, r.count])),
      sourceOk: stats.sourceOk,
      sourceTotal: stats.sourceTotal,
      regions: regionPicks.length,
    },
    freshness,
    themes,
    entities,
    topOverall,
    regions: regionPicks,
    overview,
  };
}

/* ------------------------------ 索引重建工具 ----------------------------- */

/** 重建 data/archive-index.json（按日期倒序，total 取归档文件真实条数） */
function rebuildArchiveIndex() {
  const files = readDated('archive');
  const index = files.map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', f), 'utf8'));
      return {
        date: f.replace('.json', ''),
        total: (j.items || []).length,
        crawled: j.stats?.total || 0,
      };
    } catch {
      return { date: f.replace('.json', ''), total: 0, crawled: 0 };
    }
  });
  fs.writeFileSync(path.join(DATA, 'archive-index.json'), JSON.stringify(index, null, 1));
  return index;
}

/** 重建 data/digests.json（每天一句话总结的索引） */
function rebuildDigestsIndex() {
  const files = readDated('digest');
  const index = files.map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, 'digest', f), 'utf8'));
      return {
        date: j.date,
        crawled: j.counts?.crawled || 0,
        published: j.counts?.published || 0,
        regions: j.counts?.regions || 0,
        within24h: j.freshness?.within24h || 0,
        overview: j.overview || '',
        themes: (j.themes || []).slice(0, 4).map((t) => t.name),
      };
    } catch {
      return { date: f.replace('.json', ''), crawled: 0, published: 0, regions: 0, within24h: 0, overview: '', themes: [] };
    }
  });
  fs.writeFileSync(path.join(DATA, 'digests.json'), JSON.stringify(index, null, 1));
  return index;
}

/**
 * 重建 data/companies.json —— 「公司足迹」索引。
 *
 * 把历次归档里提到某家公司的条目按日期串起来，前端就能给「每日剖析」画出一条
 * 真实的时间线（这家公司哪天因为什么事上了要闻）。它不依赖 agent、也不依赖本机，
 * 只要归档在累积，时间线就会自己变长。
 */
function buildCompaniesIndex() {
  const TRACK_CAP = 40; // 每家公司最多保留的足迹节点数（按日期倒序取新）

  // 追踪名单：内置大厂/机构 + 剖析过的公司与观察名单（含别名）
  const aliasToName = new Map();
  const track = (name, aliases = []) => {
    if (!name) return;
    for (const a of [name, ...aliases]) {
      const key = String(a || '').trim().toLowerCase();
      if (key && !aliasToName.has(key)) aliasToName.set(key, name);
    }
  };
  for (const e of new Set(Object.values(ENTITY_LABEL))) track(e);
  try {
    const pf = JSON.parse(fs.readFileSync(path.join(DATA, 'profiles.json'), 'utf8'));
    for (const p of pf.list || []) track(p.name, [p.nameZh, ...(p.aliases || [])]);
    for (const w of pf.watchlist?.items || []) track(w.name, [w.nameZh, ...(w.aliases || [])]);
  } catch {
    /* 没有 profiles.json 也能跑，只索引内置实体 */
  }

  const nodes = new Map(); // name -> Map(key -> node)
  const add = (name, node) => {
    if (!nodes.has(name)) nodes.set(name, new Map());
    const m = nodes.get(name);
    const k = `${node.date}|${node.url}`;
    if (!m.has(k)) m.set(k, node);
  };

  const files = readDated('archive'); // 日期倒序
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', f), 'utf8'));
    } catch {
      continue;
    }
    const date = j.date || f.replace('.json', '');
    for (const it of j.items || []) {
      const hit = new Set(it.entities || []);
      const hay = `${it.title || ''} ${it.summary || ''}`.toLowerCase();
      for (const [alias, name] of aliasToName) if (hay.includes(alias)) hit.add(name);
      if (!hit.size) continue;
      const node = {
        date,
        title: it.title,
        url: it.url,
        source: it.source,
        region: it.region,
        importance: it.importance,
      };
      for (const n of hit) add(n, node);
    }
  }

  const companies = [...nodes.entries()]
    .map(([name, m]) => {
      const items = [...m.values()].sort((a, b) => b.date.localeCompare(a.date));
      return { name, count: items.length, first: items[items.length - 1]?.date || '', last: items[0]?.date || '', items: items.slice(0, TRACK_CAP) };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const payload = {
    schema: 'ai-horizon/companies-v1',
    updatedAt: new Date().toISOString(),
    archivedDays: files.length,
    companies,
  };
  fs.writeFileSync(path.join(DATA, 'companies.json'), JSON.stringify(payload, null, 1));
  return payload;
}

/* --------------------------- 每日剖析（规则层） --------------------------- */

/**
 * 大厂黑名单：剖析刻意避开人尽皆知的巨头，聚焦有特色、被产业资本扶植的公司。
 * 这是一道保险——即使它当天在要闻里刷屏，也不会被选为剖析对象。
 */
const PROFILE_BLOCKLIST = new Set([
  'OpenAI', 'Anthropic', 'Google', 'DeepMind', 'Microsoft', 'Meta', 'Apple', 'Amazon',
  'NVIDIA', 'Intel', 'AMD', '台积电', '三星', '阿里巴巴', '腾讯', '百度', '华为', '华为云',
  '小米', '字节跳动', '软银', 'Oracle', 'Salesforce', 'Adobe', 'SAP', 'Siemens', 'ASML',
  'Arm', '高通', '博通', 'IBM', 'SK 海力士', 'Stargate', '通义千问',
]);

/**
 * 「人尽皆知」名单：不是不能剖析，而是在同等条件下让位给更少被讲的公司。
 * 目的是让这个栏目长期来看是「公司库」，而不是天天讲同一批明星。
 */
const PROFILE_WELL_KNOWN = new Set(['xAI', 'DeepSeek', 'Mistral AI', 'Perplexity', 'Cohere', 'CoreWeave', 'Stability AI', 'Midjourney']);

/** 话题字段在不同数据源里可能是字符串或 {name} 对象，统一取名字 */
function topicName(t) {
  return typeof t === 'string' ? t : t?.name || '';
}

/**
 * 一条新闻里出现的全部实体（不设上限）。
 *
 * 故事背景：给要闻打标签时每条只保留前 4 个实体（避免标签栏刷屏），
 * 但剖析要找的是「今天有谁被反复提到」——用被截断的 4 个标签去做候选池，
 * 会漏掉很多本来够格的对象。所以这里重新扫一遍原文，拿完整名单。
 */
function allEntitiesOf(it) {
  const hay = `${it.title || ''} ${it.summary || ''} ${(it.categories || []).join(' ')}`.toLowerCase();
  const out = new Set(it.entities || []);
  for (const e of MAJOR_ENTITIES) if (entityHit(hay, e)) out.add(ENTITY_LABEL[e] || e);
  return [...out];
}

/** 节点标签关键词：只做归类，不做主观判断 */
const TIMELINE_TAGS = [
  ['融资', /(rais|funding|\bfunds?\b|\bseed\b|investment|valuation|\bbets?\b|融资|募资|估值|投资|\b轮\b|ipo)/i],
  ['并购', /(acqui|merger|takeover|收购|并购|合并)/i],
  ['合作', /(partner|collaborat|alliance|contract|\bdeals?\b|\borders?\b|合作|联手|达成|签约|供应)/i],
  ['产品', /(launch|unveil|releas|rollout|introduc|\bships?\b|shipped|推出|发布|上线|开源|公测|内测|更新)/i],
  ['政策', /(regulat|polic|\b(ban|bill|law)s?\b|antitrust|法案|监管|合规|牌照|诉讼|调查)/i],
  ['技术', /(benchmark|\bpaper\b|research|training|inference|\bmodels?\b|模型|基准|论文|训练|推理|架构)/i],
  ['人事', /(\bceo\b|\bcto\b|\bcfo\b|hir(e|es|ing)|layoff|resign|高管|任命|裁员|离职|创始人)/i],
];
function inferTimelineTag(it) {
  const hay = `${it.title || ''} ${it.summary || ''}`;
  for (const [tag, re] of TIMELINE_TAGS) if (re.test(hay)) return tag;
  return '动态';
}

/** 展示名 → 全部别名（小写）。用于「宇树」能否命中「宇树科技」这类问题 */
const LABEL_ALIASES = (() => {
  const m = new Map();
  const put = (label, alias) => {
    if (!m.has(label)) m.set(label, new Set());
    m.get(label).add(String(alias).toLowerCase());
  };
  for (const [alias, label] of Object.entries(ENTITY_LABEL)) {
    put(label, alias);
    put(label, label);
  }
  for (const e of MAJOR_ENTITIES) put(ENTITY_LABEL[e] || e, e);
  return m;
})();
function aliasesOf(name) {
  return [...(LABEL_ALIASES.get(name) || new Set([String(name).toLowerCase()]))];
}
function textHasAlias(text, name) {
  const hay = String(text || '').toLowerCase();
  // 英文别名按词匹配，避免 sap 命中 sapiens、meta 命中 metaverse 这类误判
  return aliasesOf(name).some((a) => a && entityHit(hay, a));
}

/** 公司名 → 稳定的 id 片段 */
function slugify(s) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'company';
}

/** 日期平移（按北京时间），返回 YYYY-MM-DD */
function shiftDate(date, deltaDays) {
  const t = Date.parse(`${date}T12:00:00+08:00`);
  if (!Number.isFinite(t)) return date;
  return new Date(t + deltaDays * 86400000).toISOString().slice(0, 10);
}

function profilesPath() {
  return path.join(DATA, 'profiles.json');
}

/** 读剖析库（可能是手写的，也可能是上次自动生成的） */
function readProfiles() {
  try {
    const p = JSON.parse(fs.readFileSync(profilesPath(), 'utf8'));
    if (p && Array.isArray(p.list)) return p;
  } catch {
    /* 首次运行时文件还不存在 */
  }
  return { schema: 'ai-horizon/profiles-v1', list: [] };
}

/**
 * 生成当天的剖析对象（规则层）。
 *
 * 为什么必须有它：剖析原先完全由本机 agent 手写产出，机器一关就断供、
 * 内容永远停在同一个日期同一家公司。这里改成从真实来源里聚合：
 *   1. 候选 = 当天要闻里被提到的公司，剔除大厂与近几天已剖析过的；
 *   2. 打分 = 当日提及数 + 归档足迹长度 + 融资/并购类信号；
 *   3. 内容 = 该公司在历次归档里的真实报道，按时间正序排成一条线。
 * 全程不做主观判断，也不编造金额、轮次、投资方——没有依据的字段一律不写。
 */
function buildDailyProfile({ date, curated, regions, windowDays = 45, rotateDays = 7 }) {
  const rmap = Object.fromEntries(regions.map((r) => [r.code, r]));
  const rname = (c) => rmap[c]?.name || c;
  const rflag = (c) => rmap[c]?.flag || '';

  // 1) 当日候选（排除大厂）
  const todayHits = new Map();
  const todayEnt = new Map(); // item -> 完整实体名单（扫描一次，后面复用）
  for (const it of curated) {
    const ents = allEntitiesOf(it);
    todayEnt.set(it, ents);
    for (const e of ents) {
      if (PROFILE_BLOCKLIST.has(e)) continue;
      if (!todayHits.has(e)) todayHits.set(e, []);
      todayHits.get(e).push(it);
    }
  }
  if (!todayHits.size) return null;

  // 2) 足迹：读 ≤date 的归档（含当天），把提到候选公司的条目全捞出来
  const days = readDated('archive')
    .map((f) => f.replace('.json', ''))
    .filter((d) => d <= date)
    .sort()
    .reverse()
    .slice(0, windowDays);
  const footprint = new Map();
  const pushNode = (name, node) => {
    if (!footprint.has(name)) footprint.set(name, []);
    const arr = footprint.get(name);
    if (arr.some((x) => x.date === node.date && urlKey(x.url) === urlKey(node.url))) return;
    arr.push(node);
  };
  for (const d of days) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', `${d}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const it of j.items || []) {
      const ents = allEntitiesOf(it);
      for (const name of todayHits.keys()) {
        if (!ents.includes(name) && !textHasAlias(`${it.title} ${it.summary}`, name)) continue;
        pushNode(name, {
          date: d,
          title: it.title,
          url: it.url,
          source: it.source,
          region: it.region,
          importance: it.importance,
          summary: it.summary || '',
          topics: it.topics || [],
          entities: ents,
          // 标题里出现 = 它是这条新闻的主角；只在摘要里出现 = 只是被顺带提到
          titleHit: textHasAlias(it.title, name),
        });
      }
    }
  }

  const titleHitsToday = (name) =>
    (todayHits.get(name) || []).filter((it) => textHasAlias(it.title, name)).length;

  const scoreOf = (name) => {
    const anyToday = todayHits.get(name) || [];
    const foot = footprint.get(name) || [];
    const footTitle = foot.filter((n) => n.titleHit).length;
    const signals = foot.filter((n) => ['融资', '并购'].includes(inferTimelineTag(n))).length;
    const base =
      titleHitsToday(name) * 22 +
      anyToday.length * 6 +
      Math.min(footTitle, 12) * 8 +
      Math.min(foot.length, 24) * 2 +
      Math.min(signals, 6) * 6;
    // 明星公司在同等条件下让位，让这个栏目长期更像「公司库」
    return base - (PROFILE_WELL_KNOWN.has(name) ? 24 : 0);
  };

  // 3) 近期已剖析过的不重复（避免连着好几天同一家）
  const pf = readProfiles();
  const recentCut = shiftDate(date, -rotateDays);
  const recent = new Set(
    (pf.list || [])
      .filter((p) => p.date && p.date >= recentCut && p.date < date)
      .map((p) => String(p.name || '').trim().toLowerCase())
  );

  const ranked = [...todayHits.keys()]
    .map((name) => ({
      name,
      score: scoreOf(name),
      t: titleHitsToday(name),
      a: (todayHits.get(name) || []).length,
      f: (footprint.get(name) || []).length,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.t - a.t ||
        b.a - a.a ||
        b.f - a.f ||
        a.name.localeCompare(b.name)
    );
  // 明星公司让位：只要今天还有「更少被讲」的公司可选，就不选那些人尽皆知的
  const notKnown = ranked.filter((r) => !PROFILE_WELL_KNOWN.has(r.name));
  const pool = notKnown.length ? notKnown : ranked;
  let pick = pool.find((r) => !recent.has(r.name.toLowerCase()))?.name;
  if (!pick) pick = pool[0]?.name; // 候选都被剖析过：这一轮允许重复，但不能空着
  if (!pick) return null;

  // 4) 组装
  const footRaw = (footprint.get(pick) || [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || urlKey(a.url).localeCompare(urlKey(b.url)));
  const todayList = todayHits.get(pick) || [];

  const tagCounts = {};
  const tagIdx = new Map();
  for (const n of footRaw) {
    const tag = inferTimelineTag(n);
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    tagIdx.set(n, { tag, idx: tagCounts[tag] });
  }

  // 时间线优先只放「它是主角」的报道（标题级），只有标题级不足 2 条时才退回全部提及
  const titleNodes = footRaw.filter((n) => n.titleHit);
  const useTitleOnly = titleNodes.length >= 2;
  const timeline = (useTitleOnly ? titleNodes : footRaw).slice(-12).map((n) => {
    const { tag, idx } = tagIdx.get(n) || { tag: inferTimelineTag(n), idx: 1 };
    const nth = tagCounts[tag] > 1 ? `归档里第 ${idx} 条「${tag}」类消息（共 ${tagCounts[tag]} 条）。` : '';
    return {
      date: n.date,
      tag,
      title: n.title,
      desc: clean(n.summary, 130),
      why: nth,
      kind: 'news',
      source: { name: n.source, url: n.url },
    };
  });

  const regionCounts = {};
  for (const n of footRaw) regionCounts[n.region] = (regionCounts[n.region] || 0) + 1;
  const mainRegion = Object.entries(regionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || todayList[0]?.region || 'OTHER';

  const topicCounts = {};
  for (const n of footRaw) for (const t of n.topics || []) {
    const name = topicName(t);
    if (name) topicCounts[name] = (topicCounts[name] || 0) + 1;
  }
  const topTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([t]) => t);

  const srcCount = new Set(footRaw.map((n) => n.source)).size;
  const span = footRaw.length
    ? footRaw[0].date === footRaw[footRaw.length - 1].date
      ? `${footRaw[0].date} 单日`
      : `${footRaw[0].date} → ${footRaw[footRaw.length - 1].date}`
    : '—';

  // 同期出现的公司：这些名字在同一批新闻里和它一起出现，能看出它站在谁的生态位里
  const co = {};
  for (const n of footRaw) {
    for (const e of n.entities || []) {
      if (e === pick) continue;
      co[e] = (co[e] || 0) + 1;
    }
  }
  const related = Object.entries(co)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name, n]) => ({ name, n }));

  const tagRanked = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topTag = tagRanked[0]?.[0] || '动态';
  const tagTxt = tagRanked.slice(0, 3).map(([t, n]) => `「${t}」${n}`).join('、');

  const CJK = /[\u4e00-\u9fff]/;
  return {
    id: `auto-${slugify(pick)}-${date}`,
    date,
    auto: true,
    name: pick,
    nameZh: CJK.test(pick) ? pick : '',
    aliases: [pick],
    tagline:
      `归档里共 ${footRaw.length} 条要闻提到它（${todayList.length} 条来自今天` +
      (titleNodes.length ? `，其中 ${titleNodes.length} 条它是标题主角` : '') +
      `），消息类型集中在 ${tagTxt}` +
      (topTopics.length ? `，板块以「${topTopics.join('、')}」为主` : '') +
      `。`,
    category: topTopics.length ? `${topTopics.join(' · ')} · 要闻聚合` : '要闻聚合',
    region: mainRegion,
    numbers: [
      { k: '归档提及', v: `${footRaw.length} 条` },
      ...(titleNodes.length ? [{ k: '标题主角', v: `${titleNodes.length} 条` }] : []),
      { k: '今日提及', v: `${todayList.length} 条` },
      { k: '活跃区间', v: span },
      { k: '来源家数', v: `${srcCount} 家` },
      { k: '主要区域', v: `${rflag(mainRegion)} ${rname(mainRegion)}` },
      { k: '消息类型', v: topTag },
    ],
    timelineNote: useTitleOnly
      ? '按时间正序读：这些都是「它是主角」的报道——一条一条点开，就是它在媒体视野里的轨迹。'
      : `按时间正序读：它出现在下面这些报道里（含只被顺带提及的），共 ${footRaw.length} 条，点标题可看原文。`,
    timeline,
    patternNote:
      `这一页由规则层自动聚合：只陈述「谁、什么时候、因为什么上了要闻」，不做主观判断，` +
      `金额、轮次、投资方等没有来源支撑的字段一律不填。选择标准是当天被提及最多、且不在大厂名单里的公司，` +
      `近 ${rotateDays} 天内剖析过的不重复选。`,
    related,
    terms: [],
  };
}

/** 写回剖析库：同一天已有手写剖析时不覆盖（人工内容优先） */
function saveDailyProfile(profile) {
  if (!profile) return null;
  const pf = readProfiles();
  const sameDay = (pf.list || []).find((p) => p.date === profile.date);
  if (sameDay && !sameDay.auto) return null;
  const list = (pf.list || []).filter((p) => p.date !== profile.date);
  list.unshift(profile);
  list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const out = {
    ...pf,
    schema: pf.schema || 'ai-horizon/profiles-v1',
    updatedAt: new Date().toISOString(),
    list: list.slice(0, 60),
  };
  fs.writeFileSync(profilesPath(), JSON.stringify(out, null, 1));
  return profile;
}

/** 仅根据已有归档重建全部每日总结（不重新抓取） */
function backfillDigests(regions) {
  fs.mkdirSync(path.join(DATA, 'digest'), { recursive: true });
  const files = readDated('archive');
  let n = 0;
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', f), 'utf8'));
    } catch {
      continue;
    }
    const stats = j.stats || {};
    const dk = j.date || f.replace('.json', '');
    setRefNow(archiveRef(j, dk)); // 按「当天抓取那一刻」看当天的新鲜度，而不是按今天看
    const d = buildDigest({
      date: dk,
      nowIso: j.generatedAt || new Date().toISOString(),
      curated: j.items || [],
      regions,
      stats: {
        total: stats.total ?? (j.items || []).length,
        sourceOk: stats.sourceOk ?? 0,
        sourceTotal: stats.sourceTotal ?? 0,
        freshness: stats.freshness,
      },
    });
    fs.writeFileSync(path.join(DATA, 'digest', `${d.date}.json`), JSON.stringify(d, null, 1));
    n += 1;
  }
  return n;
}

/* ---------------------------------- 主流程 -------------------------------- */

/**
 * 策展 + 落盘：去重 → 分类打分 → 区域配平（新鲜优先）→ 写 raw/归档/最新/每日总结。
 * 独立成函数，是为了让「用历史 raw 重跑同一条管线」成为可能（--rebuild-from-raw）。
 */
function curateDay({ items: rawItems, regions, sourceTotal, failures = [], staleDropped = [], staleBase = 0, date, nowIso, writeRaw = true, refTime }) {
  setRefNow(refTime);
  let items = rawItems;

  // 时效硬过滤：超过上限的旧文一律不放行。
  // 实时抓取时在抓取阶段已经筛过一遍，这里是给「用历史 raw 重跑」兜底，保证两条路径口径一致。
  const localStale = [];
  items = items.filter((it) => {
    const a = ageHours(it);
    if (a !== null && a > ageLimitFor(it)) {
      localStale.push({ source: it.source, region: it.region, ageDays: Math.round(a / 24), title: it.title });
      return false;
    }
    return true;
  });
  const allStale = [...staleDropped, ...localStale];

  // 去重：同 URL 保留信息更全的
  const byUrl = new Map();
  for (const it of items) {
    const key = it.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    const prev = byUrl.get(key);
    if (!prev || (it.summary || '').length > (prev.summary || '').length) byUrl.set(key, it);
  }
  items = [...byUrl.values()];

  // 标题高度相似也去重
  const normTitle = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 60);
  const byTitle = new Map();
  for (const it of items) {
    const k = `${it.region}|${normTitle(it.title)}`;
    if (!byTitle.has(k)) byTitle.set(k, it);
  }
  items = [...byTitle.values()];

  // 分类
  for (const it of items) Object.assign(it, classify(it));

  // 跨天去重：标出「今天第一次出现」与「前几天已经推过的」。
  // 已经推过的条目降权，保证首页优先是真正的新内容，而不是同一批文章连着刷几天。
  const seen = loadSeenIndex(date, SEEN_WINDOW_DAYS);
  for (const it of items) {
    const prior = firstSeenOf(it, seen);
    if (prior) {
      it.firstSeen = prior;
      it.isNew = false;
      it.importance = Math.max(20, it.importance - SEEN_PENALTY);
    } else {
      it.firstSeen = date;
      it.isNew = true;
    }
  }
  const newCount = items.filter((i) => i.isNew).length;

  const byImportance = (a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return (b.publishedAt || '').localeCompare(a.publishedAt || '');
  };
  items.sort(byImportance);

  const byRegion = {};
  for (const r of regions) byRegion[r.code] = items.filter((i) => i.region === r.code).length;

  // 时效概览：让每日总结和运行日志都能说清「今天有多新」
  const within = (h) => items.filter((i) => { const a = ageHours(i); return a !== null && a <= h; }).length;
  const freshness = {
    maxAgeHours: MAX_AGE_HOURS,
    freshHours: FRESH_HOURS,
    within24h: within(24),
    withinFresh: within(FRESH_HOURS),
    monthPrecision: items.filter((i) => i.datePrecision === 'month').length,
    undated: items.filter((i) => ageHours(i) === null && i.datePrecision !== 'month').length,
    staleDropped: staleBase + allStale.length,
    staleSources: [...new Set([
      ...failures.filter((f) => /超期/.test(f.error || '')).map((f) => f.name),
      ...Object.entries(allStale.reduce((acc, s) => { acc[s.source] = (acc[s.source] || 0) + 1; return acc; }, {}))
        .filter(([name, n]) => n >= 5 && !items.some((i) => i.source === name))
        .map(([name]) => name),
    ])],
  };

  const base = {
    schema: 'ai-horizon/v1',
    generatedAt: nowIso,
    date,
    enrichMode: 'rule',
    stats: {
      total: items.length,
      byRegion,
      sourceTotal,
      sourceOk: Math.max(0, sourceTotal - failures.length),
      freshness,
      // 跨天去重概览：前端据此说明「今天有多少条是新的」
      newCount,
      repeatCount: items.length - newCount,
      seenWindowDays: SEEN_WINDOW_DAYS,
      seenDays: seen.used,
      failures,
    },
  };

  /**
   * 区域配平策展 + 分层取新：
   * 先在该区域里把「24 小时内」的条目按重要度填满配额，不够再用「3 天内」补，
   * 再不够才用「更旧（但仍在时效上限内）」的补。
   * 这样即使是更新很慢的区域，也只有配额没填满时才会出现旧文，
   * 而不会拿旧文顶掉当天的新闻。
   */
  const recencyTier = (i) => {
    if (i.datePrecision === 'month') return 0; // 只知道"这个月"，按新处理
    const a = ageHours(i);
    if (a === null) return 0;
    if (a <= 24) return 0;
    if (a <= FRESH_HOURS) return 1;
    return 2;
  };
  const pickRegion = (r) => {
    const pool = items.filter((i) => i.region === r.code).sort(byImportance);
    if (FULL) return pool;
    const tiers = [[], [], []];
    for (const i of pool) tiers[recencyTier(i)].push(i);
    const out = [];
    for (const t of tiers) {
      if (out.length >= PER_REGION_CAP) break;
      out.push(...t.slice(0, PER_REGION_CAP - out.length));
    }
    return out;
  };

  const curated = FULL ? items : regions.flatMap(pickRegion).sort(byImportance);

  const fullPayload = { ...base, curated: false, items };
  const curatedPayload = {
    ...base,
    curated: !FULL,
    stats: {
      ...base.stats,
      published: curated.length,
      perRegionCap: PER_REGION_CAP,
      // 以「精选后的条目」为准，前端显示的才是读者实际能看到的数字
      newCount: curated.filter((i) => i.isNew).length,
      repeatCount: curated.filter((i) => !i.isNew).length,
    },
    items: curated,
  };

  fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'digest'), { recursive: true });
  if (writeRaw) fs.writeFileSync(path.join(DATA, 'raw', `${date}.json`), JSON.stringify(fullPayload, null, 1));
  fs.writeFileSync(path.join(DATA, 'archive', `${date}.json`), JSON.stringify(curatedPayload, null, 1));
  fs.writeFileSync(path.join(DATA, 'news-latest.json'), JSON.stringify(curatedPayload, null, 1));

  // 每日总结（规则层）：CI 每天自动产出，不依赖本机 / LLM
  const digest = buildDigest({ date, nowIso, curated, regions, stats: base.stats });
  fs.writeFileSync(path.join(DATA, 'digest', `${date}.json`), JSON.stringify(digest, null, 1));

  // 每日剖析（规则层）：同样由 CI 每天产出，公司每天自动轮换
  const profile = saveDailyProfile(buildDailyProfile({ date, curated, regions }));

  return { date, items, curated, freshness, byRegion, digest, profile };
}

/** 按归档重建每日剖析（升序处理，保证「近 N 天不重复」的轮换顺序正确） */
function backfillProfiles(regions, { latestOnly = false } = {}) {
  const files = readDated('archive').slice().reverse();
  const use = latestOnly ? files.slice(-1) : files;
  let n = 0;
  for (const f of use) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', f), 'utf8'));
    } catch {
      continue;
    }
    const d = j.date || f.replace('.json', '');
    setRefNow(archiveRef(j, d));
    const p = saveDailyProfile(buildDailyProfile({ date: d, curated: j.items || [], regions }));
    if (p) {
      n += 1;
      console.log(`  ${d}  剖析对象：${p.name}（${p.numbers?.[0]?.v || ''}）`);
    }
  }
  return n;
}

function todayKey(d = new Date()) {
  const tz = new Date(d.getTime() + 8 * 3600 * 1000);
  return tz.toISOString().slice(0, 10);
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const regions = cfg.regions;
  const regionMap = Object.fromEntries(regions.map((r) => [r.code, r]));

  // 仅重建「派生层」（总结 / 剖析 / 索引）：不抓取，全部从已有归档重算
  if (argv.includes('--digest-only')) {
    const n = backfillDigests(regions);
    const pn = backfillProfiles(regions);
    const ai = rebuildArchiveIndex();
    const di = rebuildDigestsIndex();
    const ci = buildCompaniesIndex();
    console.log(
      `\n✅ 已按现有归档重建 ${n} 天总结、${pn} 天剖析；归档 ${ai.length} 天 / 总结 ${di.length} 天 / ` +
      `公司足迹 ${ci.companies.length} 家\n`
    );
    return;
  }

  // 用历史 raw 重跑同一条策展管线（不重新抓取）：修数据、改口径时用
  if (argv.includes('--rebuild-from-raw')) {
    const rawDir = path.join(DATA, 'raw');
    const files = fs.existsSync(rawDir)
      ? fs.readdirSync(rawDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
      : [];
    console.log(`\n♻️  用 data/raw 重跑策展：共 ${files.length} 天\n`);
    for (const f of files) {
      let j;
      try {
        j = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
      } catch {
        continue;
      }
      const st = j.stats || {};
      const d = j.date || f.replace('.json', '');
      const r = curateDay({
        items: j.items || [],
        regions,
        sourceTotal: st.sourceTotal || 0,
        failures: st.failures || [],
        staleDropped: [],
        staleBase: st.freshness?.staleDropped || 0,
        date: d,
        nowIso: j.generatedAt || new Date().toISOString(),
        writeRaw: false,
        refTime: archiveRef(j, d),
      });
      console.log(
        `  ${f}  全量 ${String(r.items.length).padStart(3)} → 精选 ${String(r.curated.length).padStart(3)}` +
        `  · 24h 内 ${r.freshness.within24h}` +
        (r.freshness.staleDropped ? `  · ⊘ 弃旧文 ${r.freshness.staleDropped}` : '')
      );
    }
    const ai = rebuildArchiveIndex();
    const di = rebuildDigestsIndex();
    const ci = buildCompaniesIndex();
    console.log(
      `\n✅ 归档重建 ${ai.length} 天 / 总结 ${di.length} 天 / 公司足迹 ${ci.companies.length} 家\n`
    );
    return;
  }

  const sources = cfg.sources.filter(
    (s) => !ONLY_REGIONS.length || ONLY_REGIONS.includes(s.region)
  );

  console.log(`\n🛰  AI 瞭望台 · 开始抓取 ${sources.length} 个源 / ${new Set(sources.map(s=>s.region)).size} 个区域\n`);

  const failures = [];
  const staleDropped = []; // 因过期被丢弃的条目（用于统计与日志）
  const tasks = sources.map((src) => async () => {
    const t0 = Date.now();
    let kept = [];
    let dropped = 0;
    let newestAge = null;
    let err = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const xml = await fetchFeed(src.url, 1);
        const rows = parseFeed(xml);
        const mapped = rows
          .filter((r) => r.title && r.url)
          .slice(0, PER_SOURCE_LIMIT)
          .map((r) => {
            const feedDate = parseDate(r.dateStr);
            const inferred = feedDate ? null : inferDateFromUrl(r.url);
            const d = feedDate || inferred?.date;
            const base = {
              title: r.title,
              url: r.url,
              source: src.name,
              sourceId: src.id,
              sourceTier: src.tier,
              region: src.region,
              lang: src.lang,
              categories: r.categories.slice(0, 5),
              summary: r.summary,
              publishedAt: d ? d.toISOString() : null,
            };
            if (!feedDate && inferred) {
              base.dateInferred = true;
              base.datePrecision = inferred.precision; // 'day' | 'month'
            }
            base.id = crypto
              .createHash('sha1')
              .update(`${src.id}|${r.url}|${r.title}`)
              .digest('hex')
              .slice(0, 16);
            return base;
          });

        // 时效硬过滤：超过上限的旧文不进池子（否则源里积压的陈年文章会被当成今日要闻）
        kept = [];
        dropped = 0;
        for (const it of mapped) {
          const a = ageHours(it);
          if (a !== null && a > ageLimitFor(it)) {
            dropped += 1;
            staleDropped.push({ source: src.name, region: src.region, ageDays: Math.round(a / 24), title: it.title });
            continue;
          }
          if (a !== null && (newestAge === null || a < newestAge)) newestAge = a;
          kept.push(it);
        }
        if (kept.length) break;
        err = new Error(dropped ? `全部 ${dropped} 条超期` : '解析出 0 条');
      } catch (e) {
        err = e;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    const ms = Date.now() - t0;
    const ageTag = newestAge === null ? '  ——' : `${newestAge < 10 ? newestAge.toFixed(1) : Math.round(newestAge)}h`;
    console.log(
      `  ${String(kept.length).padStart(3)} 条  ${String(ms).padStart(6)}ms  ` +
      `[${src.region.padEnd(5)}] 最新${ageTag.padStart(6)}  ${src.name}` +
      (dropped ? `   ⊘ 弃${dropped}条旧文` : '') +
      (kept.length ? '' : `   ⚠ ${err?.message || '空'}`)
    );
    if (!kept.length) failures.push({ id: src.id, name: src.name, error: err?.message || '空' });
    return kept;
  });

  const batches = await pool(tasks, CONCURRENCY);

  const { date, items, curated, freshness, byRegion, profile } = curateDay({
    items: batches.flat(),
    regions,
    sourceTotal: sources.length,
    failures,
    staleDropped,
    date: todayKey(),
    nowIso: new Date().toISOString(),
    writeRaw: true,
  });

  // 重建两个索引（归档 + 每日总结）+ 公司足迹
  const archFiles = rebuildArchiveIndex().map((x) => `${x.date}.json`);
  const digestsIndex = rebuildDigestsIndex();
  const companies = buildCompaniesIndex();

  const newCount = curated.filter((i) => i.isNew).length;

  console.log(
    `\n✅ 完成：抓取 ${items.length} 条 → 策展发布 ${curated.length} 条 · ` +
    `${sources.length - failures.length}/${sources.length} 源正常` +
    `\n   分区：` + regions.map((r) => `${r.short} ${byRegion[r.code]}`).join(' / ')
  );
  console.log(
    `   跨天去重：新增 ${newCount} 条 · 延续 ${curated.length - newCount} 条（回看窗口 ${SEEN_WINDOW_DAYS} 天）`
  );
  console.log(
    `   时效：24h 内 ${freshness.within24h} 条 · ${freshness.freshHours}h 内 ${freshness.withinFresh} 条 · ` +
    `仅年月 ${freshness.monthPrecision} 条 · 无日期 ${freshness.undated} 条 · ` +
    `丢弃超 ${Math.round(freshness.maxAgeHours / 24)} 天旧文 ${freshness.staleDropped} 条`
  );
  if (freshness.staleSources.length) {
    console.log(`   ⚠ 疑似停更源（全部条目都超期）：` + freshness.staleSources.join('，'));
  }
  if (failures.length) {
    console.log(`   失败源：` + failures.filter((f) => !/超期/.test(f.error || '')).map((f) => `${f.name}(${f.error})`).join('，'));
  }
  if (profile) {
    console.log(`   每日剖析：${profile.name} · ${profile.category} · 时间线 ${profile.timeline.length} 个节点`);
  } else {
    console.log(`   每日剖析：今日无可选对象（候选都被大厂名单或近期轮换排除）`);
  }
  console.log(`   输出：data/news-latest.json + data/archive/${date}.json + data/digest/${date}.json`);
  console.log(`        + data/profiles.json + data/companies.json`);
  console.log(`   归档累计：${archFiles.length} 天（最新 ${archFiles[0] || '-'}）· 公司足迹 ${companies.companies.length} 家\n`);
}

main().catch((e) => {
  console.error('抓取失败：', e);
  process.exit(1);
});

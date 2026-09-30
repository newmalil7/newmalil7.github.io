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
  台积电: '台积电', samsung: '三星', 三星: '三星', xai: 'xAI', mistral: 'Mistral',
  cohere: 'Cohere', perplexity: 'Perplexity', 字节: '字节跳动', bytedance: '字节跳动',
  阿里: '阿里巴巴', 阿里巴巴: '阿里巴巴', 腾讯: '腾讯', 百度: '百度', 华为: '华为',
  小米: '小米', 商汤: '商汤', 月之暗面: '月之暗面', 智谱: '智谱AI', 科大讯飞: '科大讯飞',
  deepseek: 'DeepSeek', 深度求索: 'DeepSeek', qwen: '通义千问', softbank: '软银',
  软银: '软银', oracle: 'Oracle', salesforce: 'Salesforce', adobe: 'Adobe',
  sap: 'SAP', siemens: 'Siemens', asml: 'ASML', arm: 'Arm', qualcomm: '高通',
  broadcom: '博通', coreweave: 'CoreWeave', stargate: 'Stargate',
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

  const overview =
    `${Number(mm)} 月 ${Number(dd)} 日，共从 ${stats.sourceOk} 个信息源抓取 ${stats.total} 条 AI 产业动态，` +
    `其中 ${curated.length} 条进入当日精选，覆盖 ${regionPicks.length} 个区域。` +
    freshTxt +
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

  // 分类 + 排序
  for (const it of items) Object.assign(it, classify(it));

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
    stats: { ...base.stats, published: curated.length, perRegionCap: PER_REGION_CAP },
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

  return { date, items, curated, freshness, byRegion, digest };
}

function todayKey(d = new Date()) {
  const tz = new Date(d.getTime() + 8 * 3600 * 1000);
  return tz.toISOString().slice(0, 10);
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const regions = cfg.regions;
  const regionMap = Object.fromEntries(regions.map((r) => [r.code, r]));

  // 仅重建总结与索引（修复历史归档、不抓取）
  if (argv.includes('--digest-only')) {
    const n = backfillDigests(regions);
    const ai = rebuildArchiveIndex();
    const di = rebuildDigestsIndex();
    const ci = buildCompaniesIndex();
    console.log(
      `\n✅ 已按现有归档重建 ${n} 天总结；归档 ${ai.length} 天 / 总结 ${di.length} 天 / ` +
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

  const { date, items, curated, freshness, byRegion } = curateDay({
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

  console.log(
    `\n✅ 完成：抓取 ${items.length} 条 → 策展发布 ${curated.length} 条 · ` +
    `${sources.length - failures.length}/${sources.length} 源正常` +
    `\n   分区：` + regions.map((r) => `${r.short} ${byRegion[r.code]}`).join(' / ')
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
  console.log(`   输出：data/news-latest.json + data/archive/${date}.json + data/digest/${date}.json + data/companies.json`);
  console.log(`   归档累计：${archFiles.length} 天（最新 ${archFiles[0] || '-'}）· 公司足迹 ${companies.companies.length} 家\n`);
}

main().catch((e) => {
  console.error('抓取失败：', e);
  process.exit(1);
});

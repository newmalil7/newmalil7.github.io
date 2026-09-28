#!/usr/bin/env node
/**
 * AI 瞭望台 · 多区域要闻抓取器（零依赖）
 *
 * 用法:
 *   node scripts/fetch_news.mjs                 # 抓取全部区域
 *   node scripts/fetch_news.mjs --region CN,NA  # 仅抓指定区域
 *   node scripts/fetch_news.mjs --limit 40      # 每源最多取条数(默认 25)
 *
 * 输出:
 *   data/raw/<date>.json      原始归一化结果（供解读层消费）
 *   data/news-latest.json     规则版解读结果（让站点永远有可用内容）
 *   data/archive/<date>.json  按日归档
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

function countHits(haystack, words) {
  let n = 0;
  const matched = [];
  for (const w of words) {
    if (haystack.includes(w)) {
      n += 1;
      matched.push(w);
    }
  }
  return { n, matched };
}

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
  const entities = MAJOR_ENTITIES.filter((e) => hay.includes(e))
    .map((e) => {
      const map = {
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
      return map[e] || e;
    });
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
  const ageH = item.publishedAt
    ? (Date.now() - new Date(item.publishedAt).getTime()) / 36e5
    : 999;
  const freshBonus = ageH <= 8 ? 14 : ageH <= 16 ? 11 : ageH <= 24 ? 8 : ageH <= 48 ? 4 : 0;
  let importance =
    35 +
    Math.min(scored[0]?.hits || 0, 5) * 4 +
    Math.min(entityList.length, 3) * 6 +
    (item.sourceTier === 1 ? 9 : 0) +
    freshBonus +
    (difficulty === '入门' ? 3 : 0) +
    (topics.length === 0 ? -8 : 0);
  importance = Math.max(20, Math.min(99, Math.round(importance)));

  // 难度对应的白话提示
  const plainHint = scored[0]?.plain || '行业又有了新动向';

  return { topics, entities: entityList, difficulty, importance, plainHint };
}

/* ---------------------------------- 主流程 -------------------------------- */

function todayKey(d = new Date()) {
  const tz = new Date(d.getTime() + 8 * 3600 * 1000);
  return tz.toISOString().slice(0, 10);
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const regions = cfg.regions;
  const regionMap = Object.fromEntries(regions.map((r) => [r.code, r]));

  const sources = cfg.sources.filter(
    (s) => !ONLY_REGIONS.length || ONLY_REGIONS.includes(s.region)
  );

  console.log(`\n🛰  AI 瞭望台 · 开始抓取 ${sources.length} 个源 / ${new Set(sources.map(s=>s.region)).size} 个区域\n`);

  const failures = [];
  const tasks = sources.map((src) => async () => {
    const t0 = Date.now();
    let items = [];
    let err = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const xml = await fetchFeed(src.url, 1);
        const rows = parseFeed(xml);
        items = rows
          .filter((r) => r.title && r.url)
          .slice(0, PER_SOURCE_LIMIT)
          .map((r) => {
            const d = parseDate(r.dateStr);
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
            base.id = crypto
              .createHash('sha1')
              .update(`${src.id}|${r.url}|${r.title}`)
              .digest('hex')
              .slice(0, 16);
            return base;
          });
        if (items.length) break;
        err = new Error('解析出 0 条');
      } catch (e) {
        err = e;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    const ms = Date.now() - t0;
    console.log(
      `  ${String(items.length).padStart(3)} 条  ${String(ms).padStart(6)}ms  ` +
      `[${src.region.padEnd(5)}] ${src.name}` + (items.length ? '' : `   ⚠ ${err?.message || '空'}`)
    );
    if (!items.length) failures.push({ id: src.id, name: src.name, error: err?.message || '空' });
    return items;
  });

  const batches = await pool(tasks, CONCURRENCY);
  let items = batches.flat();

  // 去重：同 URL 保留信息更全的；标题高度相似也去重
  const byUrl = new Map();
  for (const it of items) {
    const key = it.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    const prev = byUrl.get(key);
    if (!prev || (it.summary || '').length > (prev.summary || '').length) byUrl.set(key, it);
  }
  items = [...byUrl.values()];

  const normTitle = (s) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 60);
  const byTitle = new Map();
  for (const it of items) {
    const k = `${it.region}|${normTitle(it.title)}`;
    if (!byTitle.has(k)) byTitle.set(k, it);
  }
  items = [...byTitle.values()];

  // 分类 + 排序
  for (const it of items) Object.assign(it, classify(it));
  items.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return (b.publishedAt || '').localeCompare(a.publishedAt || '');
  });

  const date = todayKey();
  const nowIso = new Date().toISOString();

  const byRegion = {};
  for (const r of regions) byRegion[r.code] = items.filter((i) => i.region === r.code).length;

  const base = {
    schema: 'ai-horizon/v1',
    generatedAt: nowIso,
    date,
    enrichMode: 'rule',
    stats: {
      total: items.length,
      byRegion,
      sourceTotal: sources.length,
      sourceOk: sources.length - failures.length,
      failures,
    },
  };

  // 区域配平策展：每个区域取重要度最高的 N 条，避免某区域刷屏
  const curated = FULL
    ? items
    : regions
        .flatMap((r) =>
          items.filter((i) => i.region === r.code).slice(0, PER_REGION_CAP)
        )
        .sort((a, b) => {
          if (b.importance !== a.importance) return b.importance - a.importance;
          return (b.publishedAt || '').localeCompare(a.publishedAt || '');
        });

  const fullPayload = { ...base, curated: false, items };
  const curatedPayload = {
    ...base,
    curated: !FULL,
    stats: { ...base.stats, published: curated.length, perRegionCap: PER_REGION_CAP },
    items: curated,
  };

  fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'raw', `${date}.json`), JSON.stringify(fullPayload, null, 1));
  fs.writeFileSync(path.join(DATA, 'archive', `${date}.json`), JSON.stringify(curatedPayload, null, 1));
  fs.writeFileSync(path.join(DATA, 'news-latest.json'), JSON.stringify(curatedPayload, null, 1));

  // 归档索引
  const files = fs
    .readdirSync(path.join(DATA, 'archive'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  const index = files.map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, 'archive', f), 'utf8'));
      return { date: f.replace('.json', ''), total: j.stats?.total || 0 };
    } catch {
      return { date: f.replace('.json', ''), total: 0 };
    }
  });
  fs.writeFileSync(path.join(DATA, 'archive-index.json'), JSON.stringify(index, null, 1));

  console.log(
    `\n✅ 完成：抓取 ${items.length} 条 → 策展发布 ${curated.length} 条 · ` +
    `${sources.length - failures.length}/${sources.length} 源正常` +
    `\n   分区：` + regions.map((r) => `${r.short} ${byRegion[r.code]}`).join(' / ')
  );
  if (failures.length) {
    console.log(`   失败源：` + failures.map((f) => `${f.name}(${f.error})`).join('，'));
  }
  console.log(`   输出：data/news-latest.json + data/archive/${date}.json\n`);
}

main().catch((e) => {
  console.error('抓取失败：', e);
  process.exit(1);
});

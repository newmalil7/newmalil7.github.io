/* ==========================================================================
   AI 瞭望台 · 应用逻辑
   零依赖 · 原生 ES 模块
   ========================================================================== */

const REGION_META = {
  CN:    { name: '中国国内', short: '中国',   flag: '🇨🇳', color: '#ef4444' },
  SEA:   { name: '东南亚',   short: '东南亚', flag: '🌏', color: '#14b8a6' },
  ME:    { name: '中东',     short: '中东',   flag: '🕌', color: '#f59e0b' },
  JPKR:  { name: '日韩',     short: '日韩',   flag: '🗾', color: '#ec4899' },
  EU:    { name: '欧洲',     short: '欧洲',   flag: '🇪🇺', color: '#3b82f6' },
  NA:    { name: '北美',     short: '北美',   flag: '🌎', color: '#8b5cf6' },
  OTHER: { name: '其他地区', short: '其他',   flag: '🌐', color: '#64748b' },
};

const TOPIC_COLOR = {
  '模型与能力': '#6d5efc',
  '算力与基建': '#0ea5e9',
  '资本与市场': '#f59e0b',
  '产品与应用': '#10b981',
  '政策与治理': '#ef4444',
  '产业与生态': '#8b5cf6',
};

const DIFF_COLOR = { '入门': '#10b981', '进阶': '#f59e0b', '高级': '#ef4444' };

const LS = {
  bm: 'aih.bookmarks.v1',
  read: 'aih.read.v1',
  prog: 'aih.progress.v1',
  theme: 'aih.theme',
  pref: 'aih.pref.v1',
  channels: 'aih.biz.channels.v1',
  customers: 'aih.biz.customers.v1',
  sync: 'aih.biz.sync.v1',
};

const REFRESH_HOUR = 9; // 每日 09:00 自动刷新

/* ------------------------------- 工具函数 -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function loadLS(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

/** 北京时间（UTC+8）日期键 */
function bjNow() {
  return new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 8 * 3600000);
}
function bjDateKey(d = new Date()) {
  const x = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function relTime(iso) {
  if (!iso) return '时间未知';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
function absTime(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + new Date().getTimezoneOffset() * 60000 + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg, ms = 2000) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), ms);
}

/* --------------------------------- 状态 --------------------------------- */

const S = {
  data: null, briefing: {}, curriculum: null, glossary: null, sources: null, archive: [],
  profiles: null, weekly: null, models: null,
  channels: loadLS(LS.channels, null),
  customers: loadLS(LS.customers, []),
  sync: loadLS(LS.sync, { token: '', gistId: '', lastSync: '' }),
  tab: 'feed',
  bizTab: 'primer', bizSort: 'price', bizTier: 'ALL',
  bizEditCh: null, bizEditCu: null, _quote: null,
  calc: { in: 2, out: 8, margin: 30, vin: 100, vout: 100 },
  region: 'ALL',
  topics: new Set(),
  diff: 'ALL',
  q: '',
  sort: 'importance',
  compact: false,
  expandedRegions: new Set(),
  expandedCards: new Set(),
  archDate: null,
  archData: null,
  weekIssue: 0,
  profileSel: null,
  openThread: null,
  bookmarks: loadLS(LS.bm, []),
  read: new Set(loadLS(LS.read, [])),
  progress: loadLS(LS.prog, {}),
  nextRefreshAt: null,
  lastRender: 0,
};

saveLS(LS.pref, {});
const pref = loadLS(LS.pref, {});
if (pref.tab) S.tab = pref.tab;
if (pref.region) S.region = pref.region;

/* ------------------------------ 数据载入 --------------------------------- */

async function getJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[aih] 载入失败', url, e.message);
    return null;
  }
}

async function loadAll() {
  const [data, briefing, curriculum, glossary, sources, archive, profiles, weekly, models] = await Promise.all([
    getJSON('./data/news-latest.json'),
    getJSON('./data/briefing.json'),
    getJSON('./data/curriculum.json'),
    getJSON('./data/glossary.json'),
    getJSON('./data/sources.json'),
    getJSON('./data/archive-index.json'),
    getJSON('./data/profiles.json'),
    getJSON('./data/weekly.json'),
    getJSON('./data/models.json'),
  ]);
  S.data = data;
  S.briefing = briefing?.items || {};
  S.curriculum = curriculum;
  S.glossary = glossary;
  S.sources = sources;
  S.archive = archive || [];
  S.profiles = profiles;
  S.weekly = weekly;
  S.models = models;
  computeNextRefresh();
}

function computeNextRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(REFRESH_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  S.nextRefreshAt = next;
}

/* ------------------------------ 学习进度 -------------------------------- */

function currentWeekIndex() {
  if (!S.curriculum?.startDate) return 1;
  const start = new Date(`${S.curriculum.startDate}T00:00:00+08:00`);
  const days = Math.floor((Date.now() - start.getTime()) / 86400000);
  return Math.max(1, Math.min(24, Math.floor(days / 7) + 1));
}

function cyclesWithWeeks() {
  const c = S.curriculum;
  if (!c) return [];
  let w = 0;
  return c.cycles.map((cy) => {
    let local = 0;
    const months = cy.months.map((m) => ({
      ...m,
      weeks: m.weeks.map((wk) => {
        w += 1; local += 1;
        return { ...wk, globalWeek: w, localWeek: local };
      }),
    }));
    return { ...cy, months };
  });
}

function weekKey(cyId, m, wk) { return `${cyId}-m${m}-w${wk}`; }

function phaseProgress() {
  const cycles = cyclesWithWeeks();
  const cur = currentWeekIndex();
  const all = [];
  cycles.forEach((cy) => cy.months.forEach((m) => m.weeks.forEach((w) => all.push(w.globalWeek))));
  const doneCount = cycles.reduce(
    (n, cy) => n + cy.months.reduce((k, m) => k + m.weeks.filter((w) => S.progress[weekKey(cy.id, m.m, w.w)]).length, 0),
    0
  );
  return {
    cycles, cur, total: all.length, doneCount,
    pct: Math.round((doneCount / Math.max(all.length, 1)) * 100),
  };
}

/* ------------------------------ 今日要闻过滤 ----------------------------- */

function itemsForToday() {
  if (!S.data?.items) return [];
  return S.data.items.map((it) => {
    const b = S.briefing[it.id] || {};
    return { ...it, ...b, _hasBrief: !!b.plain };
  });
}

function filtered(items) {
  const q = S.q.trim().toLowerCase();
  return items.filter((it) => {
    if (S.region !== 'ALL' && it.region !== S.region) return false;
    if (S.diff !== 'ALL' && it.difficulty !== S.diff) return false;
    if (S.topics.size && !it.topics.some((t) => S.topics.has(t.name))) return false;
    if (q) {
      const hay = `${it.title} ${it.titleZh || ''} ${it.plain || ''} ${it.why || ''} ${it.summary || ''} ${it.source} ${(it.entities || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sorted(items) {
  const arr = [...items];
  if (S.sort === 'time') {
    arr.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  } else if (S.sort === 'difficulty') {
    const order = { 入门: 0, 进阶: 1, 高级: 2 };
    arr.sort((a, b) => (order[a.difficulty] ?? 9) - (order[b.difficulty] ?? 9) || b.importance - a.importance);
  } else {
    arr.sort((a, b) => b.importance - a.importance || (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  }
  return arr;
}

/* -------------------------------- 渲染：头部 ----------------------------- */

function renderTopbar() {
  const d = S.data;
  const stale = d && d.date !== bjDateKey();
  return `
  <header class="topbar">
    <div class="topbar-in">
      <div class="brand">
        <div class="brand-mark">AI</div>
        <div class="brand-txt">
          <strong>AI 瞭望台</strong>
          <span>每日 9 点自动刷新 · 7 大区域 · 6 个月成长地图</span>
        </div>
      </div>
      <div class="refresh-pill" id="refreshPill" title="每日早晨 9:00 自动刷新">
        <span class="dot ${stale ? 'stale' : ''}"></span>
        <span class="hide-sm">下次刷新</span>
        <b id="countdown">--:--:--</b>
        <span class="hide-sm" style="color:var(--muted)">9:00</span>
      </div>
      <button class="icon-btn" id="btnRefresh" title="立即刷新">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
        </svg>
      </button>
      <button class="icon-btn" id="btnTheme" title="切换深/浅色">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
        </svg>
      </button>
    </div>
  </header>`;
}

function renderHero() {
  const d = S.data;
  const pp = phaseProgress();
  const cy = pp.cycles.find((c) => pp.cur >= c.months[0].weeks[0].globalWeek + 0 &&
    pp.cur <= c.months[c.months.length - 1].weeks[c.months[c.months.length - 1].weeks.length - 1].globalWeek);
  const regionCount = new Set((d?.items || []).map((i) => i.region)).size;

  const segs = pp.cycles.map((c) => {
    const ws = c.months.flatMap((m) => m.weeks);
    const lo = ws[0].globalWeek, hi = ws[ws.length - 1].globalWeek;
    const total = ws.length;
    const done = ws.filter((w) => S.progress[weekKey(c.id, c.months.find((m) => m.weeks.includes(w)).m, w.w)]).length;
    const state = pp.cur > hi ? 'done' : pp.cur >= lo ? 'active' : '';
    const pct = Math.round((done / total) * 100);
    return `
      <div class="track-seg ${state}">
        <span class="seg-pct">${pct}%</span>
        <div class="seg-name">${c.name}${state === 'active' ? ' · 进行中' : state === 'done' ? ' · 已完成' : ''}</div>
        <div class="seg-sub">第 ${lo}-${hi} 周 · ${c.subtitle}</div>
        <div class="seg-fill"><i style="width:${pct}%"></i></div>
      </div>`;
  }).join('');

  const remainDays = Math.max(0, 168 - Math.round((Date.now() - new Date(`${S.curriculum?.startDate || '2026-09-28'}T00:00:00+08:00`).getTime()) / 86400000));

  return `
  <section class="hero">
    <h1>看懂 AI 行业，从<em>每天 15 分钟</em>开始</h1>
    <p>自动聚合中国、东南亚、中东、日韩、欧洲、北美等 7 大区域的 AI 要闻，每条都配白话解读与产业视角。每天剖析一家产业内的公司或项目，每周五 9:00 生成一份本周预览。并按 <strong>入门 → 进阶 → 高级</strong> 的 6 个月地图、按<strong>中国工作日</strong>节奏推进（周末不排任务，周一集中回看）。看不懂的术语点一下就有解释。</p>
    <div class="stats">
      <div class="stat"><b>${d?.items?.length ?? 0}</b><span>今日要闻</span></div>
      <div class="stat"><b>${regionCount}</b><span>覆盖区域</span></div>
      <div class="stat"><b>${d?.stats?.sourceOk ?? 0}/${d?.stats?.sourceTotal ?? 0}</b><span>信息源在线</span></div>
      <div class="stat"><b>${S.profiles?.list?.length ?? 0}</b><span>已剖析公司</span></div>
      <div class="stat"><b>${S.weekly?.issues?.length ?? 0}</b><span>周报期数</span></div>
      <div class="stat"><b>${S.bookmarks.length}</b><span>已收藏</span></div>
      <div class="stat"><b>${S.read.size}</b><span>已读</span></div>
    </div>
    <div class="phase-bar">
      <div class="phase-bar-head">
        <h3>学习进度</h3>
        <span class="tag-now">当前：${cy?.name || '入门'}阶段 · 第 ${pp.cur} 周</span>
        <span class="spacer"></span>
        <span class="eta">剩余 ${remainDays} 天 · 已完成 ${pp.doneCount}/${pp.total} 周（${pp.pct}%）</span>
      </div>
      <div class="track">${segs}</div>
    </div>
  </section>`;
}

/* -------------------------------- 渲染：标签页 --------------------------- */

function renderTabs() {
  const items = itemsForToday();
  const profiles = S.profiles?.list?.length || 0;
  const weeks = S.weekly?.issues?.length || 0;
  const tabs = [
    { id: 'feed', label: '📰 今日要闻', n: items.length },
    { id: 'profile', label: '🔬 每日剖析', n: profiles },
    { id: 'weekly', label: '📅 本周预览', n: weeks },
    { id: 'map', label: '🗺️ 学习地图' },
    { id: 'bm', label: '⭐ 收藏夹', n: S.bookmarks.length },
    { id: 'gl', label: '📖 术语词典', n: S.glossary ? S.glossary.categories.reduce((a, c) => a + c.terms.length, 0) : 0 },
    { id: 'arch', label: '🗂️ 归档' },
    { id: 'biz', label: '💱 中转台' },
  ];
  return `<nav class="tabs">${tabs.map((t) => `
    <button class="tab ${S.tab === t.id ? 'on' : ''}" data-act="tab" data-tab="${t.id}">
      ${t.label}${t.n ? `<span class="cnt">${t.n}</span>` : ''}
    </button>`).join('')}</nav>`;
}

/* -------------------------------- 渲染：卡片 ----------------------------- */

function cardHTML(it, idx) {
  const rm = REGION_META[it.region] || { short: it.region, color: '#64748b' };
  const isBm = S.bookmarks.some((b) => b.id === it.id);
  const isRead = S.read.has(it.id);
  const expanded = S.expandedCards.has(it.id);
  const compact = S.compact && !expanded;

  const topics = (it.topics || []).map((t) =>
    `<span class="tg" style="--tc:${TOPIC_COLOR[t.name] || '#6b7280'}">${esc(t.name)}</span>`
  ).join('');

  const dif = it.difficulty
    ? `<span class="tg diff" style="--tc:${DIFF_COLOR[it.difficulty] || '#6b7280'}">${esc(it.difficulty)}</span>` : '';

  const ents = (it.entities || []).slice(0, 3)
    .map((e) => `<span class="tg ent">${esc(e)}</span>`).join('');

  const gls = (it.glossary || []).slice(0, 4).map((g) => {
    const term = findTerm(g);
    return term ? `<span class="tg gl" data-act="glossary" data-term="${esc(g)}" title="${esc(term.def)}"># ${esc(term.term.split(' / ')[0])}</span>` : '';
  }).join('');

  const zhTitle = it.titleZh && it.titleZh !== it.title
    ? `<div class="zh-title">▸ ${esc(it.titleZh)}</div>` : '';

  const plain = it.plain
    ? `<div class="plain"><span class="lb">白话解读</span>${esc(it.plain)}</div>` : '';
  const why = it.why
    ? `<div class="why"><span class="lb">为什么重要</span>${esc(it.why)}</div>` : '';

  const showSummary = !compact && it.summary;

  return `
  <article class="card ${isRead ? 'read' : ''}" style="--rc:${rm.color}" data-id="${it.id}">
    <div class="card-top">
      <span class="rbadge">${rm.flag || ''} ${esc(rm.name || rm.short)}</span>
      <span class="src">${esc(it.source)}</span>
      <span class="dotsep">·</span>
      <span class="meta" title="${esc(absTime(it.publishedAt))}">${esc(relTime(it.publishedAt))}</span>
      <div class="acts">
        <button class="mini ${isBm ? 'on' : ''}" data-act="bm" data-id="${it.id}" title="${isBm ? '取消收藏' : '收藏'}">${isBm ? '★' : '☆'}</button>
        <button class="mini ${isRead ? 'read-on' : ''}" data-act="read" data-id="${it.id}" title="${isRead ? '标记未读' : '标记已读'}">✓</button>
      </div>
    </div>
    <h3><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
    ${zhTitle}
    ${plain}
    ${why}
    ${showSummary ? `<p class="summary">${esc(it.summary)}</p>` : ''}
    ${compact ? '' : `<div class="tags">${topics}${dif}${ents}${gls}
      <span class="imp">重要度 ${it.importance}<i><b style="width:${it.importance}%"></b></i></span>
    </div>`}
    ${compact ? `<button class="more" data-act="expand" data-id="${it.id}">展开解读与标签 ▾</button>` : `<a class="more" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">阅读原文 ↗</a>`}
  </article>`;
}

function findTerm(id) {
  if (!S.glossary) return null;
  for (const c of S.glossary.categories) {
    const t = c.terms.find((x) => x.id === id);
    if (t) return { ...t, cat: c.name, color: c.color };
  }
  return null;
}

/* ---------------------------- 今日要闻顶部的入口条 ------------------------- */

function renderFeatureStrip() {
  const p = S.profiles?.list?.[0];
  const w = S.weekly?.issues?.[0];
  const isFriday = new Date(Date.now() + 8 * 3600000 + new Date().getTimezoneOffset() * 60000).getDay() === 5;

  const profileCard = p ? `
    <button class="fstrip-item" data-act="tab" data-tab="profile" style="--acc:#6d5efc">
      <span class="fs-tag">🔬 今日剖析</span>
      <b>${esc(p.name)}</b>
      <em>${esc(p.tagline || '')}</em>
      <span class="fs-meta">${REGION_META[p.region]?.flag || ''} ${esc(REGION_META[p.region]?.short || '')}${p.stage ? ' · ' + esc(p.stage) : ''}</span>
    </button>` : '';

  const weeklyCard = w ? `
    <button class="fstrip-item ${isFriday ? 'hot' : ''}" data-act="tab" data-tab="weekly" style="--acc:#0ea5e9">
      <span class="fs-tag">📅 本周预览${w.status === '试刊' ? ' · 试刊' : ''}</span>
      <b>${esc(w.headline)}</b>
      <em>${esc(w.weekLabel)} · ${esc(w.dateRange)}</em>
      <span class="fs-meta">${isFriday ? '今天 9:00 已更新，建议先读它' : '每周五 9:00 生成'}</span>
    </button>` : `
    <div class="fstrip-item dim" style="--acc:#0ea5e9">
      <span class="fs-tag">📅 本周预览</span>
      <b>每周五 09:00 自动生成</b>
      <em>覆盖本周全部要闻，给出主线判断与下周看点</em>
    </div>`;

  if (!profileCard && !weeklyCard) return '';
  return `<div class="fstrip">${profileCard}${weeklyCard}</div>`;
}

/* ------------------------------ 渲染：今日要闻 --------------------------- */

function renderFeed() {
  const all = itemsForToday();
  if (!all.length) {
    return `<div class="empty"><div class="em">📡</div><p>暂时没有抓取到数据。</p>
      <p style="font-size:12.5px">请确认已运行抓取脚本，或点击右上角刷新按钮。</p></div>`;
  }
  const list = sorted(filtered(all));

  const regions = (S.sources?.regions || Object.keys(REGION_META).map((k) => ({ code: k, ...REGION_META[k] })))
    .slice().sort((a, b) => (a.order || 99) - (b.order || 99));

  const regionChips = [{ code: 'ALL', short: '全部区域', flag: '🌍' }, ...regions].map((r) => {
    const n = r.code === 'ALL' ? all.length : all.filter((i) => i.region === r.code).length;
    return `<button class="chip ${S.region === r.code ? 'on' : ''}" data-act="region" data-v="${r.code}">
      ${r.flag || ''} ${esc(r.name || r.short)} <span class="n">${n}</span></button>`;
  }).join('');

  const topicCounts = {};
  all.forEach((i) => (i.topics || []).forEach((t) => { topicCounts[t.name] = (topicCounts[t.name] || 0) + 1; }));
  const topicChips = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([name, n]) =>
    `<button class="chip ${S.topics.has(name) ? 'on' : ''}" data-act="topic" data-v="${esc(name)}">
      <span style="width:7px;height:7px;border-radius:2px;background:${TOPIC_COLOR[name] || '#888'};display:inline-block"></span>
      ${esc(name)} <span class="n">${n}</span></button>`
  ).join('');

  const diffs = ['ALL', '入门', '进阶', '高级'].map((d) =>
    `<button class="chip ${S.diff === d ? 'on' : ''}" data-act="diff" data-v="${d}">${d === 'ALL' ? '全部难度' : d}</button>`
  ).join('');

  const filters = `
  <div class="filters">
    <div class="frow"><span class="flabel">区域</span>${regionChips}</div>
    <div class="frow"><span class="flabel">主题</span>${topicChips || '<span class="meta">暂无</span>'}</div>
    <div class="frow">
      <span class="flabel">难度</span>${diffs}
      <select class="sel" data-act="sort">
        <option value="importance" ${S.sort === 'importance' ? 'selected' : ''}>按重要度</option>
        <option value="time" ${S.sort === 'time' ? 'selected' : ''}>按时间</option>
        <option value="difficulty" ${S.sort === 'difficulty' ? 'selected' : ''}>按难度递增</option>
      </select>
      <button class="btn" data-act="toggleview">${S.compact ? '详细视图' : '精简视图'}</button>
      <input class="search" data-act="search" placeholder="搜索标题 / 公司 / 关键词…" value="${esc(S.q)}" />
    </div>
  </div>`;

  if (!list.length) {
    return filters + `<div class="empty"><div class="em">🔍</div><p>没有符合当前筛选条件的要闻。</p>
      <p><button class="btn" data-act="reset">重置筛选</button></p></div>`;
  }

  const strip = renderFeatureStrip();

  // 全部区域 + 未做主题/搜索筛选时：先给"今日必读"，再按区域分组
  const grouped = S.region === 'ALL' && !S.topics.size && !S.q.trim();

  let body;
  if (grouped) {
    const brief = list.filter((i) => i._hasBrief).slice(0, 6);
    const briefSection = brief.length ? `
      <div class="sect-head"><h3>🔥 今日必读</h3><span class="n">编辑精选 · 跨区域</span><span class="line"></span></div>
      <div class="feed">${brief.map(cardHTML).join('')}</div>` : '';

    const restSection = regions.map((r) => {
      const ris = list.filter((i) => i.region === r.code);
      if (!ris.length) return '';
      const ex = S.expandedRegions.has(r.code);
      const show = ex ? ris : ris.slice(0, 6);
      const color = REGION_META[r.code]?.color || '#64748b';
      return `
        <div class="sect-head">
          <h3 style="color:${color}">${r.flag || ''} ${esc(r.name || r.short)}</h3>
          <span class="n">${ris.length} 条</span><span class="line"></span>
          ${ris.length > 6 ? `<button class="btn" data-act="regionmore" data-v="${r.code}">${ex ? '收起' : `展开全部 ${ris.length} 条`}</button>` : ''}
        </div>
        <div class="feed">${show.map(cardHTML).join('')}</div>`;
    }).join('');

    body = strip + briefSection + restSection;
  } else {
    body = strip + `<div class="sect-head"><h3>筛选结果</h3><span class="n">${list.length} 条</span><span class="line"></span></div>
      <div class="feed">${list.map(cardHTML).join('')}</div>`;
  }

  return filters + body;
}

/* ------------------------------ 渲染：每日剖析 --------------------------- */

function itemById(id) {
  const all = [...itemsForToday(), ...(S.archData?.items || [])];
  return all.find((i) => i.id === id) || null;
}

function renderProfile() {
  const p = S.profiles;
  if (!p?.list?.length) {
    return `<div class="empty"><div class="em">🔬</div><p>还没有公司剖析。</p>
      <p style="font-size:12.5px">每日 9:00 会自动新增一家产业内的公司或项目，优先选被知名企业扶植投资的初创公司。</p></div>`;
  }

  const list = [...p.list].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const c = list.find((x) => x.id === S.profileSel) || list[0];
  const past = list.filter((x) => x.id !== c.id);
  const rm = REGION_META[c.region] || {};

  const numCards = (c.numbers || []).map((n) =>
    `<div class="pnum"><span>${esc(n.k)}</span><b>${esc(n.v)}</b></div>`).join('');

  const listBlock = (title, arr, cls) => (arr?.length
    ? `<div class="pblock ${cls}"><h5>${esc(title)}</h5><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    : '');

  const terms = (c.terms || []).map((t) => {
    const term = findTerm(t);
    return term ? `<span class="tg gl" data-act="glossary" data-term="${esc(t)}" title="${esc(term.def)}"># ${esc(term.term.split(' / ')[0])}</span>` : '';
  }).join('');

  const questions = (c.questions || []).length
    ? `<div class="pblock pq"><h5>读完问自己</h5><ol>${c.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>`
    : '';

  const investors = (c.investors || []).map((i) => `<span class="inv">${esc(i)}</span>`).join('');

  const watch = p.watchlist?.items?.length ? `
    <div class="sect-head" style="margin-top:28px">
      <h3>👀 ${esc(p.watchlist.title || '今日要闻里的其他初创公司')}</h3><span class="line"></span></div>
    <p class="meta" style="margin:-4px 0 12px">${esc(p.watchlist.note || '')}</p>
    <div class="watch-grid">${p.watchlist.items.map((w) => `
      <a class="watch-item" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">
        <div class="wi-top"><b>${esc(w.name)}</b>
          <span class="rbadge" style="--rc:${REGION_META[w.region]?.color || '#64748b'}">${REGION_META[w.region]?.flag || ''} ${esc(REGION_META[w.region]?.short || w.region)}</span>
        </div>
        <p class="wi-line">${esc(w.oneLiner)}</p>
        <p class="wi-why">${esc(w.why)}</p>
      </a>`).join('')}</div>` : '';

  const pastBlock = past.length ? `
    <div class="sect-head" style="margin-top:28px"><h3>🗓 往期剖析</h3><span class="n">${past.length} 期</span><span class="line"></span></div>
    <div class="past-grid">${past.map((x) => `
      <button class="past-item" data-act="profile" data-v="${esc(x.id)}">
        <span class="pd">${esc(x.date)}</span>
        <b>${esc(x.name)}</b>
        <em>${esc(x.tagline || x.category || '')}</em>
      </button>`).join('')}</div>` : `
    <div class="sect-head" style="margin-top:28px"><h3>🗓 往期剖析</h3><span class="line"></span></div>
    <p class="meta">这是第 1 期。每天 9:00 会新增一家，逐步积累成你自己的产业公司库。</p>`;

  return `
  <div class="profile">
    <div class="p-head" style="--rc:${rm.color || '#64748b'}">
      <div class="p-head-main">
        <div class="p-eyebrow">
          <span class="rbadge">${rm.flag || ''} ${esc(rm.name || c.region || '')}</span>
          ${c.category ? `<span class="pcat">${esc(c.category)}</span>` : ''}
          <span class="pdate">${esc(c.date)} · 第 ${list.length - list.indexOf(c)} 期${list.indexOf(c) > 0 ? '（往期）' : ''}</span>
        </div>
        <h2>${esc(c.name)}</h2>
        ${c.nameZh && c.nameZh !== c.name ? `<div class="p-zh">${esc(c.nameZh)}</div>` : ''}
        <p class="p-tagline">${esc(c.tagline || '')}</p>
        <div class="p-investors">${investors}</div>
      </div>
      <div class="p-facts">
        ${c.country ? `<div><span>所在地</span><b>${esc(c.country)}${c.city ? ' · ' + esc(c.city) : ''}</b></div>` : ''}
        ${c.founded ? `<div><span>成立</span><b>${esc(c.founded)}</b></div>` : ''}
        ${c.stage ? `<div><span>最新轮次</span><b>${esc(c.stage)}</b></div>` : ''}
        ${c.amount ? `<div><span>规模</span><b>${esc(c.amount)}</b></div>` : ''}
      </div>
    </div>

    ${numCards ? `<div class="pnums">${numCards}</div>` : ''}

    <div class="p-body">
      <div class="pblock"><h5>它做什么</h5><p>${esc(c.whatTheyDo)}</p></div>
      <div class="pblock hi"><h5>为什么特别</h5><p>${esc(c.whySpecial)}</p></div>
      <div class="pblock"><h5>靠什么赚钱</h5><p>${esc(c.businessModel)}</p></div>
      ${c.backerNote ? `<div class="pblock inv-note"><h5>投资方组合说明了什么</h5><p>${esc(c.backerNote)}</p></div>` : ''}
      ${listBlock('护城河在哪', c.moat, 'good')}
      ${listBlock('风险点', c.risks, 'bad')}
      ${listBlock('接下来盯什么', c.watch, 'watch2')}
      ${questions}
      ${terms ? `<div class="p-terms"><span class="pt-label">相关术语</span>${terms}</div>` : ''}
      ${c.source ? `<div class="p-src">信息来源：<a href="${esc(c.source.url)}" target="_blank" rel="noopener noreferrer">${esc(c.source.name)} · ${esc(c.source.title)}</a></div>` : ''}
    </div>
  </div>
  ${watch}
  ${pastBlock}`;
}

/* ------------------------------ 渲染：本周预览 --------------------------- */

function renderWeekly() {
  const w = S.weekly;
  const issues = w?.issues || [];
  if (!issues.length) {
    return `<div class="empty"><div class="em">📅</div><p>本周预览还没生成。</p>
      <p style="font-size:12.5px">每周五 09:00 自动生成，覆盖本周一至周五的全部要闻，给出主线判断和下周看点。</p></div>`;
  }

  const idx = Math.max(0, Math.min(S.weekIssue, issues.length - 1));
  const c = issues[idx];
  const prev = issues.slice(idx + 1);

  const statusBadge = c.status === '试刊'
    ? '<span class="badge warn-badge">试刊 · 本周进行中</span>'
    : '<span class="badge now">正式版</span>';

  const threads = (c.threads || []).map((t, i) => {
    const ev = (t.evidence || []).map((e) => {
      const it = e.id ? itemById(e.id) : null;
      const url = it?.url || e.url || '';
      const label = it?.title || e.title;
      const src = e.source || it?.source || '';
      return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label)}<span class="ev-src">${esc(src)}</span></li>`;
    }).join('');
    return `
    <div class="thread">
      <div class="thread-head">
        <span class="tno">${i + 1}</span>
        <h4>${esc(String(t.title).replace(/^主线[一二三四五六七八九十]+ ·\s*/, ''))}</h4>
        ${t.title.match(/^主线/) ? `<span class="tflag">${esc(t.title.split(' · ')[0])}</span>` : ''}
      </div>
      <p class="thread-detail">${esc(t.detail)}</p>
      ${ev ? `<div class="ev"><span class="ev-label">本期依据</span><ul>${ev}</ul></div>` : ''}
    </div>`;
  }).join('');

  const regions = (c.regions || []).map((r) => {
    const rm = REGION_META[r.code] || {};
    return `<div class="wregion" style="--rc:${rm.color || '#64748b'}">
      <div class="wr-head"><span class="rbadge">${rm.flag || ''} ${esc(rm.name || r.code)}</span>
        ${r.count ? `<span class="meta">${r.count} 条</span>` : ''}</div>
      <p>${esc(r.note)}</p>
    </div>`;
  }).join('');

  const topics = (c.numbers?.topTopics || []).map((t) =>
    `<div class="tbar"><span>${esc(t.name)}</span><i><b style="width:${Math.round((t.n / Math.max(...c.numbers.topTopics.map((x) => x.n))) * 100)}%;background:${TOPIC_COLOR[t.name] || '#6b7280'}"></b></i><em>${t.n}</em></div>`
  ).join('');

  const next = (c.nextWeek || []).length
    ? `<div class="wnext"><h5>下周盯这几件事</h5><ol>${c.nextWeek.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : '';

  const prevList = prev.length ? `
    <div class="sect-head" style="margin-top:28px"><h3>📚 往期预览</h3><span class="n">${prev.length} 期</span><span class="line"></span></div>
    <div class="past-grid">${prev.map((x, i) => `
      <button class="past-item" data-act="week" data-v="${idx + 1 + i}">
        <span class="pd">${esc(x.weekLabel)}</span><b>${esc(x.headline)}</b><em>${esc(x.dateRange)}</em>
      </button>`).join('')}</div>` : '';

  const back = idx > 0 ? `<button class="btn" data-act="week" data-v="0">← 回到最新一期</button>` : '';

  return `
  <div class="weekly">
    <div class="w-head">
      <div class="w-eyebrow">
        <span class="wweek">${esc(c.weekLabel)}</span>
        ${statusBadge}
        <span class="meta">${esc(c.dateRange)}</span>
        ${c.coversUntil && c.status === '试刊' ? `<span class="meta">· 本期数据截至 ${esc(c.coversUntil)}</span>` : ''}
      </div>
      <h2>${esc(c.headline)}</h2>
      <p class="w-overview">${esc(c.overview)}</p>
      <div class="w-nums">
        <div class="stat"><b>${c.numbers?.items ?? 0}</b><span>本期收录</span></div>
        <div class="stat"><b>${c.numbers?.crawled ?? 0}</b><span>本周抓取</span></div>
        <div class="stat"><b>${c.numbers?.sourcesOk ?? 0}/${c.numbers?.sources ?? 0}</b><span>源在线</span></div>
        <div class="stat"><b>${c.numbers?.regions ?? 7}</b><span>区域</span></div>
      </div>
    </div>

    <div class="threads">${threads}</div>

    <div class="w-cols">
      <div class="w-col">
        <h4>分区速览</h4>
        ${regions}
      </div>
      <div class="w-col">
        <h4>本周主题分布</h4>
        <div class="tbars">${topics}</div>
        <div class="wdiff">
          <h5>难度分布</h5>
          <p>${Object.entries(c.numbers?.difficulty || {}).map(([k, v]) => `<span class="tg diff" style="--tc:${DIFF_COLOR[k] || '#6b7280'}">${esc(k)} ${v} 条</span>`).join(' ')}</p>
        </div>
        ${next}
      </div>
    </div>

    ${prevList}
    ${back ? `<div style="margin-top:20px">${back}</div>` : ''}
  </div>`;
}



function renderMap() {
  const pp = phaseProgress();
  const c = S.curriculum;
  if (!c) return `<div class="empty"><p>学习地图数据未载入。</p></div>`;

  const dr = c.dailyRoutine;
  const routine = `
  <div class="routine">
    <h3>${esc(dr.title)}</h3>
    <div class="sub">不求读完，只求每天建立一个连接。坚持 24 周，你会拥有自己的行业地图。</div>
    ${c.calendarNote ? `<div class="calnote">🗓 ${esc(c.calendarNote)}</div>` : ''}
    <div class="rsteps">${dr.steps.map((s) => `
      <div class="rstep"><div class="rn">${s.n}</div><strong>${esc(s.t)}</strong><p>${esc(s.d)}</p></div>`).join('')}
    </div>
    <div class="rhythm">
      <table>
        <thead><tr><th>星期</th><th>视角</th><th>建议动作（工作日 15 分钟，周末不排任务）</th></tr></thead>
        <tbody>${dr.weeklyRhythm.map((r) => `
          <tr class="${r.kind === 'rest' ? 'rest' : ''}">
            <td>${esc(r.day)}</td>
            <td><span class="rtag ${r.kind === 'rest' ? 'off' : ''}">${esc(r.tag || (r.kind === 'rest' ? '休息' : '学习'))}</span></td>
            <td>${esc(r.task)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>
  ${c.dailyProfile || c.weeklyPreview ? `
  <div class="modgrid">
    ${c.dailyProfile ? `
    <div class="modcard">
      <div class="modhead"><span class="modicon">🔬</span>
        <div><b>${esc(c.dailyProfile.title)}</b><span>${esc(c.dailyProfile.schedule)}</span></div>
        <button class="btn" data-act="tab" data-tab="profile">去看 →</button>
      </div>
      <p class="modguide">${esc(c.dailyProfile.readingGuide)}</p>
      <div class="modcrit"><span class="pt-label">选题标准</span><ul>${c.dailyProfile.selectionCriteria.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>` : ''}
    ${c.weeklyPreview ? `
    <div class="modcard">
      <div class="modhead"><span class="modicon">📅</span>
        <div><b>${esc(c.weeklyPreview.title)}</b><span>${esc(c.weeklyPreview.schedule)}</span></div>
        <button class="btn" data-act="tab" data-tab="weekly">去看 →</button>
      </div>
      <p class="modguide">${esc(c.weeklyPreview.readingGuide)}</p>
    </div>` : ''}
  </div>` : ''}`;

  const cyHTML = pp.cycles.map((cy, ci) => {
    const ws = cy.months.flatMap((m) => m.weeks);
    const lo = ws[0].globalWeek, hi = ws[ws.length - 1].globalWeek;
    const state = pp.cur > hi ? 'done' : pp.cur >= lo ? 'now' : '';
    const colors = ['#4f46e5', '#0ea5e9', '#8b5cf6'];
    const months = cy.months.map((m) => {
      const open = m.weeks.some((w) => w.globalWeek === pp.cur);
      return `
      <div class="month ${open ? 'open' : ''}" data-month>
        <div class="month-head" data-act="month">
          <span>第 ${m.m} 个月 · ${esc(m.theme)}</span>
          <span class="mi">${m.weeks.length} 周 · 重点：${(m.focusTags || []).join('、')}</span>
          <span class="caret">▶</span>
        </div>
        <div class="month-body">
          ${m.weeks.map((w) => {
            const k = weekKey(cy.id, m.m, w.w);
            const done = !!S.progress[k];
            return `
            <div class="week ${done ? 'done' : ''} ${w.globalWeek === pp.cur ? 'cur' : ''}">
              <div class="week-top">
                <div class="wbox" data-act="week" data-k="${k}" title="标记完成">✓</div>
                <div class="wt">
                  <span class="wk">第 ${w.globalWeek} 周</span>
                  <strong>${esc(w.title)}</strong>
                </div>
                ${w.globalWeek === pp.cur ? '<span class="badge now">本周</span>' : ''}
              </div>
              <div class="wbody">
                <div><span class="k">要理解：</span>${esc(w.learn)}</div>
                <div><span class="k">每日：</span>${esc(w.daily)}</div>
                <div><span class="k">本周产出：</span>${esc(w.task)}</div>
                ${w.glossary?.length ? `<div class="gl-terms">${w.glossary.map((g) => {
                  const t = findTerm(g);
                  return t ? `<span class="tg gl" data-act="glossary" data-term="${esc(g)}"># ${esc(t.term.split(' / ')[0])}</span>` : '';
                }).join('')}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    return `
    <div class="cycle" style="--cc:${colors[ci]}">
      <div class="cycle-head">
        <div class="cycle-no" style="--cc:${colors[ci]}">${ci + 1}</div>
        <div class="ct">
          <strong>${esc(cy.name)}阶段 · ${esc(cy.subtitle)}</strong>
          <span>第 ${lo}-${hi} 周（约 2 个月）</span>
        </div>
        <div class="badges">
          ${state === 'now' ? '<span class="badge now">进行中</span>' : state === 'done' ? '<span class="badge done">已完成</span>' : '<span class="badge">未开始</span>'}
          <span class="badge">每日 ${esc(cy.dailyTarget)}</span>
        </div>
      </div>
      <div class="goal"><b>阶段目标：</b>${esc(cy.goal)}<br><b>阶段产出：</b>${cy.outputs.map(esc).join('；')}</div>
      ${months}
    </div>`;
  }).join('');

  return routine + cyHTML;
}

/* ------------------------------- 渲染：收藏夹 --------------------------- */

function renderBm() {
  if (!S.bookmarks.length) {
    return `<div class="empty"><div class="em">⭐</div>
      <p>收藏夹还是空的。</p>
      <p style="font-size:12.5px">在「今日要闻」里点卡片右上角的 ☆，就会存到这里，跨天、跨刷新都不会丢。<br>建议按主题攒：把同一主题的收藏连连看，就是你自己写的产业脉络。</p>
      <p style="margin-top:16px"><button class="btn primary" data-act="tab" data-tab="feed">去今日要闻逛逛</button></p></div>`;
  }

  const sortedBm = [...S.bookmarks].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const groups = {};
  sortedBm.forEach((b) => {
    const g = b.region ? (REGION_META[b.region]?.name || b.region) : '未分类';
    (groups[g] ||= []).push(b);
  });

  const body = Object.entries(groups).map(([g, arr]) => `
    <div class="bm-group">
      <h4>${esc(g)} <span style="color:var(--muted);font-weight:400">${arr.length} 条</span><span class="line"></span></h4>
      <div class="feed">${arr.map((b) => `
        <article class="card" style="--rc:${REGION_META[b.region]?.color || '#64748b'}" data-id="${b.id}">
          <div class="card-top">
            <span class="rbadge">${REGION_META[b.region]?.flag || ''} ${esc(REGION_META[b.region]?.name || '')}</span>
            <span class="src">${esc(b.source || '')}</span>
            <span class="dotsep">·</span>
            <span class="meta">收藏于 ${esc((b.savedAt || '').slice(0, 10))}${b.publishedAt ? ` · 发布于 ${esc(relTime(b.publishedAt))}` : ''}</span>
            <div class="acts">
              <button class="mini on" data-act="bm" data-id="${b.id}" title="移出收藏夹">★</button>
            </div>
          </div>
          <h3><a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title)}</a></h3>
          ${b.titleZh && b.titleZh !== b.title ? `<div class="zh-title">▸ ${esc(b.titleZh)}</div>` : ''}
          ${b.plain ? `<div class="plain"><span class="lb">白话解读</span>${esc(b.plain)}</div>` : ''}
          ${b.why ? `<div class="why"><span class="lb">为什么重要</span>${esc(b.why)}</div>` : ''}
          ${(b.topics || []).length ? `<div class="tags">${b.topics.map((t) => `<span class="tg" style="--tc:${TOPIC_COLOR[t.name] || '#6b7280'}">${esc(t.name)}</span>`).join('')}</div>` : ''}
          <textarea class="bm-note" data-act="bmmemo" data-id="${b.id}" placeholder="写一句你的理解 / 为什么收藏它…">${esc(b.note || '')}</textarea>
        </article>`).join('')}</div>
    </div>`).join('');

  return `
  <div class="bm-bar">
    <span class="t">共 ${S.bookmarks.length} 条收藏 · 分 ${Object.keys(groups).length} 组</span>
    <button class="btn" data-act="bmexport" data-fmt="md">导出 Markdown</button>
    <button class="btn" data-act="bmexport" data-fmt="json">导出 JSON</button>
    <button class="btn danger" data-act="bmclear">清空收藏夹</button>
  </div>${body}`;
}

/* ------------------------------- 渲染：词典 ----------------------------- */

function renderGl() {
  if (!S.glossary) return `<div class="empty"><p>词典未载入。</p></div>`;
  const q = S.q.trim().toLowerCase();
  const cats = S.glossary.categories.map((c) => {
    const terms = c.terms.filter((t) =>
      !q || t.term.toLowerCase().includes(q) || (t.aliases || []).some((a) => a.toLowerCase().includes(q)) || t.def.toLowerCase().includes(q));
    if (!terms.length) return '';
    return `
    <div class="gl-cat">
      <h3><i style="--gc:${c.color}"></i>${esc(c.name)}<span>${terms.length} 个概念</span></h3>
      <dl class="gl-grid">${terms.map((t) => `
        <div class="gl-item" id="term-${t.id}">
          <dt>${esc(t.term)}${t.aliases?.length ? `<span class="en">${esc(t.aliases.slice(0, 2).join(' / '))}</span>` : ''}</dt>
          <dd>${esc(t.def)}</dd>
        </div>`).join('')}</dl>
    </div>`;
  }).join('');
  return `
  <div class="filters gl-search">
    <div class="frow">
      <span class="flabel">检索</span>
      <input class="search" data-act="search" placeholder="输入术语，例如 token、推理成本、护城河…" value="${esc(S.q)}" />
      <button class="btn" data-act="reset">清空</button>
    </div>
  </div>
  ${cats || `<div class="empty"><div class="em">🔍</div><p>没有匹配的术语。</p></div>`}`;
}

/* ------------------------------- 渲染：归档 ----------------------------- */

function renderArch() {
  if (!S.archive.length) return `<div class="empty"><p>还没有历史归档。每天 9 点抓取后会自动积累。</p></div>`;
  const list = `
  <div class="arch-grid">${S.archive.map((a) => `
    <button class="arch-item ${S.archDate === a.date ? 'on' : ''}" data-act="arch" data-v="${a.date}">
      <b>${esc(a.date)}</b><span>${a.total} 条要闻</span>
    </button>`).join('')}</div>`;

  let detail = '';
  if (S.archDate && S.archData) {
    const items = (S.archData.items || []).slice(0, 60);
    detail = `
      <div class="sect-head" style="margin-top:26px"><h3>${esc(S.archDate)} 归档</h3>
        <span class="n">${S.archData.items.length} 条</span><span class="line"></span></div>
      <div class="feed">${items.map(cardHTML).join('')}</div>`;
  } else if (S.archDate) {
    detail = `<div class="empty" style="margin-top:22px"><p>正在载入 ${esc(S.archDate)} …</p></div>`;
  }
  return `<div class="filters"><div class="frow"><span class="flabel">日期</span>
    <span class="meta">点击日期查看当天抓取的全部要闻（含未进入今日精选的内容）</span></div></div>
    ${list}${detail}`;
}

/* ------------------------------ 中转台（业务模块） ----------------------- */

const fmtMoney = (x) => '¥' + (Math.round(x * 100) / 100).toLocaleString('en-US');

function renderBiz() {
  const sub = ['primer', 'channels', 'calc', 'quote', 'crm', 'sync'];
  const labels = { primer: '业务认知', channels: '渠道管理', calc: '差价计算器', quote: '报价单', crm: '客户管理', sync: '☁️ 云同步' };
  const subnav = `<div class="biz-sub">${sub.map((k) => `
    <button class="biz-sub-btn ${S.bizTab === k ? 'on' : ''}" data-act="bizsub" data-v="${k}">${labels[k]}</button>`).join('')}</div>`;
  let body = '';
  if (S.bizTab === 'primer') body = bizPrimerHTML();
  else if (S.bizTab === 'channels') body = bizChannelsHTML();
  else if (S.bizTab === 'calc') body = bizCalcHTML();
  else if (S.bizTab === 'quote') body = bizQuoteHTML();
  else if (S.bizTab === 'crm') body = bizCrmHTML();
  else if (S.bizTab === 'sync') body = bizSyncHTML();
  else body = bizCalcHTML();
  return `${subnav}<div class="biz-body">${body}</div>`;
}

/** 取当前渠道：若有本地台账优先用台账，否则用示例数据 */
function getBizChannels() {
  if (S.channels && S.channels.length) return S.channels;
  return (S.models?.models || []).map((m) => ({
    id: m.id, vendor: m.vendor, model: m.model, tier: m.tier, context: m.context,
    priceIn: m.priceIn, priceOut: m.priceOut, latency: m.latency, quality: m.quality,
    langs: m.langs || [], overseas: m.overseas, note: '',
  }));
}

function bizPrimerHTML() {
  return `
  <div class="biz-intro">
    <h2>Token 中转服务 · 业务认知</h2>
    <p>你处在<strong>上游大模型厂商</strong>与<strong>下游客户</strong>之间：向上游拿到渠道 / 协议价，向下游客户按你的报价计费，赚中间差价。核心是把「合适的模型」用「合适的延迟与价格」送到「合适的区域客户」。</p>
  </div>
  <div class="biz-flow">
    <div class="flow-node up"><b>上游模型厂商</b><span>国内大模型（DeepSeek / 通义 / 智谱 / 豆包 / Kimi …）</span><i>渠道价 · API</i></div>
    <div class="flow-arrow">➜</div>
    <div class="flow-node mid"><b>💱 你的中转层</b><span>路由 · 计费 · 加价 · 合规 · 节点</span><i>赚差价</i></div>
    <div class="flow-arrow">➜</div>
    <div class="flow-node down"><b>下游客户</b><span>东南亚 → 亚洲 → 全球</span><i>按量付费</i></div>
  </div>
  <div class="biz-cards">
    <div class="biz-card">
      <h3>💰 赚钱逻辑</h3>
      <ul>
        <li><b>收入</b> = 下游计费（输出通常比输入贵，按 token 分别计价）</li>
        <li><b>成本</b> = 上游渠道价 + 转发 / 节点 / 运营成本</li>
        <li><b>利润</b> = 收入 − 成本 − 运营成本</li>
        <li>加价方式：按比例（如 +30%）或固定绝对值（¥/百万 tokens）</li>
      </ul>
    </div>
    <div class="biz-card">
      <h3>🌏 为什么东南亚是切入点</h3>
      <ul>
        <li><b>地理近 → 延迟低</b>：示例 RTT 50–90ms，体感接近本地</li>
        <li>华人商圈 / 文化近，出海第一站阻力小</li>
        <li>可在此设<strong>中转节点</strong>降低 RTT，再辐射亚洲 / 全球</li>
        <li>成本敏感的中小客户多，适合走量模型（豆包 / DeepSeek）</li>
      </ul>
    </div>
    <div class="biz-card">
      <h3>🎯 选渠道的关键维度</h3>
      <ul>
        <li><b>价格</b>：¥/百万 tokens（输入 vs 输出分开看）</li>
        <li><b>延迟</b>：从目标区域测的 RTT，决定体感</li>
        <li><b>质量</b>：任务适配度（推理 / 长上下文 / 多语）</li>
        <li><b>稳定性 & 出海可用性</b>：API 是否对你所在区域开放</li>
      </ul>
    </div>
    <div class="biz-card warn">
      <h3>⚠️ 风险与注意</h3>
      <ul>
        <li>上游价频繁变动，需动态调价</li>
        <li>跨境数据传输 / 内容安全 / 当地牌照合规</li>
        <li>汇率波动（你收客户多为外币）</li>
        <li>渠道稳定性：避免单点依赖，多上游备份</li>
      </ul>
    </div>
  </div>
  <p class="biz-tip">👉 下一步：到「上游渠道比对」挑模型，再到「差价计算器」算你的报价与月毛利。</p>`;
}

function bizChannelsHTML() {
  const usingSample = !(S.channels && S.channels.length);
  const chs = getBizChannels();
  const tiers = ['ALL', ...new Set(chs.map((m) => m.tier))];
  const list = chs
    .filter((m) => S.bizTier === 'ALL' || m.tier === S.bizTier)
    .slice()
    .sort((a, b) => {
      if (S.bizSort === 'price') return (a.priceIn + a.priceOut) - (b.priceIn + b.priceOut);
      if (S.bizSort === 'latency') return a.latency - b.latency;
      if (S.bizSort === 'quality') return b.quality - a.quality;
      return 0;
    });
  const tierOpts = tiers.map((t) => `<option value="${t}" ${S.bizTier === t ? 'selected' : ''}>${t === 'ALL' ? '全部档位' : esc(t)}</option>`).join('');
  const rows = list.map((m) => `
    <tr>
      <td><b>${esc(m.vendor)}</b><div class="sub">${esc(m.model)}</div></td>
      <td><span class="pill">${esc(m.tier)}</span></td>
      <td>${esc(m.context)}</td>
      <td class="num">¥${m.priceIn}<div class="sub">出 ¥${m.priceOut}</div></td>
      <td class="num">${m.latency}ms</td>
      <td class="num">${'★'.repeat(m.quality)}${'☆'.repeat(5 - m.quality)}</td>
      <td>${esc((m.langs || []).join('/'))}</td>
      <td>${esc(m.overseas || '')}</td>
      <td class="row-actions">
        <button class="mini" data-act="calcfill" data-id="${m.id}" title="填入计算器">＋计算器</button>
        ${usingSample ? '' : `<button class="mini" data-act="chedit" data-id="${m.id}">编辑</button><button class="mini danger" data-act="chdel" data-id="${m.id}">删</button>`}
      </td>
    </tr>`).join('');
  const e = S.bizEditCh ? chs.find((x) => x.id === S.bizEditCh) : null;
  const f = (k, d = '') => (e ? esc(e[k] ?? d) : '');
  const langsVal = e ? (Array.isArray(e.langs) ? e.langs.join('/') : (e.langs || '')) : '';
  const form = `
  <div class="ch-form">
    <h3>${e ? `编辑渠道：${esc(e.vendor)} ${esc(e.model)}` : '➕ 新增上游渠道（存浏览器本地）'}</h3>
    <div class="ch-grid">
      <label>厂商<input name="vendor" value="${f('vendor')}" placeholder="如 深度求索"></label>
      <label>模型<input name="model" value="${f('model')}" placeholder="如 DeepSeek-V3"></label>
      <label>档位<input name="tier" value="${f('tier')}" placeholder="如 standard"></label>
      <label>上下文<input name="context" value="${f('context')}" placeholder="如 128K"></label>
      <label>输入价(¥/M)<input name="priceIn" type="number" step="0.1" min="0" value="${f('priceIn', 0)}"></label>
      <label>输出价(¥/M)<input name="priceOut" type="number" step="0.1" min="0" value="${f('priceOut', 0)}"></label>
      <label>SEA延迟(ms)<input name="latency" type="number" step="1" min="0" value="${f('latency', 0)}"></label>
      <label>质量(1-5)<input name="quality" type="number" step="1" min="0" max="5" value="${f('quality', 3)}"></label>
      <label>语种<input name="langs" value="${esc(langsVal)}" placeholder="逗号分隔，如 中英/英"></label>
      <label>出海可用<input name="overseas" value="${f('overseas')}" placeholder="如 东南亚可用"></label>
    </div>
    <label class="ch-note">备注<textarea name="note" rows="2">${f('note')}</textarea></label>
    <div class="ch-form-actions">
      <button class="mini primary" data-act="chsave">${e ? '保存修改' : '添加渠道'}</button>
      ${e ? '<button class="mini" data-act="chcancel">取消</button>' : ''}
    </div>
  </div>`;
  return `
  <div class="filters"><div class="frow">
    <span class="flabel">档位</span><select data-act="biztier">${tierOpts}</select>
    <span class="flabel">排序</span><select data-act="bizsort">
      <option value="price" ${S.bizSort === 'price' ? 'selected' : ''}>价格（低→高）</option>
      <option value="latency" ${S.bizSort === 'latency' ? 'selected' : ''}>延迟（低→高）</option>
      <option value="quality" ${S.bizSort === 'quality' ? 'selected' : ''}>质量（高→低）</option>
    </select>
    <span class="meta ${usingSample ? 'warn' : ''}">${usingSample ? '当前：示例数据（点「导入示例」可转成可编辑台账）' : '当前：我的台账（已存本地）'}</span>
  </div></div>
  <div class="ch-toolbar">
    ${usingSample
      ? '<button class="mini primary" data-act="chimport">导入示例到台账</button>'
      : '<button class="mini" data-act="chclear">清空台账（回示例）</button><button class="mini" data-act="chexport">导出 JSON</button>'}
    <button class="mini" data-act="chimportfile">导入备份 JSON</button>
    <input type="file" data-act="chfile" accept="application/json,.json" hidden>
    <span class="meta">数据存本机浏览器 · 导出/导入可在设备间搬运</span>
  </div>
  <div class="cmp-wrap">
    <table class="cmp-table">
      <thead><tr>
        <th>厂商 / 模型</th><th>档位</th><th>上下文</th><th>价格(¥/M)<br><span class="sub">输入 / 输出</span></th>
        <th>延迟(SEA)</th><th>质量</th><th>语种</th><th>出海可用</th><th>操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${form}`;
}

function bizCalcHTML() {
  const c = S.calc;
  return `
  <div class="calc-grid">
    <div class="calc-in">
      <h3>输入</h3>
      <label>上游输入价（¥/百万 tokens）<input id="calc-in" type="number" min="0" step="0.1" data-act="calc" value="${c.in}"></label>
      <label>上游输出价（¥/百万 tokens）<input id="calc-out" type="number" min="0" step="0.1" data-act="calc" value="${c.out}"></label>
      <label>目标利润率（%）<input id="calc-margin" type="number" min="0" step="1" data-act="calc" value="${c.margin}"></label>
      <label>预估月输入量（百万 tokens）<input id="calc-vin" type="number" min="0" step="1" data-act="calc" value="${c.vin}"></label>
      <label>预估月输出量（百万 tokens）<input id="calc-vout" type="number" min="0" step="1" data-act="calc" value="${c.vout}"></label>
      <button class="mini" data-act="calcreset">重置示例</button>
    </div>
    <div class="calc-out">
      <h3>测算结果</h3>
      <div class="res"><span>下游输入价</span><b id="r-in">—</b></div>
      <div class="res"><span>下游输出价</span><b id="r-out">—</b></div>
      <div class="res"><span>月上游成本</span><b id="r-cost">—</b></div>
      <div class="res"><span>月下游营收</span><b id="r-rev">—</b></div>
      <div class="res hl"><span>月毛利</span><b id="r-profit">—</b></div>
      <div class="res"><span>毛利率</span><b id="r-margin">—</b></div>
      <p class="biz-tip">结果随输入实时变化；在「上游渠道比对」点「＋计算器」可一键带入某模型的上游价。</p>
    </div>
  </div>`;
}

function calcrecompute() {
  const g = (id) => document.getElementById(id);
  const pin = parseFloat(g('calc-in')?.value);
  const pout = parseFloat(g('calc-out')?.value);
  const m = parseFloat(g('calc-margin')?.value);
  const vin = parseFloat(g('calc-vin')?.value);
  const vout = parseFloat(g('calc-vout')?.value);
  if ([pin, pout, m, vin, vout].some((x) => isNaN(x))) return;
  S.calc = { in: pin, out: pout, margin: m, vin, vout };
  const din = pin * (1 + m / 100);
  const dout = pout * (1 + m / 100);
  const cost = pin * vin + pout * vout;
  const rev = din * vin + dout * vout;
  const profit = rev - cost;
  const mp = rev > 0 ? (profit / rev * 100) : 0;
  if (g('r-in')) g('r-in').textContent = fmtMoney(din);
  if (g('r-out')) g('r-out').textContent = fmtMoney(dout);
  if (g('r-cost')) g('r-cost').textContent = fmtMoney(cost);
  if (g('r-rev')) g('r-rev').textContent = fmtMoney(rev);
  if (g('r-profit')) g('r-profit').textContent = fmtMoney(profit);
  if (g('r-margin')) g('r-margin').textContent = mp.toFixed(1) + '%';
}

function bizQuoteHTML() {
  const chs = getBizChannels();
  if (!chs.length) return '<div class="empty"><p>还没有渠道数据，请先到「渠道管理」导入示例或新增。</p></div>';
  const modelOpts = chs.map((m) => `<option value="${m.id}">${esc(m.vendor)} ${esc(m.model)}（¥${m.priceIn}/¥${m.priceOut}）</option>`).join('');
  const regionOpts = ['东南亚', '亚洲', '全球', '其他'].map((r) => `<option value="${r}">${r}</option>`).join('');
  return `
  <div class="quote-grid">
    <div class="calc-in">
      <h3>报价参数</h3>
      <label>客户名称<input id="q-cust" value=""></label>
      <label>目标区域<select id="q-region" data-act="quote">${regionOpts}</select></label>
      <label>选择模型<select id="q-model" data-act="quote">${modelOpts}</select></label>
      <label>目标利润率（%）<input id="q-margin" type="number" step="1" min="0" value="30"></label>
      <label>区域服务费溢价（%）<input id="q-radd" type="number" step="1" min="0" value="0" title="东南亚延迟低可设 0；全球可加溢价"></label>
      <label>月输入量（百万 tokens）<input id="q-vin" type="number" step="1" min="0" value="100"></label>
      <label>月输出量（百万 tokens）<input id="q-vout" type="number" step="1" min="0" value="100"></label>
      <label>固定月服务费（¥，可选）<input id="q-fee" type="number" step="100" min="0" value="0"></label>
    </div>
    <div class="calc-out" id="quote-out"><h3>报价单预览</h3><div class="res"><span>填写左侧参数</span><b>—</b></div></div>
  </div>
  <div class="quote-actions">
    <button class="mini" data-act="qcopy" data-lang="zh">复制中文报价</button>
    <button class="mini" data-act="qcopy" data-lang="en">Copy English</button>
    <button class="mini" data-act="qdown">下载 .txt</button>
  </div>`;
}

function quoteCompute() {
  const g = (id) => document.getElementById(id);
  const m = getBizChannels().find((x) => x.id === g('q-model')?.value);
  const out = document.getElementById('quote-out');
  if (!m || !out) return;
  const margin = parseFloat(g('q-margin')?.value) || 0;
  const radd = parseFloat(g('q-radd')?.value) || 0;
  const vin = parseFloat(g('q-vin')?.value) || 0;
  const vout = parseFloat(g('q-vout')?.value) || 0;
  const fee = parseFloat(g('q-fee')?.value) || 0;
  const din = m.priceIn * (1 + margin / 100) * (1 + radd / 100);
  const dout = m.priceOut * (1 + margin / 100) * (1 + radd / 100);
  const cost = m.priceIn * vin + m.priceOut * vout;
  const rev = din * vin + dout * vout + fee;
  const profit = rev - cost - fee;
  const mp = rev > 0 ? (profit / rev * 100) : 0;
  out.innerHTML = `<h3>报价单预览</h3>
    <div class="res"><span>上游输入价</span><b>¥${m.priceIn}</b></div>
    <div class="res"><span>上游输出价</span><b>¥${m.priceOut}</b></div>
    <div class="res hl"><span>建议下游输入价</span><b>${fmtMoney(din)}</b></div>
    <div class="res hl"><span>建议下游输出价</span><b>${fmtMoney(dout)}</b></div>
    <div class="res"><span>月上游成本</span><b>${fmtMoney(cost)}</b></div>
    <div class="res"><span>月下游营收</span><b>${fmtMoney(rev)}</b></div>
    <div class="res hl"><span>月毛利</span><b>${fmtMoney(profit)}</b></div>
    <div class="res"><span>毛利率</span><b>${mp.toFixed(1)}%</b></div>`;
  S._quote = { cust: g('q-cust')?.value || '（未填）', region: g('q-region')?.value || '东南亚', m, din, dout, cost, rev, profit, mp, vin, vout, fee, margin, radd };
}

const REGION_EN = { '东南亚': 'Southeast Asia', '亚洲': 'Asia', '全球': 'Global', '其他': 'Other' };

function quoteTextZH(q) {
  return `客户报价单
客户：${q.cust}
目标区域：${q.region}
模型：${q.m.vendor} ${q.m.model}
上游成本：输入 ¥${q.m.priceIn} / 输出 ¥${q.m.priceOut}（每百万 tokens）
目标利润率：${q.margin}%${q.radd ? ' ｜ 区域服务费溢价：' + q.radd + '%' : ''}
-------------------------
建议下游报价：
  输入价：${fmtMoney(q.din)} / 百万 tokens
  输出价：${fmtMoney(q.dout)} / 百万 tokens
月用量预估：输入 ${q.vin} M / 输出 ${q.vout} M
月上游成本：${fmtMoney(q.cost)}
月下游营收：${fmtMoney(q.rev)}${q.fee ? '（含固定服务费 ' + fmtMoney(q.fee) + '）' : ''}
月毛利：${fmtMoney(q.profit)}
毛利率：${q.mp.toFixed(1)}%
（示例测算，价格以实际渠道为准）`;
}

function quoteTextEN(q) {
  const region = REGION_EN[q.region] || q.region;
  return `QUOTATION
Client: ${q.cust}
Region: ${region}
Model: ${q.m.vendor} ${q.m.model}
Upstream cost: input ¥${q.m.priceIn} / output ¥${q.m.priceOut} per 1M tokens
Target margin: ${q.margin}%${q.radd ? ' | Regional premium: ' + q.radd + '%' : ''}
-------------------------
Suggested resale price:
  Input: ${fmtMoney(q.din)} / 1M tokens
  Output: ${fmtMoney(q.dout)} / 1M tokens
Estimated monthly volume: input ${q.vin}M / output ${q.vout}M
Monthly upstream cost: ${fmtMoney(q.cost)}
Monthly revenue: ${fmtMoney(q.rev)}${q.fee ? ' (incl. fixed fee ' + fmtMoney(q.fee) + ')' : ''}
Monthly gross profit: ${fmtMoney(q.profit)}
Gross margin: ${q.mp.toFixed(1)}%
(Estimate only; subject to actual channel pricing)`;
}

function bizCrmHTML() {
  const cus = S.customers || [];
  const chs = getBizChannels();
  const regionList = ['东南亚', '亚洲', '全球', '其他'];
  const statusList = ['潜在', '试用', '签约', '流失'];
  const modelItems = chs.map((m) => ({ v: m.id, label: m.vendor + ' ' + m.model }));
  const optHTML = (items, sel) => items.map((it) => `<option value="${esc(it.v)}" ${it.v === sel ? 'selected' : ''}>${esc(it.label)}</option>`).join('');
  const stats = {
    total: cus.length,
    signed: cus.filter((c) => c.status === '签约').length,
    vol: cus.reduce((s, c) => s + (parseFloat(c.monthly) || 0), 0),
    rev: cus.reduce((s, c) => s + (parseFloat(c.monthly) || 0) * (parseFloat(c.price) || 0), 0),
  };
  const rows = cus.map((c) => {
    const m = chs.find((x) => x.id === c.model);
    return `<tr>
      <td><b>${esc(c.name)}</b><div class="sub">${esc(c.contact || '')}</div></td>
      <td>${esc(c.region)}</td>
      <td>${m ? esc(m.vendor + ' ' + m.model) : '—'}</td>
      <td class="num">${c.monthly} M</td>
      <td class="num">¥${c.price}</td>
      <td><span class="pill ${c.status === '签约' ? 'on' : ''}">${esc(c.status)}</span></td>
      <td class="row-actions"><button class="mini" data-act="cuedit" data-id="${c.id}">编辑</button><button class="mini danger" data-act="cudel" data-id="${c.id}">删</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="empty">还没有客户，下面添加第一个。</td></tr>`;
  const e = S.bizEditCu ? cus.find((x) => x.id === S.bizEditCu) : null;
  const f = (k, d = '') => (e ? esc(e[k] ?? d) : '');
  const form = `
  <div class="ch-form">
    <h3>${e ? '编辑客户：' + esc(e.name) : '➕ 新增下游客户（存浏览器本地）'}</h3>
    <div class="ch-grid">
      <label>客户名称<input name="name" value="${f('name')}"></label>
      <label>地区<select name="region">${optHTML(regionList.map((r) => ({ v: r, label: r })), e?.region)}</select></label>
      <label>联系人<input name="contact" value="${f('contact')}"></label>
      <label>签约模型<select name="model">${optHTML(modelItems, e?.model)}</select></label>
      <label>合同月用量(百万 tokens)<input name="monthly" type="number" step="1" min="0" value="${f('monthly', 0)}"></label>
      <label>合同综合价(¥/M)<input name="price" type="number" step="0.1" min="0" value="${f('price', 0)}"></label>
      <label>状态<select name="status">${optHTML(statusList.map((r) => ({ v: r, label: r })), e?.status)}</select></label>
      <label>备注<input name="note" value="${f('note')}"></label>
    </div>
    <div class="ch-form-actions">
      <button class="mini primary" data-act="cusave">${e ? '保存修改' : '添加客户'}</button>
      ${e ? '<button class="mini" data-act="cucancel">取消</button>' : ''}
    </div>
  </div>`;
  return `
  <div class="crm-stats">
    <div class="stat"><span>客户总数</span><b>${stats.total}</b></div>
    <div class="stat"><span>签约中</span><b>${stats.signed}</b></div>
    <div class="stat"><span>合同总月用量</span><b>${stats.vol} M</b></div>
    <div class="stat"><span>估算月营收</span><b>${fmtMoney(stats.rev)}</b></div>
  </div>
  <div class="ch-toolbar">
    <button class="mini" data-act="cuexport">导出客户 JSON</button>
    <button class="mini" data-act="cuimportfile">导入备份 JSON</button>
    <input type="file" data-act="cufile" accept="application/json,.json" hidden>
    <span class="meta">数据存本机浏览器 · 导出/导入可在设备间搬运</span>
  </div>
  <div class="cmp-wrap">
    <table class="cmp-table">
      <thead><tr>
        <th>客户 / 联系人</th><th>地区</th><th>签约模型</th><th>月用量</th><th>合同价</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${form}`;
}

/* --------------------------------- 云同步（GitHub 私有 Gist） --------------------------------- */

function bizSyncHTML() {
  const s = S.sync || {};
  const chCount = (S.channels || []).length;
  const cuCount = (S.customers || []).length;
  const hasToken = !!s.token;
  const lastSync = s.lastSync ? new Date(s.lastSync).toLocaleString('zh-CN') : '尚未同步';
  return `
  <div class="biz-intro">
    <h2>☁️ 云同步 · 让 iMac 与 MacBook 数据对齐</h2>
    <p>数据存在你自己的 <strong>GitHub 私有 Gist</strong> 里。在任意一台设备「上传」，另一台「拉取」即可对齐——不依赖服务器，不影响站点本身。令牌只存在本机浏览器，<strong>不会写入代码仓库</strong>。</p>
  </div>

  <div class="sync-cards">
    <div class="sync-card">
      <h3>① 第一步：准备令牌（只需做一次）</h3>
      <ol class="sync-steps">
        <li>GitHub → 头像 → <b>Settings → Developer settings → Personal access tokens → Tokens (classic)</b></li>
        <li>点 <b>Generate new token (classic)</b>，Note 写「AI瞭望台云同步」</li>
        <li>权限只勾一项：<b>✅ gist</b>（其余都不勾）</li>
        <li>生成后复制那串 <code>ghp_...</code> 令牌，粘贴到下方（它只存你这台浏览器）</li>
      </ol>
      <div class="sync-form">
        <label>GitHub 令牌（gist 权限）<input id="sync-token" type="password" placeholder="ghp_..." autocomplete="off"></label>
        <label>已有同步 Gist ID（可选，留空=首次自动创建）<input id="sync-gist" placeholder="留空则首次上传时自动创建"></label>
        <button class="mini primary" data-act="syncsave">保存令牌 / Gist ID</button>
        <span class="meta">${hasToken ? '✅ 已保存令牌（已加密存本地）' : '⚠️ 尚未保存令牌'}</span>
      </div>
    </div>

    <div class="sync-card">
      <h3>② 第二步：同步</h3>
      <div class="sync-status">
        <div><span>本地渠道台账</span><b>${chCount} 条</b></div>
        <div><span>本地客户数据</span><b>${cuCount} 条</b></div>
        <div><span>上次同步</span><b>${esc(lastSync)}</b></div>
      </div>
      <div class="sync-actions">
        <button class="mini primary" data-act="syncupload" ${hasToken ? '' : 'disabled'}>☁️ 上传到云端（本地 → Gist）</button>
        <button class="mini" data-act="syncdownload" ${hasToken ? '' : 'disabled'}>⬇️ 从云端拉取（Gist → 本地，覆盖本地）</button>
      </div>
      <p class="sync-note">上传：把当前 iMac/MacBook 的渠道 + 客户推到你的私有 Gist。拉取：把 Gist 里的最新数据覆盖到当前设备。建议「改完数据 → 上传；换设备 → 拉取」。</p>
    </div>
  </div>`;
}

async function gistPush() {
  const s = S.sync || {};
  if (!s.token) return toast('请先在「保存令牌」里填写 GitHub 令牌');
  const payload = {
    channels: S.channels || [],
    customers: S.customers || [],
    updatedAt: new Date().toISOString(),
  };
  const filename = 'aih-biz-sync.json';
  const body = { public: false, files: { [filename]: { content: JSON.stringify(payload, null, 2) } } };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token };
  try {
    let url = 'https://api.github.com/gists';
    let method = 'POST';
    if (s.gistId) { url = 'https://api.github.com/gists/' + s.gistId; method = 'PATCH'; }
    toast('正在上传到 GitHub…');
    const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err.message || res.statusText) + (res.status === 401 ? '（令牌无效或无 gist 权限）' : ''));
    }
    const data = await res.json();
    S.sync = { token: s.token, gistId: data.id, lastSync: new Date().toISOString() };
    saveLS(LS.sync, S.sync);
    toast('☁️ 已上传到云端，Gist ID: ' + data.id);
    render();
  } catch (e) {
    toast('上传失败：' + e.message);
  }
}

async function gistPull() {
  const s = S.sync || {};
  if (!s.token) return toast('请先填写 GitHub 令牌');
  if (!s.gistId) return toast('没有 Gist ID：请先在一台设备「上传」一次');
  if (!confirm('从云端拉取将用云端数据覆盖当前设备的本地数据，确定？')) return;
  try {
    toast('正在从 GitHub 拉取…');
    const res = await fetch('https://api.github.com/gists/' + s.gistId, { headers: { Authorization: 'Bearer ' + s.token } });
    if (!res.ok) throw new Error(res.statusText + (res.status === 401 ? '（令牌无效）' : ''));
    const data = await res.json();
    const file = data.files && data.files['aih-biz-sync.json'];
    if (!file || !file.content) throw new Error('Gist 中没有同步文件');
    const payload = JSON.parse(file.content);
    S.channels = Array.isArray(payload.channels) ? payload.channels : (S.channels || null);
    S.customers = Array.isArray(payload.customers) ? payload.customers : (S.customers || []);
    saveLS(LS.channels, S.channels);
    saveLS(LS.customers, S.customers);
    S.sync = { ...s, lastSync: new Date().toISOString() };
    saveLS(LS.sync, S.sync);
    toast('⬇️ 已从云端拉取，本地已对齐');
    render();
  } catch (e) {
    toast('拉取失败：' + e.message);
  }
}

/* --------------------------------- 主渲染 -------------------------------- */

function render() {
  const app = $('#app');
  if (!S.data) {
    app.innerHTML = `<div class="boot"><div class="boot-mark">AI</div><p>正在载入今日要闻…</p></div>`;
    return;
  }
  const panel = {
    feed: renderFeed,
    profile: renderProfile,
    weekly: renderWeekly,
    map: renderMap,
    bm: renderBm,
    gl: renderGl,
    arch: renderArch,
    biz: renderBiz,
  }[S.tab] || renderFeed;

  const d = S.data;
  const stale = d.date !== bjDateKey();
  app.innerHTML = `
    ${renderTopbar()}
    <div class="wrap">
      <main>
        ${renderHero()}
        ${renderTabs()}
        <section class="panel on">${panel()}</section>
      </main>
      <footer>
        数据抓取自 ${d.stats?.sourceOk ?? 0} 个公开信息源 · 最近更新 ${esc(absTime(d.generatedAt))}（北京时间）
        ${stale ? '<br><span style="color:var(--warn)">⚠ 今日 9 点数据尚未更新，可在 9 点后点击右上角刷新</span>' : ''}
        <br>本站内容为公开资讯聚合，仅用于学习与产业观察，不构成任何投资建议。
      </footer>
    </div>`;
  updateCountdown();
  if (S.tab === 'biz' && S.bizTab === 'calc') setTimeout(calcrecompute, 0);
  if (S.tab === 'biz' && S.bizTab === 'quote') setTimeout(quoteCompute, 0);
}

/* ------------------------------ 交互：动作分发 --------------------------- */

function snapshot(it) {
  return {
    id: it.id, title: it.title, titleZh: it.titleZh || '', url: it.url,
    source: it.source, region: it.region, publishedAt: it.publishedAt,
    topics: it.topics || [], difficulty: it.difficulty,
    plain: it.plain || '', why: it.why || '',
    savedAt: new Date().toISOString(), note: '',
  };
}

function findItem(id) {
  const all = [...itemsForToday(), ...(S.archData?.items || [])];
  return all.find((i) => i.id === id) || null;
}

const actions = {
  tab(el) {
    S.tab = el.dataset.tab;
    if (S.tab === 'gl' || S.tab === 'feed') S.q = '';
    saveLS(LS.pref, { ...loadLS(LS.pref, {}), tab: S.tab });
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  region(el) {
    S.region = el.dataset.v;
    saveLS(LS.pref, { ...loadLS(LS.pref, {}), region: S.region });
    render();
  },
  topic(el) {
    const v = el.dataset.v;
    S.topics.has(v) ? S.topics.delete(v) : S.topics.add(v);
    render();
  },
  diff(el) { S.diff = el.dataset.v; render(); },
  reset() { S.region = 'ALL'; S.topics.clear(); S.diff = 'ALL'; S.q = ''; render(); },
  toggleview() { S.compact = !S.compact; render(); },
  regionmore(el) {
    const v = el.dataset.v;
    S.expandedRegions.has(v) ? S.expandedRegions.delete(v) : S.expandedRegions.add(v);
    render();
  },
  expand(el) { S.expandedCards.add(el.dataset.id); render(); },
  bm(el) {
    const id = el.dataset.id;
    const i = S.bookmarks.findIndex((b) => b.id === id);
    if (i >= 0) {
      S.bookmarks.splice(i, 1);
      toast('已移出收藏夹');
    } else {
      const it = findItem(id);
      if (!it) return toast('找不到这条内容');
      S.bookmarks.unshift(snapshot(it));
      toast('已收藏，可在「收藏夹」查看');
    }
    saveLS(LS.bm, S.bookmarks);
    render();
  },
  read(el) {
    const id = el.dataset.id;
    S.read.has(id) ? S.read.delete(id) : S.read.add(id);
    saveLS(LS.read, [...S.read]);
    render();
  },
  week(el) {
    const k = el.dataset.k;
    if (S.progress[k]) delete S.progress[k]; else S.progress[k] = Date.now();
    saveLS(LS.prog, S.progress);
    render();
  },
  month(el) { el.parentElement.classList.toggle('open'); },
  profile(el) {
    S.profileSel = el.dataset.v;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  week(el) {
    S.weekIssue = Number(el.dataset.v) || 0;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  glossary(el) {
    S.tab = 'gl';
    S.q = '';
    render();
    const id = el.dataset.term;
    const target = document.getElementById(`term-${id}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1800);
    }
  },
  async arch(el) {
    const date = el.dataset.v;
    S.archDate = date;
    S.archData = null;
    render();
    const d = await getJSON(`./data/archive/${date}.json`);
    if (d && S.archDate === date) { S.archData = d; render(); }
  },
  bmexport(el) {
    const fmt = el.dataset.fmt;
    let text, type, ext;
    if (fmt === 'json') {
      text = JSON.stringify(S.bookmarks, null, 2);
      type = 'application/json'; ext = 'json';
    } else {
      const groups = {};
      S.bookmarks.forEach((b) => {
        const g = REGION_META[b.region]?.name || '未分类';
        (groups[g] ||= []).push(b);
      });
      text = `# AI 瞭望台 · 收藏夹\n\n导出时间：${absTime(new Date().toISOString())}\n共 ${S.bookmarks.length} 条\n\n`;
      for (const [g, arr] of Object.entries(groups)) {
        text += `## ${g}\n\n`;
        arr.forEach((b) => {
          text += `### ${b.title}\n`;
          if (b.titleZh && b.titleZh !== b.title) text += `> ${b.titleZh}\n`;
          if (b.plain) text += `\n**白话解读**：${b.plain}\n`;
          if (b.why) text += `\n**为什么重要**：${b.why}\n`;
          if (b.note) text += `\n**我的笔记**：${b.note}\n`;
          text += `\n来源：${b.source} · ${b.publishedAt ? absTime(b.publishedAt) : ''}\n链接：${b.url}\n\n---\n\n`;
        });
      }
      type = 'text/markdown'; ext = 'md';
    }
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ai-horizon-bookmarks.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出收藏夹');
  },
  bmclear() {
    if (!confirm(`确定清空全部 ${S.bookmarks.length} 条收藏？此操作不可撤销。`)) return;
    S.bookmarks = [];
    saveLS(LS.bm, []);
    render();
    toast('收藏夹已清空');
  },
  bizsub(el) {
    S.bizTab = el.dataset.v;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  calcfill(el) {
    const all = [...(S.channels || []), ...(S.models?.models || [])];
    const m = all.find((x) => x.id === el.dataset.id);
    if (!m) return toast('找不到该模型');
    S.calc = { in: m.priceIn, out: m.priceOut, margin: S.calc.margin, vin: S.calc.vin, vout: S.calc.vout };
    S.bizTab = 'calc';
    render();
    toast(`已带入 ${m.vendor} ${m.model} 的上游价`);
  },
  calcreset() {
    S.calc = { in: 2, out: 8, margin: 30, vin: 100, vout: 100 };
    render();
  },
  chimport() {
    if (!S.models?.models?.length) return toast('示例数据未载入');
    S.channels = S.models.models.map((m) => ({
      id: m.id, vendor: m.vendor, model: m.model, tier: m.tier, context: m.context,
      priceIn: m.priceIn, priceOut: m.priceOut, latency: m.latency, quality: m.quality,
      langs: m.langs || [], overseas: m.overseas, note: '',
    }));
    saveLS(LS.channels, S.channels);
    toast('已导入示例到台账，现在可编辑');
    render();
  },
  chclear() {
    if (!confirm('清空我的台账、回到示例数据？此操作不可撤销。')) return;
    S.channels = null; S.bizEditCh = null;
    saveLS(LS.channels, null);
    render(); toast('已回到示例数据');
  },
  chexport() {
    const text = JSON.stringify(S.channels, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aih-channels.json'; a.click(); URL.revokeObjectURL(a.href);
    toast('已导出渠道台账');
  },
  chimportfile(el) {
    const inp = el.parentElement.querySelector('[data-act="chfile"]');
    if (inp) inp.click();
  },
  cuexport() {
    const cus = S.customers || [];
    const text = JSON.stringify(cus, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aih-customers.json'; a.click(); URL.revokeObjectURL(a.href);
    toast('已导出客户数据');
  },
  cuimportfile(el) {
    const inp = el.parentElement.querySelector('[data-act="cufile"]');
    if (inp) inp.click();
  },
  syncsave() {
    const token = ($('#sync-token')?.value || '').trim();
    const gistId = ($('#sync-gist')?.value || '').trim();
    if (!token) return toast('令牌不能为空');
    S.sync = { token, gistId: gistId || (S.sync?.gistId || ''), lastSync: S.sync?.lastSync || '' };
    saveLS(LS.sync, S.sync);
    toast('已保存令牌（仅存本机浏览器）');
    render();
  },
  syncupload() { gistPush(); },
  syncdownload() { gistPull(); },
  chedit(el) { S.bizEditCh = el.dataset.id; render(); setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 30); },
  chcancel() { S.bizEditCh = null; render(); },
  chdel(el) {
    if (!confirm('删除该渠道？')) return;
    S.channels = S.channels.filter((x) => x.id !== el.dataset.id);
    saveLS(LS.channels, S.channels); render(); toast('已删除');
  },
  chsave() {
    const form = $('.ch-form');
    if (!form) return;
    const g = (n) => form.querySelector(`[name="${n}"]`)?.value?.trim() ?? '';
    const num = (n) => { const v = parseFloat(g(n)); return isNaN(v) ? 0 : v; };
    const id = S.bizEditCh || ('ch_' + Date.now());
    const rec = {
      id,
      vendor: g('vendor') || '未命名', model: g('model') || '未命名模型', tier: g('tier') || 'standard',
      context: g('context') || '—',
      priceIn: num('priceIn'), priceOut: num('priceOut'), latency: num('latency'),
      quality: Math.max(0, Math.min(5, Math.round(num('quality')))),
      langs: g('langs') ? g('langs').split(/[,，/]/).map((s) => s.trim()).filter(Boolean) : [],
      overseas: g('overseas'), note: g('note') || '',
    };
    if (!S.channels) S.channels = [];
    const i = S.channels.findIndex((x) => x.id === id);
    if (i >= 0) S.channels[i] = rec; else S.channels.push(rec);
    saveLS(LS.channels, S.channels);
    S.bizEditCh = null;
    render(); toast('已保存渠道');
  },
  cuedit(el) { S.bizEditCu = el.dataset.id; render(); setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 30); },
  cucancel() { S.bizEditCu = null; render(); },
  cudel(el) {
    if (!confirm('删除该客户？')) return;
    S.customers = (S.customers || []).filter((x) => x.id !== el.dataset.id);
    saveLS(LS.customers, S.customers); render(); toast('已删除');
  },
  cusave() {
    const form = $('.ch-form');
    if (!form) return;
    const g = (n) => form.querySelector(`[name="${n}"]`)?.value?.trim() ?? '';
    const num = (n) => { const v = parseFloat(g(n)); return isNaN(v) ? 0 : v; };
    const id = S.bizEditCu || ('cu_' + Date.now());
    const rec = {
      id, name: g('name') || '未命名客户', region: g('region') || '东南亚', contact: g('contact'),
      model: form.querySelector('[name="model"]')?.value || '', monthly: num('monthly'), price: num('price'),
      status: g('status') || '潜在', note: g('note') || '',
    };
    if (!S.customers) S.customers = [];
    const i = S.customers.findIndex((x) => x.id === id);
    if (i >= 0) S.customers[i] = rec; else S.customers.push(rec);
    saveLS(LS.customers, S.customers);
    S.bizEditCu = null; render(); toast('已保存客户');
  },
  qcopy(el) {
    quoteCompute();
    const q = S._quote; if (!q) return toast('请先填写报价参数');
    const text = el.dataset.lang === 'en' ? quoteTextEN(q) : quoteTextZH(q);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('已复制' + (el.dataset.lang === 'en' ? '英文' : '中文') + '报价')).catch(() => toast('复制失败，请手动选择'));
    else toast('当前环境不支持复制，请点「下载」');
  },
  qdown() {
    quoteCompute();
    const q = S._quote; if (!q) return toast('请先填写报价参数');
    const text = '【中文】\n' + quoteTextZH(q) + '\n\n【English】\n' + quoteTextEN(q);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `quote-${q.cust || 'client'}.txt`; a.click(); URL.revokeObjectURL(a.href);
    toast('已下载报价单');
  },
};

/* 通用：从本地文件导入台账/客户（在设备间搬运数据） */
function readBizFile(input, kind) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      let arr = Array.isArray(data) ? data : (data[kind] || data.channels || data.customers || data.models || []);
      if (!Array.isArray(arr)) throw new Error('文件不是有效的数组');
      if (kind === 'channels') {
        S.channels = arr;
        saveLS(LS.channels, S.channels);
        toast(`已导入 ${arr.length} 条渠道到台账`);
      } else {
        S.customers = arr;
        saveLS(LS.customers, S.customers);
        toast(`已导入 ${arr.length} 条客户`);
      }
      render();
    } catch (err) {
      toast('导入失败：' + err.message + '（请确保是本站导出的 JSON）');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

/* -------------------------------- 事件绑定 ------------------------------ */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'search') return;
  if (el.tagName === 'SELECT') return;

  if (actions[act]) {
    e.preventDefault();
    actions[act](el);
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset?.act === 'search') {
    S.q = el.value;
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      const pos = el.selectionStart;
      render();
      const n = $('[data-act="search"]');
      if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
    }, 320);
  }
  if (el.dataset?.act === 'bmmemo') {
    const b = S.bookmarks.find((x) => x.id === el.dataset.id);
    if (b) { b.note = el.value; clearTimeout(el._t2); el._t2 = setTimeout(() => saveLS(LS.bm, S.bookmarks), 500); }
  }
  if (el.dataset?.act === 'calc') { calcrecompute(); }
  if (el.dataset?.act === 'quote') { quoteCompute(); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset?.act === 'sort') { S.sort = el.value; render(); }
  else if (el.dataset?.act === 'biztier') { S.bizTier = el.value; render(); }
  else if (el.dataset?.act === 'bizsort') { S.bizSort = el.value; render(); }
  else if (el.dataset?.act === 'quote') { quoteCompute(); }
  else if (el.dataset?.act === 'chfile') { readBizFile(el, 'channels'); }
  else if (el.dataset?.act === 'cufile') { readBizFile(el, 'customers'); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.q) { S.q = ''; render(); }
});

/* ------------------------------ 刷新与倒计时 ---------------------------- */

function updateCountdown() {
  const cd = $('#countdown');
  if (!cd || !S.nextRefreshAt) return;
  let ms = S.nextRefreshAt.getTime() - Date.now();
  if (ms <= 0) { cd.textContent = '00:00:00'; return; }
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  cd.textContent = `${h}:${m}:${ss}`;
}

async function doRefresh(silent = false) {
  const btn = $('#btnRefresh');
  btn?.classList.add('spin');
  if (!silent) toast('正在刷新数据…');
  const [data, briefing, archive, profiles, weekly] = await Promise.all([
    getJSON('./data/news-latest.json'),
    getJSON('./data/briefing.json'),
    getJSON('./data/archive-index.json'),
    getJSON('./data/profiles.json'),
    getJSON('./data/weekly.json'),
  ]);
  if (data) S.data = data;
  if (briefing) S.briefing = briefing.items || {};
  if (archive) S.archive = archive;
  if (profiles) S.profiles = profiles;
  if (weekly) S.weekly = weekly;
  computeNextRefresh();
  render();
  btn?.classList.remove('spin');
  if (!silent) {
    const fresh = S.data && S.data.date === bjDateKey();
    toast(fresh ? `已更新 ${S.data.items.length} 条要闻` : '后台尚未生成今日数据（9 点后自动更新）');
  }
}

$('#app')?.addEventListener?.('click', () => {});

document.addEventListener('click', (e) => {
  if (e.target.closest('#btnRefresh')) doRefresh();
  if (e.target.closest('#btnTheme')) {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    saveLS(LS.theme, cur);
    $('#btnTheme')?.setAttribute('title', cur === 'dark' ? '切换到浅色' : '切换到深色');
  }
});

function tick() {
  updateCountdown();
  // 到点自动刷新
  if (S.nextRefreshAt && Date.now() >= S.nextRefreshAt.getTime()) {
    computeNextRefresh();
    doRefresh(true);
  }
}

/* --------------------------------- 启动 --------------------------------- */

async function boot() {
  const saved = loadLS(LS.theme, null);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? 'dark' : 'light');

  await loadAll();
  render();
  setInterval(tick, 1000);

  // 每 10 分钟静默校验一次，若后台已生成新数据则自动更新
  setInterval(async () => {
    const d = await getJSON('./data/news-latest.json');
    if (d && (!S.data || d.generatedAt !== S.data.generatedAt)) {
      S.data = d;
      render();
      toast('检测到新数据，已自动更新');
    }
  }, 600000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();

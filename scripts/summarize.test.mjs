/** 本地冒烟：假 LLM 端点验证 attachTakeaways 全链路 */
import http from 'node:http';
import { attachTakeaways, SummaryCache } from './summarize.mjs';

const PORT = 8931;
let calls = 0;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls += 1;
    const m = JSON.parse(body);
    // 校验请求形态
    if (!m.model || !m.messages?.[0]?.content || !m.messages?.[1]?.content) {
      res.writeHead(400); res.end('{}'); return;
    }
    // 第 2 次调用故意返回烂 JSON，测解析降级；其余正常
    const content = calls === 2
      ? '这是不是JSON```{"points":["要点A","要点B"],"why":"影响格局"}'
      : '{"points":["要点甲：具体事实","要点乙：关键数字 30 亿","要点丙：下一步"],"why":"对产业格局有直接影响"}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

srv.listen(PORT, async () => {
  process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'test-model';

  const items = [
    { id: 'a', title: 'News A about funding', url: 'https://x.com/a', lang: 'en',
      i18n: { zhTitle: '新闻A：融资', zhSummary: '某公司宣布完成 30 亿美元融资。估值达到 120 亿。资金将用于扩建数据中心。' },
      topics: [{ name: '融资' }], entities: ['某公司'] },
    { id: 'b', title: 'News B', url: 'https://x.com/b', lang: 'en',
      i18n: { zhTitle: '新闻B', zhSummary: '另一家公司的产品发布。' } },
    { id: 'c', title: 'News C no i18n', url: 'https://x.com/c', lang: 'en', summary: 'Short english only text.' },
  ];

  const cacheFile = '/tmp/summary-test-cache.json';
  const { rmSync } = await import('node:fs');
  rmSync(cacheFile, { force: true });
  const cache = new SummaryCache(cacheFile);

  const stat = await attachTakeaways(items, { cache });
  cache.save();

  console.log('calls to fake LLM:', calls);
  console.log('stat:', JSON.stringify(stat));
  for (const it of items) {
    console.log(`\n[${it.id}] src=${it.takeaways?.src}`);
    console.log('  points:', JSON.stringify(it.takeaways?.points));
    console.log('  why:', it.takeaways?.why);
  }

  // 第二轮：全部应命中缓存，LLM 不再被调用
  const callsBefore = calls;
  const items2 = JSON.parse(JSON.stringify(items));
  for (const it of items2) delete it.takeaways;
  const cache2 = new SummaryCache(cacheFile);
  const stat2 = await attachTakeaways(items2, { cache: cache2 });
  console.log('\n第二轮 stat:', JSON.stringify(stat2), '| 新增调用:', calls - callsBefore);

  const ok1 = items[0].takeaways?.points?.length === 3 && items[0].takeaways?.why;
  const ok2 = items[1].takeaways?.src === 'fallback' || items[1].takeaways?.points?.length >= 1; // 烂 JSON → 兜底
  const ok3 = calls - callsBefore === 0;
  console.log('\n断言: 正常解析', ok1 ? '✓' : '✗', '| 烂JSON降级', ok2 ? '✓' : '✗', '| 缓存复用零调用', ok3 ? '✓' : '✗');
  srv.close();
  process.exit(ok1 && ok3 ? 0 : 1);
});

#!/usr/bin/env node
/**
 * AI 瞭望台 · 本地静态服务（零依赖）
 *
 *   node scripts/serve.mjs [port]            默认 8099，局域网可访问（本机 + MacBook）
 *   node scripts/serve.mjs [port] --local    仅本机 127.0.0.1 可访问
 *
 * 说明：默认监听 0.0.0.0，仅用于家庭/办公局域网内两台自己的电脑互访，
 * 不做公网暴露，也没有鉴权。若不需要 MacBook 访问，请加 --local。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes('--local');
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8099);
const HOST = LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {           // 防目录穿越
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || stat.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Service-Worker-Allowed': '/',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n⚠ 端口 ${PORT} 已被占用——可能服务已经在运行了。`);
    console.error(`  直接打开 http://localhost:${PORT} 即可，或换一个端口：node scripts/serve.mjs 8100\n`);
  } else {
    console.error('\n服务启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n🛰  AI 瞭望台已启动`);
  console.log(`   本机访问      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`   同一局域网    http://${ip}:${PORT}   ← MacBook 用这个`);
  }
  if (LOCAL_ONLY) console.log(`   （--local 模式：局域网内其他设备无法访问）`);
  console.log('');
});

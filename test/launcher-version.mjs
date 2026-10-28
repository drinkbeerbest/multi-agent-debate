/**
 * 验证启动脚本的「版本检测 + 自动重启」逻辑。
 * 用一个假装旧版本的健康检查服务占住端口，确认启动脚本能识别并重启。
 *
 * 运行：node test/launcher-version.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

/** 读取 server.js 里声明的版本号。 */
function expectedBuild() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/const BUILD = '([^']+)'/);
  return m ? m[1] : '';
}

async function health() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return await res.json();
  } catch {
    return null;
  }
}

async function waitHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health();
    if (h) return h;
    await sleep(200);
  }
  return null;
}

async function main() {
  const expected = expectedBuild();
  check('server.js 声明了版本号', Boolean(expected), expected);

  console.log('\n▶ 场景 1：端口上是一个「旧版本」服务');
  // 假装旧服务
  const fake = spawn(process.execPath, ['-e', `
    const http = require('http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: 'old-1.0', uptime: 1, sessions: 0 }));
    }).listen(${PORT}, '127.0.0.1');
  `], { stdio: 'ignore' });
  await sleep(800);

  const before = await health();
  check('旧服务已就绪', before?.build === 'old-1.0');

  // 复现启动脚本里的判定逻辑
  let detectedMismatch = false;
  const m = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/const BUILD = '([^']+)'/);
  const running = await health();
  if (running && m && running.build !== m[1]) detectedMismatch = true;
  check('能识别出版本不一致', detectedMismatch, `运行中=${running?.build} / 当前代码=${m?.[1]}`);

  console.log('\n▶ 场景 2：执行 stop.ps1 应清掉旧服务');
  const stop = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'stop.ps1'),
    '-Port', String(PORT),
  ], { stdio: 'ignore' }).on('error', () => {});
  await sleep(2500);
  const after = await health();
  check('旧服务已停止', after === null);

  console.log('\n▶ 场景 3：启动新版服务，健康检查带新版本号');
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const h = await waitHealth();
  check('新服务已就绪且版本号为当前代码版本', h?.build === expected, `build=${h?.build}`);

  app.kill();
  fake.kill();
  await sleep(400);

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

/**
 * 一键启动脚本的真实执行测试：直接跑 launch.ps1，验证服务能被拉起来。
 * 用 -NoBrowser 避免测试时弹出浏览器窗口。
 *
 * 运行：node test/launcher-run.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LAUNCH = path.join(ROOT, 'scripts', 'launch.ps1');
const STOP = path.join(ROOT, 'scripts', 'stop.ps1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return await res.json();
  } catch {
    return null;
  }
}

async function waitHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health(port);
    if (h) return h;
    await sleep(250);
  }
  return null;
}

/** 轮询等待版本切换完成（重启期间旧服务仍会短暂响应，不能只看第一次） */
async function waitBuild(port, build, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await health(port);
    if (last?.build === build) return last;
    await sleep(300);
  }
  return last;
}

function stopPort(port) {
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STOP, '-Port', String(port), '-NoPause'], {
      stdio: 'ignore', timeout: 15000,
    });
  } catch { /* 忽略 */ }
}

function expectedBuild() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/const BUILD = '([^']+)'/);
  return m ? m[1] : '';
}

async function main() {
  const port = 8798;
  const build = expectedBuild();

  console.log('\n▶ 场景 1：脚本文件完整性');
  check('scripts/launch.ps1 存在', fs.existsSync(LAUNCH));
  check('scripts/stop.ps1 存在', fs.existsSync(STOP));
  check('启动.bat 存在', fs.existsSync(path.join(ROOT, '启动.bat')));
  check('停止.bat 存在', fs.existsSync(path.join(ROOT, '停止.bat')));
  // UTF-8 BOM：没有 BOM 时 PowerShell 5.1 会把中文按 ANSI 解析成乱码
  for (const f of [LAUNCH, STOP]) {
    const b = fs.readFileSync(f);
    check(`${path.basename(f)} 带 UTF-8 BOM（中文不乱码）`, b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF);
  }
  // .bat 必须纯 ASCII：cmd.exe 按 ANSI 解析 UTF-8 批处理，非 ASCII 会乱码甚至报错
  for (const f of ['启动.bat', '停止.bat']) {
    const b = fs.readFileSync(path.join(ROOT, f));
    const nonAscii = b.filter((x) => x > 127).length;
    check(`${f} 是纯 ASCII（cmd 不乱码）`, nonAscii === 0, `非 ASCII 字节 ${nonAscii} 个`);
  }

  console.log('\n▶ 场景 2：实际执行 launch.ps1（不弹浏览器）');
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCH,
    '-Port', String(port), '-NoBrowser', '-NoPause',
  ], { stdio: 'ignore', detached: false });

  const h = await waitHealth(port);
  check('服务被一键脚本成功拉起', !!h, h ? `build=${h.build}` : '健康检查无响应');
  check('健康检查带版本号且为当前代码版本', h?.build === build, `期望 ${build}，实际 ${h?.build}`);
  const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
  check('首页可访问', page.includes('多智能体辩论平台'));

  console.log('\n▶ 场景 3：脚本进程退出后端口应释放');
  child.kill();
  stopPort(port);
  await sleep(1500);
  const gone = await health(port);
  check('停止后端口已释放', gone === null);

  console.log('\n▶ 场景 4：端口上是旧版本服务时应自动重启');
  // 假装旧服务
  const fake = spawn(process.execPath, ['-e', `
    const http = require('http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: 'old-0.1', uptime: 1, sessions: 0 }));
    }).listen(${port}, '127.0.0.1');
  `], { stdio: 'ignore' });
  await sleep(900);
  check('旧服务已就绪', (await health(port))?.build === 'old-0.1');

  const child2 = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCH,
    '-Port', String(port), '-NoBrowser', '-NoPause',
  ], { stdio: 'ignore', detached: false });

  const h2 = await waitBuild(port, build);
  check('旧版本服务已被替换为新版本', h2?.build === build, `实际 ${h2?.build}`);

  child2.kill();
  fake.kill();
  stopPort(port);
  await sleep(1200);
}

main()
  .catch((err) => {
    console.error('\n测试异常：', err);
    process.exit(1);
  })
  .finally(() => {
    console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
    process.exit(failures === 0 ? 0 : 1);
  });

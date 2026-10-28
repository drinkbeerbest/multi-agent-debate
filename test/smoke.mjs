/**
 * 冒烟测试：自起私有实例跑一遍真实链路（配置 → 开辩 → SSE → 停止 → 记录）。
 *
 * 用法：node test/smoke.mjs
 *
 * 重要：本测试曾经「对着 8787 上已在运行的实例」发请求——那往往是用户自己的
 * 真实服务，测试写入的 mock 配置会污染用户配置（服务内存里留下测试值，
 * 即使退出时还原了文件，运行中的服务随后又把测试值写回磁盘）。
 * 因此现在与 e2e.mjs 一致：自己 spawn mock + 服务端，用私有端口，绝不碰 8787。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

const PORT = 8795;
const MOCK_PORT = 8906;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const model = (name, id) => ({
  name, protocol: 'openai', baseUrl: `${MOCK}/v1`, apiKey: 'sk-local-mock',
  model: id, maxTokens: 512,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 双保险：虽然用私有实例，仍无条件还原 settings.json，防止任何意外写入。
  const originalSettings = fs.existsSync(SETTINGS_FILE)
    ? fs.readFileSync(SETTINGS_FILE, 'utf8')
    : null;
  process.on('exit', () => {
    try {
      if (originalSettings === null) {
        if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
      } else {
        fs.writeFileSync(SETTINGS_FILE, originalSettings, 'utf8');
      }
    } catch { /* 还原失败不阻塞退出 */ }
  });

  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-provider.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore',
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  const cleanup = () => { for (const p of [app, mock]) { try { p.kill(); } catch { /* ignore */ } } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let up = null;
  for (let i = 0; i < 40 && !up; i += 1) {
    await sleep(250);
    up = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  }
  if (!up) { cleanup(); throw new Error('私有实例未能启动'); }
  console.log(`\n▶ 目标实例：${BASE}（私有，测试自起）`);
  check('服务在线', up.ok === true, `uptime=${up.uptime?.toFixed(1)}s`);

  const page = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => '');
  check('首页可访问', page.includes('多智能体辩论平台'));
  check('前端脚本可访问', await fetch(`${BASE}/app.js`).then((r) => r.ok).catch(() => false));

  const saveRes = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pro: model('正方模型·DeepSeek', 'mock-pro'),
      con: model('反方模型·Qwen', 'mock-con'),
      debate: { rounds: 2, wordLimit: 300, style: 'standard', judgeEnabled: true, judgeSource: 'pro' },
    }),
  });
  const saved = await saveRes.json();
  check('两个模型 API 配置已保存', saved.ok === true);
  check('API Key 脱敏', saved.settings.pro.apiKey === '' && saved.settings.pro.hasApiKey === true);

  const testRes = await fetch(`${BASE}/api/settings/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ side: 'con', model: { ...model('x', 'mock-con'), apiKey: '' } }),
  });
  const testData = await testRes.json();
  check('连通性测试通过', testData.ok === true, `${testData.latencyMs}ms`);

  const startRes = await fetch(`${BASE}/api/debate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: '人工智能生成内容应当强制标注',
      pro: model('正方模型·DeepSeek', 'mock-pro'),
      con: model('反方模型·Qwen', 'mock-con'),
      debate: { rounds: 2, wordLimit: 300, style: 'standard', judgeEnabled: true, judgeSource: 'pro' },
    }),
  });
  const start = await startRes.json();
  check('辩论已启动', start.ok === true, start.sessionId);

  const events = [];
  const transcript = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('事件流超时')), 90000);
    (async () => {
      const res = await fetch(`${BASE}/api/debate/${start.sessionId}/events`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const evt = JSON.parse(payload);
          events.push(evt);
          if (evt.type === 'done') {
            clearTimeout(timer);
            resolve(evt.transcript || []);
            return;
          }
        }
      }
      clearTimeout(timer);
      resolve([]);
    })().catch((err) => { clearTimeout(timer); reject(err); });
  });

  const n = (t) => events.filter((e) => e.type === t).length;
  check('事件流完整（session/phase/turn_start/delta/turn_end/done）',
    n('session') === 1 && n('phase') >= 2 && n('turn_start') >= 5 && n('delta') > 40 && n('turn_end') >= 4 && n('done') === 1,
    `turn_start=${n('turn_start')} delta=${n('delta')}`);
  check('2 轮交锋 → 4 段发言 + 1 段点评 = 5 条记录',
    transcript.length === 5, `实际 ${transcript.length}`);
  check('正反方发言次数对称（各 2 次）',
    transcript.filter((t) => t.side === 'pro').length === 2 && transcript.filter((t) => t.side === 'con').length === 2);
  check('含评委点评', transcript.some((t) => t.phase === 'judge'));
  check('每段发言均有实质内容', transcript.every((t) => (t.text || '').length > 30));

  const sess = await fetch(`${BASE}/api/debate/${start.sessionId}`).then((r) => r.json());
  check('会话记录可回查', sess.ok === true && sess.transcript.length === 5, `state=${sess.state}`);

  const stop = await fetch(`${BASE}/api/debate/${start.sessionId}/stop`, { method: 'POST' }).then((r) => r.json());
  check('停止接口可用', stop.ok === true);

  cleanup();
  console.log(failures === 0 ? '\n🎉 冒烟测试全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err);
  process.exit(1);
});

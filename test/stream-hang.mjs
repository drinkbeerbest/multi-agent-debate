/**
 * 「模型发完内容却不关闭连接」场景的回归测试。
 *
 * 真实厂商在流式输出结束后经常保持长连接不关闭，如果不识别协议自身的结束信号、
 * 也不设空闲超时，界面就会永远卡在最后一句（评委点评之后卡死就是这个原因）。
 *
 * 用例 A：厂商发 finish_reason 但不关连接 → 应立刻判定结束
 * 用例 B：厂商既不发结束信号也不关连接 → 应由空闲超时兜底结束，并给出提示
 *
 * 运行：node test/stream-hang.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

async function waitFor(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 继续等待 */ }
    await sleep(200);
  }
  return false;
}

/**
 * 跑一场辩论，收集事件，返回 { done, elapsed, events }
 */
async function runDebate({ mockPort, appPort, idleTimeout, maxTokens = 512 }) {
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-provider.js')], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_HANG: process.env.MOCK_HANG || 'finish' },
    stdio: 'ignore',
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DEBATE_IDLE_TIMEOUT: String(idleTimeout) },
    stdio: 'ignore',
  });

  try {
    if (!(await waitFor(`http://127.0.0.1:${mockPort}/`))) throw new Error('mock 未启动');
    if (!(await waitFor(`http://127.0.0.1:${appPort}/api/health`))) throw new Error('平台未启动');
    const base = `http://127.0.0.1:${appPort}`;
    const model = (name, id) => ({
      name, protocol: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'sk-mock', model: id, maxTokens,
    });

    const startRes = await fetch(`${base}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: '测试辩题',
        pro: model('正方', 'mock-pro'),
        con: model('反方', 'mock-con'),
        debate: { rounds: 1, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const start = await startRes.json();
    if (!start.ok) throw new Error(start.message || '启动失败');

    const started = Date.now();
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 done 超时')), 40000);
      (async () => {
        const res = await fetch(`${base}/api/debate/${start.sessionId}/events`);
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
              resolve();
              return;
            }
          }
        }
        clearTimeout(timer);
        resolve();
      })().catch((err) => { clearTimeout(timer); reject(err); });
    });

    return { done: events.find((e) => e.type === 'done'), elapsed: Date.now() - started, events };
  } finally {
    mock.kill();
    app.kill();
    await sleep(400);
  }
}

async function main() {
  let backup = null;
  if (fs.existsSync(SETTINGS_FILE)) backup = fs.readFileSync(SETTINGS_FILE, 'utf8');

  console.log('\n▶ 用例 A：厂商发完内容后保持连接不关闭（带 finish_reason）');
  process.env.MOCK_HANG = 'finish';
  const a = await runDebate({ mockPort: 8903, appPort: 8793, idleTimeout: 20000 });
  check('辩论正常结束（收到 done）', !!a.done, `reason=${a.done?.reason}`);
  check('没有无限等待', a.elapsed < 15000, `耗时 ${a.elapsed}ms`);
  check('评委点评已产出', a.events.some((e) => e.type === 'judge_end'));
  check('未触发空闲兜底提示', !a.events.some((e) => e.type === 'notice'));

  console.log('\n▶ 用例 B：厂商既不发结束信号也不关连接（靠空闲超时兜底）');
  process.env.MOCK_HANG = 'silent';
  const b = await runDebate({ mockPort: 8904, appPort: 8794, idleTimeout: 3000 });
  check('辩论仍然正常结束（收到 done）', !!b.done, `reason=${b.done?.reason}`);
  check('由空闲超时及时收尾', b.elapsed < 20000, `耗时 ${b.elapsed}ms`);
  check('给出了截断提示', b.events.some((e) => e.type === 'notice'));
  check('评委点评仍已产出', b.events.some((e) => e.type === 'judge_end'));

  console.log('\n▶ 用例 C：请求的输出上限超过厂商限制（应自动降级重试）');
  process.env.MOCK_HANG = '';
  process.env.MOCK_MAX_TOKENS_LIMIT = '8192';
  const c = await runDebate({ mockPort: 8906, appPort: 8796, idleTimeout: 20000, maxTokens: 50000 });
  check('降级后辩论正常完成', !!c.done, `reason=${c.done?.reason}`);
  check('给出了输出上限被下调的提示', c.events.some((e) => e.type === 'notice'));
  check('评委点评仍已产出', c.events.some((e) => e.type === 'judge_end'));
  delete process.env.MOCK_MAX_TOKENS_LIMIT;

  if (backup !== null) fs.writeFileSync(SETTINGS_FILE, backup, 'utf8');
  else if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

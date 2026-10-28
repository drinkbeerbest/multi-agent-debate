/**
 * 插话链路自测：用户在辩论过程中发言 → 进入双方上下文 → 下一位发言者正面回应。
 *
 * 运行：node test/interject.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 8902;
const APP_PORT = 8792;
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

const model = (name, id) => ({
  name, protocol: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  apiKey: 'sk-mock', model: id, maxTokens: 512,
});

async function main() {
  let backup = null;
  if (fs.existsSync(SETTINGS_FILE)) backup = fs.readFileSync(SETTINGS_FILE, 'utf8');

  console.log('\n▶ 启动 Mock 模型服务与平台服务…');
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-provider.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'inherit',
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1' }, stdio: 'inherit',
  });

  try {
    check('Mock 服务启动', await waitFor(`http://127.0.0.1:${MOCK_PORT}/`));
    check('平台服务启动', await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`));
    const base = `http://127.0.0.1:${APP_PORT}`;

    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pro: model('正方模型', 'mock-pro'),
        con: model('反方模型', 'mock-con'),
        debate: { rounds: 1, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });

    const startRes = await fetch(`${base}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: '人工智能生成内容应当强制标注',
        pro: model('正方模型', 'mock-pro'),
        con: model('反方模型', 'mock-con'),
        debate: { rounds: 1, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const start = await startRes.json();
    check('辩论已启动', start.ok === true, start.sessionId);

    const events = [];
    let sent = false;
    let sentAfterDone = false;
    const transcript = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('事件流超时')), 90000);
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

            // 第一方刚开始发言就插话（保证插话落在该方的发言过程中）
            if (!sent && evt.type === 'turn_start') {
              sent = true;
              const r = await fetch(`${base}/api/debate/${start.sessionId}/say`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '你们都跑题了，请回到成本这个核心指标' }),
              });
              const sayData = await r.json();
              check('插话接口返回成功', sayData.ok === true);
            }

            // 辩论结束后再插话一次，验证可以追问
            if (!sentAfterDone && evt.type === 'done' && evt.reason === 'completed') {
              sentAfterDone = true;
              const r = await fetch(`${base}/api/debate/${start.sessionId}/say`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '最后追问一句：谁先让步' }),
              });
              const sayData = await r.json();
              check('结束后追问接口返回成功', sayData.ok === true);
            }

            // 收齐两次插话及其回应后再结束（发言记录在 turn_end 时才落库）
            const userCount = events.filter((e) => e.type === 'user_message').length;
            const replyCount = events.filter((e) => e.type === 'turn_end' && e.phase === 'reply').length;
            if (userCount >= 2 && replyCount >= 2) {
              clearTimeout(timer);
              const again = await fetch(`${base}/api/debate/${start.sessionId}`);
              const againData = await again.json();
              resolve(againData.transcript || []);
              return;
            }
          }
        }
        clearTimeout(timer);
        resolve([]);
      })().catch((err) => { clearTimeout(timer); reject(err); });
    });

    console.log('\n▶ 校验插话事件…');
    const userEvents = events.filter((e) => e.type === 'user_message');
    check('收到 2 条 user_message 事件', userEvents.length === 2, `实际 ${userEvents.length}`);
    check('插话文本正确', userEvents[0]?.text === '你们都跑题了，请回到成本这个核心指标');

    const replyTurns = events.filter((e) => e.type === 'turn_start' && e.phase === 'reply');
    check('产生了「回应插话」环节的发言', replyTurns.length >= 2, `reply 发言数=${replyTurns.length}`);

    // 关键回归：插话引发的回应也必须严格一人一句交替，不能同一方连说两次
    const speakerOrder = events
      .filter((e) => e.type === 'turn_start' && e.side !== 'judge')
      .map((e) => e.side);
    check('插话后仍然严格一人一句交替',
      speakerOrder.every((side, i) => i === 0 || side !== speakerOrder[i - 1]),
      speakerOrder.join(' → '));

    const replyEnds = events.filter((e) => e.type === 'turn_end' && e.phase === 'reply');
    check('回应内容里引用了用户的插话',
      replyEnds.some((e) => (e.text || '').includes('跑题了')),
      replyEnds.map((e) => (e.text || '').slice(0, 30)).join(' | '));

    console.log('\n▶ 校验辩论记录…');
    const userRecords = transcript.filter((t) => t.side === 'user');
    check('记录中保留了用户插话', userRecords.length === 2, `实际 ${userRecords.length}`);
    // pro(r1) + con(回应插话，顶替了原定的 con(r1)) + pro(结束后追问的回应) + 评委点评 + 2 条用户插话 = 6
    check('记录总条数 = 6', transcript.length === 6, `实际 ${transcript.length}`);
    check('评委点评仍然生成', transcript.some((t) => t.phase === 'judge'));
  } finally {
    mock.kill();
    app.kill();
    await sleep(300);
    if (backup !== null) fs.writeFileSync(SETTINGS_FILE, backup, 'utf8');
    else if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  }

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

/**
 * 自由聊天模式自测：不设辩题、不分正反方、不套规则、不产生评委点评。
 *
 * 运行：node test/chat-mode.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, DebateSession, MODES } from '../src/debate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 8905;
const APP_PORT = 8795;
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

async function main() {
  console.log('\n▶ 单元检查：聊天模式的系统提示词');
  const chatPrompt = buildSystemPrompt('pro', '', { mode: MODES.CHAT, label: 'Agent A', wordLimit: 300 });
  check('提示词不含「辩题」', !chatPrompt.includes('辩题'), chatPrompt.split('\n')[0]);
  check('提示词不含「正方/反方」立场', !/正方|反方/.test(chatPrompt));
  check('提示词不含规则清单（编号条目）', !/\n\s*\d+\./.test(chatPrompt));
  check('提示词含聊天说明', chatPrompt.includes('聊天'));
  check('提示词用的是 Agent A 而非模型昵称', chatPrompt.includes('Agent A') && !chatPrompt.includes('小红'));
  check('聊天提示词极简（不超过 2 行）', chatPrompt.split('\n').length <= 2, `实际 ${chatPrompt.split('\n').length} 行`);

  const debatePrompt = buildSystemPrompt('pro', '该不该用AI写作', { mode: MODES.DEBATE, wordLimit: 300 });
  check('辩论模式仍带辩题', debatePrompt.includes('该不该用AI写作'));

  console.log('\n▶ 单元检查：100 轮的排程');
  const cfg = { name: 'x', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', maxTokens: 128 };
  const session = new DebateSession({
    topic: '', mode: MODES.CHAT, pro: cfg, con: cfg, debate: { rounds: 100 },
  });
  session.buildSchedule();
  check('100 轮 → 200 个发言任务', session.queue.length === 200, `实际 ${session.queue.length}`);
  check('任务严格正反交替',
    session.queue.every((t, i) => i === 0 || t.side !== session.queue[i - 1].side),
    session.queue.slice(0, 6).map((t) => t.side).join(' → ') + ' …');
  check('聊天模式的任务不预生成指令（执行时才算）',
    session.queue.every((t) => t.instruction === undefined));

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
    const model = (name, id) => ({
      name, protocol: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      apiKey: 'sk-mock', model: id, maxTokens: 512,
    });

    console.log('\n▶ 发起一场「不设辩题」的聊天…');
    const startRes = await fetch(`${base}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        topic: '',
        pro: model('小明', 'mock-pro'),
        con: model('小红', 'mock-con'),
        debate: { rounds: 2, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const start = await startRes.json();
    check('辩题为空也能开聊', start.ok === true, start.sessionId);

    const events = [];
    const transcript = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('事件流超时')), 60000);
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
              resolve(evt.transcript || []);
              return;
            }
          }
        }
        clearTimeout(timer);
        resolve([]);
      })().catch((err) => { clearTimeout(timer); reject(err); });
    });

    console.log('\n▶ 校验聊天模式事件…');
    const session = events.find((e) => e.type === 'session');
    check('session 事件标记为 chat 模式', session?.mode === 'chat');
    check('双方称谓是 Agent A / Agent B，与模型昵称和正反方都无关',
      session?.pro?.role === 'Agent A' && session?.con?.role === 'Agent B',
      `${session?.pro?.role} / ${session?.con?.role}`);

    const phases = events.filter((e) => e.type === 'phase').map((e) => e.phaseName);
    check('环节为「自由聊天」，没有评委点评', !phases.includes('评委点评'), phases.join(' / '));

    const judgeTurns = events.filter((e) => e.type === 'turn_start' && e.side === 'judge');
    check('没有评委发言', judgeTurns.length === 0);

    const chatTurns = events.filter((e) => e.type === 'turn_start' && e.phase === 'chat');
    check('2 轮 → 双方共 4 次发言', chatTurns.length === 4, `实际 ${chatTurns.length}`);
    check('严格一人一句交替，不会同一方连说两次',
      chatTurns.map((e) => e.side).join(',') === 'pro,con,pro,con',
      chatTurns.map((e) => e.side).join(' → '));

    console.log('\n▶ 校验聊天记录…');
    check('记录共 4 条（无评委点评）', transcript.length === 4, `实际 ${transcript.length}`);
    check('记录里的作者严格交替',
      transcript.map((t) => t.role).join(',') === 'Agent A,Agent B,Agent A,Agent B',
      transcript.map((t) => t.role).join(' → '));
    check('发言内容非空', transcript.every((t) => (t.text || '').length > 10));
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

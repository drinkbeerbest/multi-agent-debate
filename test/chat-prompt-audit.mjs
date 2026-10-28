/**
 * 自由聊天模式「人设提示词」审计：把实际发给模型的请求原文打印出来。
 * 用来证明提示词到底有多简，而不是只看代码。
 *
 * 运行：node test/chat-prompt-audit.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROVIDER_PORT = 8910;
const APP_PORT = 8911;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const received = [];

/** 一个极简的 OpenAI 兼容服务，只记录请求。 */
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    received.push(body);
    const text = '好的，我们接着说。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

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
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1' }, stdio: 'ignore',
  });

  try {
    check('模型服务启动', await waitFor(`http://127.0.0.1:${PROVIDER_PORT}/`));
    check('平台服务启动', await waitFor(`${BASE}/api/health`));

    const model = (name, id) => ({
      name, protocol: 'openai', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
      apiKey: 'sk-mock', model: id, maxTokens: 512,
    });

    const startRes = await fetch(`${BASE}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        topic: '',
        pro: model('模型甲', 'model-a'),
        con: model('模型乙', 'model-b'),
        debate: { rounds: 2, wordLimit: 400, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const start = await startRes.json();
    check('聊天已启动', start.ok === true);

    // 等辩论跑完
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s = await fetch(`${BASE}/api/debate/${start.sessionId}`).then((r) => r.json()).catch(() => null);
      if (s?.state === 'done') break;
      await sleep(300);
    }

    console.log('\n======== 实际发给模型的人设提示词（system 消息）========');
    const systems = [...new Set(received.map((b) => b.messages?.find((m) => m.role === 'system')?.content).filter(Boolean))];
    for (const s of systems) {
      console.log('----------------------------------------');
      console.log(s);
      console.log('----------------------------------------');
    }

    console.log('\n======== 每个 user 消息（逐轮指令与上下文）========');
    for (const b of received) {
      const users = (b.messages || []).filter((m) => m.role === 'user').map((m) => m.content);
      console.log(`· ${b.messages?.[0]?.content?.slice(0, 30)} → user 消息 ${users.length} 条：`);
      users.forEach((u, i) => {
        const head = String(u).split('\n')[0];
        const lines = String(u).split('\n').length;
        console.log(`    [${i}] ${lines} 行 | ${head.slice(0, 46)}${String(u).length > 46 ? '…' : ''}`);
      });
    }

    console.log('\n======== 结论 ============');
    check('system 提示词只有 1 行', systems.every((s) => s.split('\n').length === 1),
      systems.map((s) => `${s.split('\n').length} 行`).join(' / '));
    check('system 里没有立场词', systems.every((s) => !/正方|反方|辩题|立场/.test(s)));
    check('system 里没有规则条目', systems.every((s) => !/\n\s*\d+\./.test(s)));
    check('system 里没有字数约束', systems.every((s) => !/字以内|不超过/.test(s)));
    check('system 里没有「不要怎样」的禁令', systems.every((s) => !/不要|不得|禁止|别/.test(s)));
    check('system 里没有模型昵称', systems.every((s) => !s.includes('模型甲') && !s.includes('模型乙')));
    check('system 只有 2 个（两个 agent 各一份）', systems.length === 2, `实际 ${systems.length}`);

    // 上下文里只有「对方的原话」+ 一句极短引导，不能有别的框架性文字
    const allUser = received.flatMap((b) => (b.messages || []).filter((m) => m.role === 'user').map((m) => m.content));
    const distinct = [...new Set(allUser)];
    const allowed = ['开始聊吧。', '接着聊。', '好的，我们接着说。'];
    check('上下文里只有「对方原话」和「开始聊吧。/接着聊。」',
      distinct.every((u) => allowed.includes(u)),
      distinct.map((u) => `「${u}」`).join(' '));
    check('没有多余的框架性包装', !distinct.some((u) => /【.*的发言】/.test(u)),
      distinct.filter((u) => /【/.test(u)).join(' ') || '无');

    // ---------- 辩论模式对照 ----------
    console.log('\n======== 对照：辩论模式每轮的指令 ============');
    received.length = 0;
    const dStart = await fetch(`${BASE}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'debate',
        topic: '测试辩题',
        pro: model('模型甲', 'model-a'),
        con: model('模型乙', 'model-b'),
        debate: { rounds: 2, wordLimit: 400, judgeEnabled: false, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const d = await dStart.json();
    check('辩论已启动', d.ok === true);
    const dDeadline = Date.now() + 30000;
    while (Date.now() < dDeadline) {
      const s = await fetch(`${BASE}/api/debate/${d.sessionId}`).then((r) => r.json()).catch(() => null);
      if (s?.state === 'done') break;
      await sleep(300);
    }
    const debateUsers = received.flatMap((b) => (b.messages || []).filter((m) => m.role === 'user').map((m) => m.content));

    // 对方原话只能以「【正方·模型名 的发言】」这种带来源标注的形式出现一次；
    // 每轮的指令只做指代，不能把原文再拼一遍（否则同一段话占两份 token）。
    const taggedOpponent = debateUsers.filter((u) => /【(正方|反方)·.+?的发言】/.test(u));
    check('对方原话作为独立消息注入上下文',
      taggedOpponent.length >= 2, `带来源标注的对方发言 ${taggedOpponent.length} 条`);

    const rebroadcast = debateUsers.filter((u) => /【(正方|反方)刚才的发言】/.test(u));
    check('对方原话没有被二次包装重复注入', rebroadcast.length === 0,
      rebroadcast.length ? `重复注入 ${rebroadcast.length} 处` : '无');

    const guiding = debateUsers.filter((u) => u.includes('请针对对方刚才的发言'));
    check('第 2 轮起有引导语，且只含指代不含原文',
      guiding.length >= 2, `引导语 ${guiding.length} 条`);
    check('辩论模式首轮是「先表明立场」',
      debateUsers.some((u) => u.includes('先表明你的立场')),
      debateUsers[0]?.slice(0, 24));
    check('辩论模式 system 带辩题与立场',
      received.some((b) => (b.messages?.[0]?.content || '').includes('测试辩题')),
      received[0]?.messages?.[0]?.content?.split('\n')[0]);
  } finally {
    app.kill();
    provider.close();
    await sleep(300);
  }

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

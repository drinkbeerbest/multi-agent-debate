/**
 * Token 用量统计自测。
 *
 * 覆盖三种真实情形：
 *   1. 流式请求必须带 stream_options.include_usage，否则厂商根本不返回用量
 *   2. usage 在 finish_reason 之后单独成帧（真实 OpenAI 顺序），仍能统计到
 *   3. 厂商完全不返回 usage 时，调用次数照常计数，不会整栏归零
 *   4. 不认 stream_options 的老网关返回 400 时，去掉该字段重试后辩论仍能跑完
 *
 * 运行：node test/token-usage.mjs
 */
import http from 'node:http';
import { buildRequest } from '../src/llm.js';
import { DebateSession, MODES } from '../src/debate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const cfgFor = (port) => ({
  name: 'probe', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'k', model: 'probe', maxTokens: 512,
});

/** 起一个只发流、行为由 handler 决定的假厂商。 */
function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      handler({ body, res });
    });
  });
  return server;
}

const openSse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
};

async function runSession(cfg, rounds = 1) {
  const session = new DebateSession({
    topic: '测试', mode: MODES.CHAT, pro: cfg, con: cfg,
    debate: { rounds, wordLimit: 100, judgeEnabled: false },
  });
  const turnEnds = [];
  await new Promise((resolve) => {
    session.on((e) => {
      if (e.type === 'turn_end') turnEnds.push(e.usage);
      if (e.type === 'done') resolve();
    });
    session.run();
  });
  return { session, turnEnds };
}

async function main() {
  console.log('\n▶ 请求体参数');
  const { body } = buildRequest(cfgFor(1), [{ role: 'user', content: 'hi' }], true);
  check('流式请求带 stream_options.include_usage',
    body.stream_options?.include_usage === true, JSON.stringify(body.stream_options));
  const plain = buildRequest(cfgFor(1), [{ role: 'user', content: 'hi' }], false);
  check('非流式请求不带 stream_options', plain.body.stream_options === undefined);

  // ---------- 场景 1：usage 晚于 finish_reason 单独成帧 ----------
  console.log('\n▶ 场景 1：usage 独立成帧（真实 OpenAI 顺序）');
  const good = serve(({ res }) => {
    const send = openSse(res);
    send({ choices: [{ index: 0, delta: { content: '好的。' }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    // 结束信号之后才补用量，且故意延迟到下一次 TCP 包
    setTimeout(() => {
      send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 80 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 60);
  });
  await new Promise((r) => good.listen(8931, '127.0.0.1', r));

  const { session: s1, turnEnds } = await runSession(cfgFor(8931));
  check('prompt token 统计正确', s1.usage.promptTokens === 240, `${s1.usage.promptTokens}`);
  check('completion token 统计正确', s1.usage.completionTokens === 160, `${s1.usage.completionTokens}`);
  check('调用次数统计正确', s1.usage.calls === 2, `${s1.usage.calls}`);
  // 前端靠 turn_end 里的 usage 做实时刷新：不能等到全部结束才有值
  check('每次发言结束都推送累计用量',
    turnEnds.length === 2 && turnEnds.every((u) => u && typeof u.promptTokens === 'number'),
    `turn_end ${turnEnds.length} 条`);
  check('首轮结束即已有用量（非零）', turnEnds[0]?.promptTokens === 120,
    `首轮 ${turnEnds[0]?.promptTokens}`);
  check('末轮为累计值', turnEnds[1]?.promptTokens === 240, `末轮 ${turnEnds[1]?.promptTokens}`);
  good.close();

  // ---------- 场景 2：厂商不返回 usage ----------
  console.log('\n▶ 场景 2：厂商不返回 usage');
  const noUsage = serve(({ res }) => {
    const send = openSse(res);
    send({ choices: [{ index: 0, delta: { content: '嗯。' }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => noUsage.listen(8932, '127.0.0.1', r));

  const { session: s2 } = await runSession(cfgFor(8932));
  check('token 为 0 属于预期', s2.usage.promptTokens === 0 && s2.usage.completionTokens === 0);
  check('调用次数仍照常累加', s2.usage.calls === 2, `${s2.usage.calls}`);
  noUsage.close();

  // ---------- 场景 3：网关不认 stream_options ----------
  console.log('\n▶ 场景 3：老网关拒绝 stream_options');
  let rejected = false;
  let retried = false;
  const strict = serve(({ body: b, res }) => {
    if (b.stream_options) {
      rejected = true;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
      return;
    }
    retried = true;
    const send = openSse(res);
    send({ choices: [{ index: 0, delta: { content: '降级后仍能说话。' }, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => strict.listen(8933, '127.0.0.1', r));

  const { session: s3 } = await runSession(cfgFor(8933));
  check('首次请求被 400 拒绝', rejected);
  check('去掉字段后重试成功', retried);
  check('辩论仍正常结束', s3.state === 'done', s3.state);
  strict.close();

  await sleep(100);
  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

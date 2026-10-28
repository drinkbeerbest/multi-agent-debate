/**
 * 本地 Mock 大模型服务（仅用于自测，不需要任何真实 API Key）。
 *
 * 实现了 OpenAI 兼容的 POST /v1/chat/completions，支持 SSE 流式返回。
 * 启动：node test/mock-provider.js        默认端口 8799
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8901);
const HOST = '127.0.0.1';

function buildReply(messages) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // 自由聊天模式：没有正反方、没有辩题，用聊天口吻回复
  if (system.includes('和一个 AI 聊天')) {
    const who = system.includes('Agent B') ? 'Agent B' : 'Agent A';
    const parts = [
      `${who}：刚看到你说的这个，挺有意思的。`,
      '我觉得这事没有绝对的对错，关键看你更在意哪一头——是自己省时间，还是保留一点自己的判断。',
      '你刚才提到的那个点，如果放在实际场景里，其实还得看具体的人和场合。你怎么看？',
    ];
    let userText = '';
    for (const m of messages) {
      const hit = (m.content || '').match(/【用户插话】([\s\S]*?)(?=\n|$)/);
      if (hit) userText = hit[1].trim();
    }
    if (userText) {
      parts.push(`（对了，${userText} 这句我记下了，回头可以展开聊聊。）`);
    }
    return parts.join('\n\n');
  }

  const isPro = system.includes('正方');
  const role = isPro ? '正方' : '反方';
  const stance = isPro ? '支持' : '反对';

  const opponentText = (lastUser.match(/【.+?的发言】\n([\s\S]+)$/) || [])[1] || '';

  // 找出用户插话（任意一条用户消息里都可能出现）
  let userText = '';
  for (const m of messages) {
    const hit = (m.content || '').match(/【用户插话】([\s\S]*?)(?=\n|$)/);
    if (hit) userText = hit[1].trim();
  }

  const parts = [
    `【${role}发言 · Mock】我的立场是${stance}该主张。`,
    `首先，对方在上一轮的论证存在明显的推理跳跃：结论强于论据，缺少必要的因果链条。`,
    `其次，我方证据更充分——从现实案例看，该方案在成本、效率与可行性上都优于替代路径，因此${stance}它才是更优解。`,
    `第三，即使退一步只看极端情形，我方的论证依然成立，而对方的反驳无法覆盖这一点。`,
  ];

  if (userText) {
    parts.push(`关于用户的插话「${userText}」，我方认为该质疑切中要害但结论过头：方向可以商榷，底线不能松动。`);
  }
  if (opponentText) {
    parts.push(`针对对方「${opponentText.slice(0, 40).replace(/\n/g, ' ')}…」这一说法，我方认为关键在于其前提并未被证成，因此该反驳不成立。`);
  }
  return parts.join('\n\n');
}

function chunkText(text, size = 6) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'mock-provider' }));
    return;
  }

  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const reply = buildReply(messages);

    // 模拟厂商的输出上限限制：超过就返回 400
    const limit = Number(process.env.MOCK_MAX_TOKENS_LIMIT || 0);
    const requested = Number(body.max_tokens || body.maxOutputTokens || 0);
    if (limit && requested > limit) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `max_tokens is too large: maximum allowed is ${limit}, got ${requested}`,
          type: 'invalid_request_error',
        },
      }));
      return;
    }

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
      }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const piece of chunkText(reply)) {
      res.write(`data: ${JSON.stringify({
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`);
      await new Promise((r) => setTimeout(r, 12));
    }
    const hangMode = process.env.MOCK_HANG || '';
    res.write(`data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: hangMode === 'silent' ? null : 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
    })}\n\n`);

    if (hangMode) {
      // 模拟真实厂商：内容发完后保持长连接不关闭（不发送 [DONE]）
      const keepAlive = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch { /* 已断开 */ }
      }, 3000);
      res.on('close', () => clearInterval(keepAlive));
      return;
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-provider] http://${HOST}:${PORT}/v1`);
});

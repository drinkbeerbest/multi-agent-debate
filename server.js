/**
 * 多智能体辩论平台 —— HTTP 服务（零第三方依赖）。
 *
 * 启动：node server.js     默认监听 http://127.0.0.1:8787
 * 环境变量：PORT / HOST
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings, saveSettings, mergeSettings, publicSettings } from './src/settings.js';
import { PRESETS } from './src/presets.js';
import { DebateSession } from './src/debate.js';
import { testModel } from './src/llm.js';
import { readJsonBody } from './src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 构建版本号：改动引擎（服务端逻辑）后请同步 +1，
 * 前端会显示这个版本，方便确认浏览器连的是不是重启后的新服务。
 */
const BUILD = '2026-10-28.9';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 运行中的辩论会话 */
const sessions = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 静态文件托管（带目录穿越防护）。 */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    rel = '/index.html';
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, '403 Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, '404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** SSE：推送辩论过程中的全部事件。 */
function handleEventStream(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 先回放已经发生的事件，避免前端连接稍晚时丢内容
  for (const event of session.events) send(event);

  const unsubscribe = session.on(send);
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, build: BUILD, uptime: process.uptime(), sessions: sessions.size });
    return true;
  }

  if (method === 'GET' && pathname === '/api/presets') {
    sendJson(res, 200, { presets: PRESETS });
    return true;
  }

  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, publicSettings(loadSettings()));
    return true;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const merged = mergeSettings(body, loadSettings());
    const saved = saveSettings(merged);
    sendJson(res, 200, { ok: true, settings: publicSettings(saved) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/settings/test') {
    const body = await readJsonBody(req);
    const cfg = body.model || {};
    // 测试时若前端未回填 Key，则使用已保存的 Key
    if (!cfg.apiKey) {
      const saved = loadSettings();
      const savedCfg = body.side === 'con' ? saved.con : saved.pro;
      if (savedCfg.apiKey) cfg.apiKey = savedCfg.apiKey;
    }
    try {
      const result = await testModel(cfg);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/debate') {
    const body = await readJsonBody(req);
    const mode = body.mode === 'chat' ? 'chat' : 'debate';
    const topic = String(body.topic || '').trim();
    if (!topic && mode !== 'chat') {
      sendJson(res, 400, { ok: false, message: '辩题不能为空' });
      return true;
    }

    const saved = loadSettings();
    const merged = mergeSettings({ pro: body.pro, con: body.con, debate: body.debate }, saved);

    const problems = [];
    if (!merged.pro.baseUrl || !merged.pro.model) problems.push('正方模型尚未配置（Base URL / 模型 ID）');
    if (!merged.con.baseUrl || !merged.con.model) problems.push('反方模型尚未配置（Base URL / 模型 ID）');
    if (problems.length) {
      sendJson(res, 400, { ok: false, message: problems.join('；') });
      return true;
    }

    // 自由聊天模式不需要评委点评
    const debate = { ...merged.debate, judgeEnabled: mode === 'chat' ? false : merged.debate.judgeEnabled };

    const session = new DebateSession({
      // 不在这里把空话题兜底成「自由聊天」：聊天模式需要区分「没给话题」和
      // 「话题就叫自由聊天」，否则会把占位文字当成真话题塞进提示词
      topic,
      mode,
      pro: merged.pro,
      con: merged.con,
      debate,
    });
    sessions.set(session.id, session);
    // 最多保留 20 个会话
    if (sessions.size > 20) {
      const oldest = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      sessions.delete(oldest.id);
    }

    // 后台执行，前端通过 SSE 订阅
    session.run().catch((err) => {
      console.error('[debate] 未捕获异常：', err);
    });

    sendJson(res, 200, { ok: true, sessionId: session.id, topic: session.topic });
    return true;
  }

  const debateMatch = pathname.match(/^\/api\/debate\/([A-Za-z0-9_]+)$/);
  if (method === 'GET' && debateMatch) {
    const session = sessions.get(debateMatch[1]);
    if (!session) {
      sendJson(res, 404, { ok: false, message: '会话不存在或已过期' });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      sessionId: session.id,
      topic: session.topic,
      state: session.state,
      transcript: session.transcript,
      usage: session.usage,
      debate: session.debate,
    });
    return true;
  }

  const eventsMatch = pathname.match(/^\/api\/debate\/([A-Za-z0-9_]+)\/events$/);
  if (method === 'GET' && eventsMatch) {
    const session = sessions.get(eventsMatch[1]);
    if (!session) {
      sendText(res, 404, '会话不存在');
      return true;
    }
    handleEventStream(req, res, session);
    return true;
  }

  const stopMatch = pathname.match(/^\/api\/debate\/([A-Za-z0-9_]+)\/stop$/);
  if (method === 'POST' && stopMatch) {
    const session = sessions.get(stopMatch[1]);
    if (!session) {
      sendJson(res, 404, { ok: false, message: '会话不存在' });
      return true;
    }
    const stopped = session.stop();
    sendJson(res, 200, { ok: true, stopped, state: session.state });
    return true;
  }

  const sayMatch = pathname.match(/^\/api\/debate\/([A-Za-z0-9_]+)\/say$/);
  if (method === 'POST' && sayMatch) {
    const session = sessions.get(sayMatch[1]);
    if (!session) {
      sendJson(res, 404, { ok: false, message: '会话不存在' });
      return true;
    }
    const body = await readJsonBody(req);
    const result = session.say(body.text);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { ok: false, message: '接口不存在' });
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server] 处理请求出错：', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ⚔  多智能体辩论平台已启动');
  console.log(`     地址：http://${HOST}:${PORT}`);
  console.log(`     版本：${BUILD}`);
  console.log('     提示：打开页面右上角「设置」，接入正方 / 反方两个大模型 API 后即可开辩。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用，请换端口启动：$env:PORT=8790; node server.js`);
  } else {
    console.error('[server] 启动失败：', err);
  }
  process.exitCode = 1;
});

/**
 * 多协议大模型客户端。
 *
 * 支持三种协议：
 *   openai    —— POST {baseUrl}/chat/completions      （OpenAI / DeepSeek / Kimi / Qwen / GLM / 豆包 / SiliconFlow / OpenRouter / Ollama …）
 *   anthropic —— POST {baseUrl}/messages              （Claude 及 Anthropic 兼容网关）
 *   gemini   —— POST {baseUrl}/models/{model}:streamGenerateContent
 *
 * 统一提供：流式（逐 token 回调）与非流式（连通性测试）两种调用方式。
 */
import { isAbortError } from './util.js';

export const PROTOCOLS = ['openai', 'anthropic', 'gemini'];

/**
 * 清洗 Base URL：去掉结尾斜杠，并兼容用户直接粘贴完整接口地址的情况。
 * 例如 https://api.openai.com/v1/chat/completions → https://api.openai.com/v1
 */
export function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('Base URL 不能为空');
  url = url.replace(/\/+$/, '');
  const tails = ['/chat/completions', '/completions', '/messages', '/responses', '/generatecontent'];
  const lower = url.toLowerCase();
  for (const tail of tails) {
    if (lower.endsWith(tail)) {
      url = url.slice(0, url.length - tail.length);
      break;
    }
  }
  return url.replace(/\/+$/, '');
}

/**
 * 合并连续同角色的消息。
 * Anthropic 与 Gemini 要求 user/assistant 严格交替，而辩论引擎在「插入对方发言」时
 * 可能产生连续 user 消息，因此这里做一次规整，避免服务端报 roles must alternate。
 */
function mergeSameRole(messages) {
  const merged = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  return merged;
}

/** 按协议规整消息列表。 */
export function normalizeMessages(messages, protocol) {
  const list = (messages || []).filter((m) => m && typeof m.content === 'string' && m.content.length);
  if (protocol === 'openai') return list;

  const merged = mergeSameRole(list);
  // Anthropic 要求首条非 system 消息必须是 user
  if (protocol === 'anthropic') {
    const firstNonSystem = merged.find((m) => m.role !== 'system');
    if (firstNonSystem && firstNonSystem.role !== 'user') {
      merged.unshift({ role: 'user', content: '（请开始你的发言）' });
    }
  }
  return merged;
}

/**
 * 构造一次请求。
 * @returns {{url:string, headers:object, body:object}}
 */
export function buildRequest(cfg, messages, stream = false) {
  const protocol = PROTOCOLS.includes(cfg.protocol) ? cfg.protocol : 'openai';
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };

  if (cfg.apiKey) {
    if (protocol === 'anthropic') {
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = cfg.anthropicVersion || '2023-06-01';
    } else if (protocol === 'gemini') {
      headers['x-goog-api-key'] = cfg.apiKey;
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
  }
  if (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      if (typeof v === 'string' && v) headers[k] = v;
    }
  }

  const normalized = normalizeMessages(messages, protocol);
  // max_tokens 为 null 或空字符串时表示「不传该参数」
  const rawMax = cfg.maxTokens;
  const maxTokens = rawMax === null || rawMax === undefined || rawMax === ''
    ? null
    : (Number(rawMax) > 0 ? Math.floor(Number(rawMax)) : null);

  if (protocol === 'anthropic') {
    const systemParts = normalized.filter((m) => m.role === 'system').map((m) => m.content);
    const chat = normalized.filter((m) => m.role !== 'system');
    const body = {
      model: cfg.model,
      messages: chat,
      max_tokens: maxTokens || 4096,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (stream) body.stream = true;
    return { url: `${baseUrl}/messages`, headers, body };
  }

  if (protocol === 'gemini') {
    const systemParts = normalized.filter((m) => m.role === 'system').map((m) => m.content);
    const chat = normalized.filter((m) => m.role !== 'system');
    const contents = mergeSameRole(chat).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const generationConfig = {};
    if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
    const body = { contents };
    if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${baseUrl}/models/${encodeURIComponent(cfg.model)}:${action}${stream ? '?alt=sse' : ''}`;
    return { url, headers, body };
  }

  // openai 兼容
  const body = { model: cfg.model, messages: normalized };
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;
  return { url: `${baseUrl}/chat/completions`, headers, body };
}

/** 从非流式响应中提取文本。 */
export function extractText(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data?.choices?.[0];
  if (choice) {
    const t = choice?.message?.content ?? choice?.text ?? choice?.delta?.content;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (Array.isArray(data?.content)) {
    return data.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
  }
  if (typeof data?.content === 'string') return data.content;
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || '').join('');
  if (typeof data?.output_text === 'string') return data.output_text;
  return '';
}

/** 从流式分片中提取增量文本（兼容三种协议的不同字段结构）。 */
export function extractDelta(data) {
  if (!data || typeof data !== 'object') return '';

  // OpenAI 兼容: choices[0].delta.content
  const choice = data?.choices?.[0];
  if (choice) {
    const t = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
    if (typeof t === 'string' && t) return t;
    if (Array.isArray(t)) return t.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }

  // Anthropic: content_block_delta / delta.text
  if (typeof data?.delta?.text === 'string' && data.delta.text) return data.delta.text;
  if (Array.isArray(data?.content_block?.content)) {
    return data.content_block.content.map((b) => b?.text || '').join('');
  }

  // Gemini: candidates[0].content.parts[].text
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || '').join('');

  // 少数网关直接推 text 字段
  if (typeof data?.text === 'string' && data.text) return data.text;

  return '';
}

function withTimeout(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal]);
  return signal;
}

/** 降级候选值：依次尝试更保守的输出上限。 */
const MAX_TOKEN_FALLBACKS = [25000, 12000, 8192, 4096];

/**
 * 发起请求，遇到「输出上限超限」类的 400 自动降级重试。
 *
 * 默认 max_tokens 调到 50000 是为了放开模型的发挥空间，但部分厂商的上限更低
 * （GPT-4o 16384、DeepSeek/Qwen 8192 等），直接发会被服务端 400 拒绝。
 * 这里逐级降到服务端能接受的数值，只在错误信息确实提到 token 上限时才降级。
 *
 * @returns {{res: Response, downgradedFrom: number|null}}
 */
async function requestWithTokenFallback(url, headers, body, fetchInit) {
  const key = 'max_tokens' in body ? 'max_tokens' : ('maxOutputTokens' in body ? 'maxOutputTokens' : null);
  const current = key ? Number(body[key]) || 0 : 0;
  const candidates = key && current > 8192
    ? [current, ...MAX_TOKEN_FALLBACKS.filter((v) => v < current)]
    : [current];

  let lastError = null;
  for (const value of candidates) {
    const payload = { ...body };
    if (key) payload[key] = value;
    const res = await fetch(url, { ...fetchInit, body: JSON.stringify(payload) });
    if (res.ok) {
      return { res, downgradedFrom: value !== current ? current : null };
    }
    const detail = await res.text().catch(() => '');
    lastError = new Error(`接口返回 ${res.status} ${res.statusText}${detail ? `：${detail.slice(0, 400)}` : ''}`);
    const isTokenLimitError = /max[_\s]?tokens?|maxoutputtokens|maximum.*tokens/i.test(detail);
    const isLast = value === candidates[candidates.length - 1];
    if (res.status !== 400 || !isTokenLimitError || isLast) throw lastError;
  }
  throw lastError;
}

/**
 * 判断一条流式分片是否表示「本轮输出结束」。
 * 真实厂商不一定关闭连接，必须能识别各家协议自己的结束信号。
 */
export function isStreamEnd(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.type === 'message_stop') return true;                 // Anthropic
  if (data.type === 'response.completed') return true;           // OpenAI Responses
  if (data.type === 'content_block_stop' && data.index === undefined) return true;
  const choice = data?.choices?.[0];
  if (choice && choice.finish_reason) return true;               // OpenAI 兼容
  if (data?.candidates?.[0]?.finishReason) return true;          // Gemini
  return false;
}

/**
 * 流式调用，逐 token 回调 onDelta。
 *
 * 结束判定（三重保险，任一命中即返回，避免卡死）：
 *   1. 协议自身的结束信号（[DONE] / message_stop / finish_reason / finishReason）
 *   2. 空闲超时：连续 idleTimeout 没有任何新数据 → 视为结束，保留已收到的内容
 *   3. 总超时
 * 用户主动 abort 时抛出，由上层按「已停止」处理。
 *
 * @param {object} cfg 模型配置
 * @param {Array<{role:string,content:string}>} messages 消息列表
 * @param {object} opts { onDelta, signal, timeout, idleTimeout }
 */
export async function streamChat(cfg, messages, opts = {}) {
  const { onDelta, signal, timeout = 300000, idleTimeout = 90000 } = opts;
  const { url, headers, body } = buildRequest(cfg, messages, true);

  // 统一的取消控制：外部信号 + 总超时 + 空闲超时
  const ctl = new AbortController();
  let idleAborted = false;
  let timedOut = false;

  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  const totalTimer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleAborted = true; ctl.abort(); }, idleTimeout);
  };
  armIdle();

  let res;
  let downgradedFrom = null;
  try {
    const out = await requestWithTokenFallback(url, headers, body, {
      method: 'POST',
      headers,
      signal: ctl.signal,
    });
    res = out.res;
    downgradedFrom = out.downgradedFrom;
  } catch (err) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (signal?.aborted) throw err;
    throw err;
  }

  if (!res.ok) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status} ${res.statusText}${detail ? `：${detail.slice(0, 400)}` : ''}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  try {
    // 服务端忽略了 stream 参数，直接返回完整 JSON
    if (contentType.includes('application/json')) {
      const data = await res.json();
      const text = extractText(data);
      if (text && onDelta) onDelta(text);
      return { text, usage: data?.usage || null, truncated: false };
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let usage = null;
    let finished = false;

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith(':') || line.startsWith('event:')) return;
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { finished = true; return; }
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
      if (data?.usage) usage = data.usage;
      if (isStreamEnd(data)) finished = true;
      const delta = extractDelta(data);
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    };

    if (res.body) {
      try {
        for await (const chunk of res.body) {
          armIdle();
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop() ?? '';
          for (const line of parts) handleLine(line);
          if (finished) break;   // 已收到结束信号，立刻收尾，不再等连接关闭
        }
        if (!finished) {
          buffer += decoder.decode();
          if (buffer) handleLine(buffer);
        }
      } catch (err) {
        // 用户主动中断 → 交给上层处理；空闲/总超时 → 按已收到的内容收尾
        if (signal?.aborted) throw err;
        if (!idleAborted && !timedOut) throw err;
      }
    }

    return { text: full, usage, truncated: idleAborted || timedOut, downgradedFrom };
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try { await res.body?.cancel(); } catch { /* 连接可能已关闭 */ }
  }
}

/** 非流式调用，用于连通性测试。 */
export async function chatOnce(cfg, messages, opts = {}) {
  const { timeout = 60000 } = opts;
  const { url, headers, body } = buildRequest(cfg, messages, false);
  const { res } = await requestWithTokenFallback(url, headers, body, {
    method: 'POST',
    headers,
    signal: withTimeout(opts.signal, timeout),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status} ${res.statusText}${detail ? `：${detail.slice(0, 400)}` : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  return { text: extractText(data), usage: data?.usage || null };
}

/** 连通性测试：发一条极短的消息，测量耗时。 */
export async function testModel(cfg, opts = {}) {
  const started = Date.now();
  const messages = [{ role: 'user', content: '只回复两个字：正常' }];
  const probe = { ...cfg, maxTokens: 16 };
  const res = await chatOnce(probe, messages, opts);
  return {
    ok: true,
    latencyMs: Date.now() - started,
    reply: (res.text || '').slice(0, 200),
  };
}

export { isAbortError };

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
  if (stream) {
    body.stream = true;
    // 流式默认不返回用量，必须显式要求厂商在末尾补一个 usage chunk，
    // 否则整个会话的 token 统计永远是 0
    body.stream_options = { include_usage: true };
  }
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

/**
 * 从流式分片里提取用量，统一成 { prompt_tokens, completion_tokens }。
 *
 * 三种协议的字段位置和名字都不同：
 *   OpenAI   —— 独立 chunk 的 usage.prompt_tokens / completion_tokens
 *   Anthropic —— message_start 的 message.usage.input_tokens，message_delta 的 usage.output_tokens
 *   Gemini   —— 末尾 chunk 的 usageMetadata.promptTokenCount / candidatesTokenCount
 * 拿不到时返回 null，不要用 0 冒充，否则上层无法区分「没有用量」和「用量为零」。
 */
export function extractUsage(data) {
  if (!data || typeof data !== 'object') return null;

  const toPair = (p, c) => {
    const prompt = Number(p);
    const completion = Number(c);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
    const out = {};
    if (Number.isFinite(prompt)) out.prompt_tokens = prompt;
    if (Number.isFinite(completion)) out.completion_tokens = completion;
    return out;
  };

  // OpenAI 兼容
  if (data.usage && typeof data.usage === 'object') {
    const pair = toPair(
      data.usage.prompt_tokens ?? data.usage.input_tokens,
      data.usage.completion_tokens ?? data.usage.output_tokens,
    );
    if (pair) return pair;
  }

  // Anthropic：message_start 里嵌在 message.usage
  if (data.message?.usage && typeof data.message.usage === 'object') {
    const pair = toPair(data.message.usage.input_tokens, data.message.usage.output_tokens);
    if (pair) return pair;
  }

  // Gemini
  if (data.usageMetadata && typeof data.usageMetadata === 'object') {
    const pair = toPair(data.usageMetadata.promptTokenCount, data.usageMetadata.candidatesTokenCount);
    if (pair) return pair;
  }

  return null;
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
 * 收到结束信号后，继续等待 usage chunk 的宽限期（毫秒）。
 *
 * OpenAI 兼容厂商的用量统计是在 finish_reason 之后单独补一帧的，
 * 若一看到 finish_reason 就断开，token 永远统计不到。
 * 又不能无限等（部分厂商发完内容不关连接），所以给一个很短的窗口。
 */
const USAGE_GRACE = 800;

/**
 * 内部：按输出上限逐级降级的请求循环。
 * @returns {{res: Response, downgradedFrom: number|null}}
 */
async function tokenFallbackAttempt(url, headers, body, fetchInit) {
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
 * 发起请求，遇到「输出上限超限」类的 400 自动降级重试。
 *
 * 另外兜一层：stream_options 是较新的参数，老网关或自建代理可能直接 400，
 * 此时去掉它重试一次 —— 代价只是拿不到 token 用量，不该让整场辩论失败。
 *
 * @returns {{res: Response, downgradedFrom: number|null}}
 */
async function requestWithTokenFallback(url, headers, body, fetchInit) {
  try {
    return await tokenFallbackAttempt(url, headers, body, fetchInit);
  } catch (err) {
    if (body.stream_options && /stream_options/i.test(err?.message || '')) {
      const rest = { ...body };
      delete rest.stream_options;
      return tokenFallbackAttempt(url, headers, rest, fetchInit);
    }
    throw err;
  }
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
  let graceTimer = null;   // 结束信号后的用量宽限计时器，finally 里要清理，故声明在外层
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
    let sawDone = false;
    let graceExpired = false;

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith(':') || line.startsWith('event:')) return;
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { finished = true; sawDone = true; return; }
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
      const chunkUsage = extractUsage(data);
      if (chunkUsage) usage = { ...(usage || {}), ...chunkUsage };
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
          if (sawDone) break;
          if (finished && !graceTimer) {
            // 结束信号已到，但 usage 往往在下一帧：留个短窗口继续读，
            // 超时就主动断开，避免厂商不关连接时把整轮拖到空闲超时
            graceTimer = setTimeout(() => { graceExpired = true; ctl.abort(); }, USAGE_GRACE);
          }
        }
        if (!finished) {
          buffer += decoder.decode();
          if (buffer) handleLine(buffer);
        }
      } catch (err) {
        // 用户主动中断 → 交给上层处理；空闲/总超时/宽限期到点 → 按已收到的内容收尾
        if (signal?.aborted) throw err;
        if (!idleAborted && !timedOut && !graceExpired) throw err;
      }
    }

    return { text: full, usage, truncated: idleAborted || timedOut, downgradedFrom };
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (graceTimer) clearTimeout(graceTimer);
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

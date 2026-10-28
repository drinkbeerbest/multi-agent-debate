/**
 * 通用小工具集合。
 */
import { randomUUID } from 'node:crypto';

/** 生成一个短 id，用于会话标识。 */
export function uid(prefix = 'd') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 读取并解析请求体（JSON）。 */
export function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 延迟等待（毫秒）。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 截断长文本，便于在 UI / 错误提示中展示。 */
export function truncate(text, max = 500) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 判断错误是否为「主动中断」。 */
export function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /aborted|abortsignal|aborterror/i.test(String(err.message || ''));
}

/** 把对象安全地转成 JSON 字符串。 */
export function safeJson(value, fallback = '') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

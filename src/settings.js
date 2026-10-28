/**
 * 设置持久化：两个大模型 API 的接入信息 + 辩论参数。
 * 保存到 data/settings.json（该目录已在 .gitignore 中，避免把 API Key 提交到仓库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** 单个模型的默认配置。 */
export function defaultModelCfg(overrides = {}) {
  return {
    name: '',            // 辩手显示名，例如「GPT-4o」
    protocol: 'openai',  // openai | anthropic | gemini
    baseUrl: '',         // 例如 https://api.openai.com/v1
    apiKey: '',          // API Key
    model: '',           // 模型 ID，例如 gpt-4o
    maxTokens: 50000,    // 输出上限（超出厂商上限时会自动降级）
    ...overrides,
  };
}

/** 全局默认设置。 */
export function defaultSettings() {
  return {
    pro: defaultModelCfg({ name: '正方模型' }),
    con: defaultModelCfg({ name: '反方模型' }),
    debate: {
      rounds: 100,        // 辩论模式：每方各发言几次
      chatRounds: 100,    // 自由聊天模式：每方各发言几次
      wordLimit: 400,     // 单次发言建议字数
      judgeEnabled: true, // 是否生成评委点评
      judgeSource: 'pro', // 评委使用哪一方的 API
      style: 'standard',  // standard | aggressive | academic
    },
    migrations: { debateRounds20: false, debateRounds100: false },
    updatedAt: null,
  };
}

/**
 * 一次性设置迁移。
 *
 * 辩论轮数的默认值从 3 调整为 20：老配置文件里的 rounds=3 属于「沿用旧默认值」，
 * 跟随迁移到 20；迁移标记写回文件后，用户之后手动设成 3 不会再被覆盖。
 */
function applyMigrations(raw) {
  const migrations = { ...(raw.migrations || {}) };
  const debate = { ...(raw.debate || {}) };
  let changed = false;

  // 历史迁移：默认辩论轮数从 3 → 20
  if (!migrations.debateRounds20) {
    migrations.debateRounds20 = true;
    changed = true;
    if (Number(debate.rounds) === 3) debate.rounds = 20;
  }

  // 默认辩论轮数从 20 → 100：只迁移「仍停留在旧默认值」的配置，
  // 用户手动设过的其它值（例如 2、50）保持不动
  if (!migrations.debateRounds100) {
    migrations.debateRounds100 = true;
    changed = true;
    if (Number(debate.rounds) === 20) debate.rounds = 100;
  }

  if (changed) raw.debate = debate;
  return { migrations, changed };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function coerceModelCfg(raw = {}) {
  const d = defaultModelCfg();
  return {
    name: String(raw.name ?? d.name).slice(0, 60),
    protocol: ['openai', 'anthropic', 'gemini'].includes(raw.protocol) ? raw.protocol : 'openai',
    baseUrl: String(raw.baseUrl ?? d.baseUrl).trim(),
    apiKey: String(raw.apiKey ?? d.apiKey).trim(),
    model: String(raw.model ?? d.model).trim(),
    // max_tokens 传 null 或 '' 表示「不传该参数」，由服务端自行决定
    maxTokens: raw.maxTokens === null || raw.maxTokens === ''
      ? null
      : (Number.isFinite(Number(raw.maxTokens)) && Number(raw.maxTokens) > 0
        ? Math.floor(Number(raw.maxTokens))
        : d.maxTokens),
  };
}

function coerceDebate(raw = {}) {
  const d = defaultSettings().debate;
  const rounds = Number(raw.rounds);
  const chatRounds = Number(raw.chatRounds);
  const wordLimit = Number(raw.wordLimit);
  const clamp = (n, def) => (Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 200) : def);
  return {
    rounds: clamp(rounds, d.rounds),
    chatRounds: clamp(chatRounds, d.chatRounds),
    wordLimit: Number.isFinite(wordLimit) ? Math.min(Math.max(Math.round(wordLimit), 80), 5000) : d.wordLimit,
    judgeEnabled: raw.judgeEnabled === undefined ? d.judgeEnabled : Boolean(raw.judgeEnabled),
    judgeSource: raw.judgeSource === 'con' ? 'con' : 'pro',
    style: ['standard', 'aggressive', 'academic'].includes(raw.style) ? raw.style : d.style,
  };
}

/** 读取设置；文件不存在时返回默认值。 */
export function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const { migrations, changed } = applyMigrations(raw);
    const result = {
      pro: coerceModelCfg(raw.pro),
      con: coerceModelCfg(raw.con),
      debate: coerceDebate(raw.debate),
      migrations,
      updatedAt: raw.updatedAt || null,
    };
    if (changed) {
      try { saveSettings(result); } catch { /* 迁移落盘失败不影响使用 */ }
    }
    return result;
  } catch (err) {
    console.warn('[settings] 读取失败，使用默认设置：', err.message);
    return defaultSettings();
  }
}

/** 保存设置到磁盘。 */
export function saveSettings(next) {
  ensureDataDir();
  const payload = {
    pro: coerceModelCfg(next.pro),
    con: coerceModelCfg(next.con),
    debate: coerceDebate(next.debate),
    migrations: next.migrations || defaultSettings().migrations,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * 合并前端提交的设置。
 * apiKey 传空字符串时保留磁盘上已保存的 Key（前端只做脱敏回显）。
 */
export function mergeSettings(incoming = {}, current = loadSettings()) {
  const mergeModel = (patch, base) => {
    const next = coerceModelCfg({ ...base, ...patch });
    if (!next.apiKey) next.apiKey = base.apiKey || '';
    return next;
  };
  return {
    pro: mergeModel(incoming.pro || {}, current.pro),
    con: mergeModel(incoming.con || {}, current.con),
    debate: coerceDebate({ ...current.debate, ...(incoming.debate || {}) }),
    migrations: current.migrations || defaultSettings().migrations,
    updatedAt: current.updatedAt || null,
  };
}

/** 返回给前端的设置：API Key 脱敏（不回传明文）。 */
export function publicSettings(settings) {
  const mask = (m) => ({
    ...m,
    apiKey: '',
    hasApiKey: Boolean(m.apiKey),
    apiKeyPreview: m.apiKey ? `${m.apiKey.slice(0, 4)}••••${m.apiKey.slice(-2)}` : '',
  });
  return {
    pro: mask(settings.pro),
    con: mask(settings.con),
    debate: settings.debate,
    updatedAt: settings.updatedAt,
  };
}

/** 检查某个模型配置是否可以发起辩论。 */
export function validateModelCfg(cfg) {
  const errors = [];
  if (!cfg.baseUrl) errors.push('Base URL 不能为空');
  if (!cfg.model) errors.push('模型 ID 不能为空');
  return errors;
}

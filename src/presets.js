/**
 * 常见大模型服务的预设，用户在「设置」里一键填入 Base URL 与协议。
 * protocol: openai(兼容 Chat Completions) | anthropic(Messages) | gemini(generateContent)
 */
export const PRESETS = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
  { id: 'deepseek', label: 'DeepSeek 深度求索', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'moonshot', label: 'Moonshot / Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'kimi-k2-0905-preview'] },
  { id: 'dashscope', label: '阿里云百炼 DashScope（通义千问）', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash'] },
  { id: 'ark', label: '火山引擎方舟（豆包）', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k'] },
  { id: 'siliconflow', label: 'SiliconFlow 硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-72B-Instruct'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'] },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-5', 'claude-3-5-haiku-latest'] },
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  { id: 'ollama', label: '本地 Ollama', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'] },
  { id: 'custom', label: '自定义（其他 OpenAI 兼容服务）', protocol: 'openai', baseUrl: '', models: [] },
];

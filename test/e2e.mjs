/**
 * 端到端自测脚本（零依赖）：
 *   1. 启动 Mock 大模型服务（模拟两个不同厂商的 OpenAI 兼容接口）
 *   2. 启动辩论平台服务
 *   3. 通过 HTTP 配置两个 API → 发起辩论 → 订阅 SSE → 校验事件流与记录
 *   4. 还原原有的 settings.json
 *
 * 运行：node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 8901;
const APP_PORT = 8791;
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, condition, extra = '') {
  const mark = condition ? '✅' : '❌';
  console.log(`  ${mark} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
}

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
  // 备份原设置
  let backup = null;
  if (fs.existsSync(SETTINGS_FILE)) {
    backup = fs.readFileSync(SETTINGS_FILE, 'utf8');
  }

  console.log('\n▶ 启动 Mock 模型服务与辩论平台…');
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-provider.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit',
  });
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1' },
    stdio: 'inherit',
  });

  try {
    const mockUp = await waitFor(`http://127.0.0.1:${MOCK_PORT}/`);
    const appUp = await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`);
    check('Mock 模型服务启动', mockUp);
    check('辩论平台服务启动', appUp);
    if (!mockUp || !appUp) return;

    const base = `http://127.0.0.1:${APP_PORT}`;

    console.log('\n▶ 配置两个大模型 API（正方 / 反方）…');
    const modelCfg = (name, port, model) => ({
      name,
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-mock-key',
      model,
      maxTokens: 512,
    });

    const saveRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pro: modelCfg('正方模型甲', MOCK_PORT, 'mock-pro'),
        con: modelCfg('反方模型乙', MOCK_PORT, 'mock-con'),
        debate: { rounds: 1, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const saved = await saveRes.json();
    check('设置保存成功', saved.ok === true);
    check('API Key 不回传明文', saved.settings?.pro?.apiKey === '' && saved.settings?.pro?.hasApiKey === true);

    console.log('\n▶ 测试连通性检测…');
    const testRes = await fetch(`${base}/api/settings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: 'pro', model: { ...modelCfg('x', MOCK_PORT, 'mock-pro'), apiKey: '' } }),
    });
    const testData = await testRes.json();
    check('连通性检测通过', testData.ok === true, testData.reply);

    console.log('\n▶ 发起辩论并订阅事件流…');
    const startRes = await fetch(`${base}/api/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: '人工智能生成内容应当强制标注',
        pro: modelCfg('正方模型甲', MOCK_PORT, 'mock-pro'),
        con: modelCfg('反方模型乙', MOCK_PORT, 'mock-con'),
        debate: { rounds: 1, wordLimit: 200, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
      }),
    });
    const startData = await startRes.json();
    check('辩论已启动', startData.ok === true, startData.sessionId);
    if (!startData.ok) return;

    const events = [];
    const transcriptText = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('事件流超时')), 60000);
      (async () => {
        try {
          const res = await fetch(`${base}/api/debate/${startData.sessionId}/events`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                events.push(evt);
                if (evt.type === 'done') {
                  clearTimeout(timer);
                  resolve(evt.transcript || []);
                  return;
                }
              } catch { /* ignore */ }
            }
          }
          clearTimeout(timer);
          resolve([]);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      })();
    });

    const types = events.map((e) => e.type);
    const count = (t) => types.filter((x) => x === t).length;

    console.log('\n▶ 校验辩论事件…');
    check('收到 session 事件', count('session') === 1);
    check('收到 phase 事件（辩论 / 评委）', count('phase') >= 2, `phase=${count('phase')}`);
    check('收到 turn_start 事件', count('turn_start') >= 3, `turn_start=${count('turn_start')}`);
    check('收到流式 delta 事件', count('delta') > 20, `delta=${count('delta')}`);
    check('收到 turn_end 事件', count('turn_end') >= 2, `turn_end=${count('turn_end')}`);
    check('收到 done 事件', count('done') === 1);

    const proTurns = events.filter((e) => e.type === 'turn_start' && e.side === 'pro').length;
    const conTurns = events.filter((e) => e.type === 'turn_start' && e.side === 'con').length;
    check('正方发言次数正确（1 轮 = 1 次）', proTurns === 1, `pro=${proTurns}`);
    check('反方发言次数正确（1 轮 = 1 次）', conTurns === 1, `con=${conTurns}`);
    check('严格一人一句交替，不会同一方连说两次',
      events.filter((e) => e.type === 'turn_start' && e.side !== 'judge').map((e) => e.side).join(',') === 'pro,con');

    console.log('\n▶ 校验辩论记录…');
    check('记录条数 = 3（2 场交锋 + 1 段点评）', transcriptText.length === 3, `实际 ${transcriptText.length}`);
    check('所有发言均有正文', transcriptText.every((t) => t.text && t.text.length > 10));
    check('记录包含评委点评', transcriptText.some((t) => t.phase === 'judge'));
    check('没有开篇立论 / 总结陈词环节',
      !transcriptText.some((t) => t.phase === 'opening' || t.phase === 'closing'));

    const sessionRes = await fetch(`${base}/api/debate/${startData.sessionId}`);
    const sessionData = await sessionRes.json();
    check('会话接口可读取完整记录', sessionData.ok === true && sessionData.transcript.length === 3);
    check('会话状态为 done', sessionData.state === 'done', sessionData.state);

    console.log('\n▶ 校验停止接口…');
    const stopRes = await fetch(`${base}/api/debate/${startData.sessionId}/stop`, { method: 'POST' });
    const stopData = await stopRes.json();
    check('停止接口响应正常', stopRes.status === 200 && typeof stopData.ok === 'boolean');
  } finally {
    mock.kill();
    app.kill();
    await sleep(300);
    // 还原用户原有设置
    if (backup !== null) {
      fs.writeFileSync(SETTINGS_FILE, backup, 'utf8');
    } else if (fs.existsSync(SETTINGS_FILE)) {
      fs.unlinkSync(SETTINGS_FILE);
    }
  }

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

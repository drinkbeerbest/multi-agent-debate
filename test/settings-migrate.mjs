/**
 * 设置持久化与「一次性迁移」自测。
 * 验证：辩论轮数默认值 3 → 20 的迁移只执行一次，之后用户手动设回 3 不会被覆盖。
 *
 * 运行：node test/settings-migrate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const sample = {
  pro: { name: '正方', protocol: 'openai', baseUrl: 'https://x/v1', apiKey: 'k1', model: 'm1', maxTokens: 10000 },
  con: { name: '反方', protocol: 'openai', baseUrl: 'https://y/v1', apiKey: 'k2', model: 'm2', maxTokens: 10000 },
  debate: { rounds: 3, wordLimit: 400, judgeEnabled: true, judgeSource: 'pro', style: 'standard' },
};

async function main() {
  let backup = null;
  if (fs.existsSync(SETTINGS_FILE)) backup = fs.readFileSync(SETTINGS_FILE, 'utf8');
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });

  try {
    // 每次加载都要重新读文件，所以这里用动态 import 后反复调用
    const mod = await import('../src/settings.js');

    console.log('\n▶ 场景 1：老配置文件（rounds=3，无迁移标记）');
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(sample, null, 2), 'utf8');
    const s1 = mod.loadSettings();
    check('轮数被迁移到 20', s1.debate.rounds === 20, `实际 ${s1.debate.rounds}`);
    check('聊天轮数取新默认 100', s1.debate.chatRounds === 100, `实际 ${s1.debate.chatRounds}`);
    check('迁移标记已写入', s1.migrations?.debateRounds20 === true);
    const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    check('迁移结果已落盘', onDisk.debate.rounds === 20 && onDisk.migrations?.debateRounds20 === true);
    check('API 配置未被改动',
      onDisk.pro.apiKey === 'k1' && onDisk.con.apiKey === 'k2' && onDisk.pro.maxTokens === 10000);

    console.log('\n▶ 场景 2：迁移只执行一次，用户手动设回 3 不被覆盖');
    const manual = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    manual.debate.rounds = 3;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(manual, null, 2), 'utf8');
    const s2 = mod.loadSettings();
    check('手动设的 3 被保留', s2.debate.rounds === 3, `实际 ${s2.debate.rounds}`);

    console.log('\n▶ 场景 3：新装用户（无配置文件）');
    fs.rmSync(SETTINGS_FILE, { force: true });
    const s3 = mod.loadSettings();
    check('默认辩论轮数 = 20', s3.debate.rounds === 20, `实际 ${s3.debate.rounds}`);
    check('默认聊天轮数 = 100', s3.debate.chatRounds === 100, `实际 ${s3.debate.chatRounds}`);

    console.log('\n▶ 场景 4：轮数上限 200');
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...sample, debate: { ...sample.debate, rounds: 9999, chatRounds: 9999 } }, null, 2), 'utf8');
    const s4 = mod.loadSettings();
    check('超出的轮数被截到 200', s4.debate.rounds === 200 && s4.debate.chatRounds === 200,
      `${s4.debate.rounds} / ${s4.debate.chatRounds}`);
  } finally {
    if (backup !== null) fs.writeFileSync(SETTINGS_FILE, backup, 'utf8');
    else if (fs.existsSync(SETTINGS_FILE)) fs.rmSync(SETTINGS_FILE);
  }

  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n⚠️  有 ${failures} 项未通过\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});

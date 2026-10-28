/**
 * 多智能体辩论平台 —— 前端逻辑。
 * 主题切换（浅色/深色）· 单列群聊式辩论界面 · 左右布局模式 · 用户插话 · Markdown 导出。
 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  presets: [],
  settings: null,
  sessionId: null,
  source: null,
  running: false,
  sessionActive: false,
  layout: localStorage.getItem('debate.layout') || 'group',
  mode: localStorage.getItem('debate.mode') || 'debate',
  theme: localStorage.getItem('debate.theme')
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  messages: [],
  rounds: { debate: 100, chat: 100 },   // 两种模式各自的轮数，互不干扰
  startedAt: 0,
  timer: null,
  seq: 0,
  endCardShown: false,   // 结束卡片只插入一次，后续追问结束不重复刷屏
};

let emptyTemplate = null;

/* =========================================================
 * 工具
 * ========================================================= */

function toast(message, type = '') {
  const node = el('div', `toast ${type}`, message);
  $('toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 320);
  }, type === 'err' ? 6000 : 3600);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function setConn(text, kind = '') {
  $('conn-text').textContent = text;
  $('conn-status').className = `conn ${kind}`.trim();
}

/* =========================================================
 * 主题（浅色 / 深色）
 * ========================================================= */

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  $('btn-theme').textContent = state.theme === 'light' ? '☀️' : '🌙';
  $('btn-theme').title = state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式';
  localStorage.setItem('debate.theme', state.theme);
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
}

/* =========================================================
 * 模式（辩论 / 自由聊天）
 * ========================================================= */

function isChatMode() {
  return state.mode === 'chat';
}

function updateHint() {
  const chat = isChatMode();
  if (chat) {
    $('layout-hint').textContent = '两个 AI 自由对话，你也可以随时插话';
    return;
  }
  $('layout-hint').textContent = state.layout === 'group'
    ? '正方 / 反方发言在左侧，你的插话在右侧'
    : '正方在左、反方在右，你的插话在右侧';
}

function setMode(mode) {
  state.mode = mode === 'chat' ? 'chat' : 'debate';
  localStorage.setItem('debate.mode', state.mode);
  const chat = isChatMode();

  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  $('topic-label').textContent = chat ? '话题（可留空）' : '辩题';
  $('topic').placeholder = chat
    ? '留空即可自由开聊，也可以指定一个话题'
    : '例如：人工智能生成内容应当强制标注';
  $('rounds-label').textContent = chat ? '聊天轮数' : '交锋轮数';
  $('rounds').value = state.rounds[state.mode];
  $('style-row').hidden = chat;
  $('judge-row').hidden = chat;
  $('wordlimit-field').hidden = chat;
  $('pro-tag').textContent = chat ? 'Agent A' : '正方';
  $('con-tag').textContent = chat ? 'Agent B' : '反方';
  $('topic-chip').textContent = chat ? '自由聊天' : '当前辩题';
  $('btn-start').textContent = chat ? '▶ 开始聊天' : '▶ 开始辩论';
  refreshSayPlaceholder();

  if (emptyTemplate) {
    const p = emptyTemplate.querySelector('.empty p');
    if (p) {
      p.textContent = chat
        ? '在左侧配置好两个大模型 API，点击「开始聊天」就能让它们自由对话。'
        : '在左侧输入辩题，配置好两个大模型 API，即可开始一场正反方对决。';
    }
  }

  if (!state.messages.length) {
    $('arena-topic-text').textContent = chat ? '两个 AI 的自由对话' : '等待选题';
  }
  updateHint();
  renderChat();
}

/* =========================================================
 * 布局模式（群聊 / 对阵）
 * ========================================================= */

/** 某个发言者应该靠哪一侧显示。 */
function alignOf(side) {
  if (side === 'judge') return 'center';
  if (side === 'user') return 'right';
  if (state.layout === 'duel' && side === 'con') return 'right';
  return 'left';
}

function setLayout(layout) {
  state.layout = layout === 'duel' ? 'duel' : 'group';
  localStorage.setItem('debate.layout', state.layout);
  document.querySelectorAll('#layout-switch .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === state.layout);
  });
  updateHint();
  renderChat();
}

/* =========================================================
 * 设置
 * ========================================================= */

function apiCardHtml(side) {
  const label = side === 'pro' ? '正方' : '反方';
  const badge = side === 'pro' ? '<span class="badge-pro">正方</span>' : '<span class="badge-con">反方</span>';
  return `
    <section class="api-card side-${side}" data-side="${side}">
      <h3>${badge}<span>${label}模型 API</span></h3>

      <div class="field">
        <span class="label">服务预设</span>
        <select id="cfg-${side}-preset"><option value="">自定义</option></select>
      </div>

      <div class="api-row">
        <label class="field">
          <span class="label">显示名称</span>
          <input id="cfg-${side}-name" type="text" placeholder="例如 ${label}的模型昵称" />
        </label>
        <label class="field">
          <span class="label">接口协议</span>
          <select id="cfg-${side}-protocol">
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span class="label">Base URL</span>
        <input id="cfg-${side}-baseUrl" type="text" placeholder="https://api.openai.com/v1" spellcheck="false" />
      </label>

      <label class="field">
        <span class="label">API Key</span>
        <input id="cfg-${side}-apiKey" type="password" placeholder="sk-..." spellcheck="false" autocomplete="off" />
      </label>

      <label class="field">
        <span class="label">模型 ID</span>
        <input id="cfg-${side}-model" type="text" placeholder="例如 gpt-4o" list="dl-${side}" spellcheck="false" />
        <datalist id="dl-${side}"></datalist>
      </label>

      <label class="field full">
        <span class="label">max_tokens（输出上限，留空由服务端决定）</span>
        <input id="cfg-${side}-maxTokens" type="number" step="1000" min="128" placeholder="50000" />
      </label>

      <div class="actions">
        <button class="btn ghost grow" id="btn-test-${side}">🔌 测试连接</button>
        <button class="btn ghost" id="btn-clear-key-${side}" title="清除已保存的 Key">清除 Key</button>
      </div>
      <div class="api-status pending" id="status-${side}"><span class="status-dot"></span><span>未测试</span></div>
    </section>`;
}

function renderApiCards() {
  $('api-grid').innerHTML = apiCardHtml('pro') + apiCardHtml('con');

  const presetSelect = $('cfg-pro-preset');
  for (const p of state.presets) {
    const opt = el('option', '', p.label);
    opt.value = p.id;
    presetSelect.appendChild(opt.cloneNode(true));
  }

  for (const side of ['pro', 'con']) {
    $('cfg-' + side + '-preset').addEventListener('change', (e) => {
      const preset = state.presets.find((p) => p.id === e.target.value);
      if (!preset) return;
      $('cfg-' + side + '-protocol').value = preset.protocol;
      $('cfg-' + side + '-baseUrl').value = preset.baseUrl;
      const dl = $('dl-' + side);
      dl.innerHTML = '';
      for (const m of preset.models || []) {
        const opt = el('option', '', m);
        opt.value = m;
        dl.appendChild(opt);
      }
      if (!$('cfg-' + side + '-model').value && preset.models?.length) {
        $('cfg-' + side + '-model').value = preset.models[0];
      }
    });

    $('btn-test-' + side).addEventListener('click', () => testModel(side));
    $('btn-clear-key-' + side).addEventListener('click', () => {
      $('cfg-' + side + '-apiKey').value = '';
      setStatus(side, '已清空输入框中的 Key（保存后生效）', 'pending');
    });
  }
}

function setStatus(side, message, kind = 'pending') {
  const node = $('status-' + side);
  node.className = `api-status ${kind}`;
  node.innerHTML = '';
  node.appendChild(el('span', 'status-dot'));
  node.appendChild(el('span', '', message));
}

async function collectCfg(side) {
  const val = (id) => $(id).value.trim();
  const num = (id) => (val(id) === '' ? null : Number(val(id)));
  return {
    name: val(`cfg-${side}-name`),
    protocol: val(`cfg-${side}-protocol`) || 'openai',
    baseUrl: val(`cfg-${side}-baseUrl`),
    apiKey: val(`cfg-${side}-apiKey`),
    model: val(`cfg-${side}-model`),
    maxTokens: num(`cfg-${side}-maxTokens`),
  };
}

async function testModel(side) {
  const cfg = await collectCfg(side);
  if (!cfg.baseUrl || !cfg.model) {
    setStatus(side, '请先填写 Base URL 与模型 ID', 'fail');
    return;
  }
  setStatus(side, '正在连接…', 'pending');
  const btn = $('btn-test-' + side);
  btn.disabled = true;
  try {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side, model: cfg }),
    });
    const data = await res.json();
    if (data.ok) {
      setStatus(side, `连接正常 · ${data.latencyMs}ms${data.reply ? ` · 「${data.reply}」` : ''}`, 'ok');
    } else {
      setStatus(side, `连接失败：${data.message}`, 'fail');
    }
  } catch (err) {
    setStatus(side, `连接失败：${err.message}`, 'fail');
  } finally {
    btn.disabled = false;
  }
}

function fillCfgForm(side, cfg) {
  $(`cfg-${side}-name`).value = cfg.name || '';
  $(`cfg-${side}-protocol`).value = cfg.protocol || 'openai';
  $(`cfg-${side}-baseUrl`).value = cfg.baseUrl || '';
  $(`cfg-${side}-apiKey`).value = '';
  $(`cfg-${side}-apiKey`).placeholder = cfg.hasApiKey
    ? `已保存 ${cfg.apiKeyPreview || ''}（留空则不修改）`
    : 'sk-...';
  $(`cfg-${side}-model`).value = cfg.model || '';
  $(`cfg-${side}-maxTokens`).value = cfg.maxTokens ?? '';
  setStatus(side, cfg.hasApiKey ? '已保存配置（未测试）' : '未测试', 'pending');
}

function openSettings() {
  $('settings-modal').hidden = false;
}

function closeSettings() {
  $('settings-modal').hidden = true;
}

async function saveSettings() {
  const pro = await collectCfg('pro');
  const con = await collectCfg('con');
  const debate = {
    rounds: state.rounds.debate,
    chatRounds: state.rounds.chat,
    wordLimit: Number($('wordLimit').value) || 400,
    style: $('style').value,
    judgeEnabled: $('judgeEnabled').checked,
    judgeSource: $('judgeSource').value,
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pro, con, debate }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast('保存失败：' + (data.message || '未知错误'), 'err');
      return;
    }
    applySettings(data.settings);
    closeSettings();
    toast('设置已保存', 'ok');
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  }
}

function applySettings(settings) {
  state.settings = settings;
  fillCfgForm('pro', settings.pro);
  fillCfgForm('con', settings.con);

  // 两种模式的轮数分别记忆：辩论与聊天互不干扰
  state.rounds.debate = Number(settings.debate.rounds) || 100;
  state.rounds.chat = Number(settings.debate.chatRounds) || 100;
  $('rounds').value = state.rounds[state.mode];
  $('wordLimit').value = settings.debate.wordLimit;
  $('style').value = settings.debate.style;
  $('judgeEnabled').checked = settings.debate.judgeEnabled;
  $('judgeSource').value = settings.debate.judgeSource;
  $('pro-name').textContent = settings.pro.name || settings.pro.model || '未配置';
  $('pro-model').textContent = settings.pro.model || '-';
  $('con-name').textContent = settings.con.name || settings.con.model || '未配置';
  $('con-model').textContent = settings.con.model || '-';

  const missing = !settings.pro.baseUrl || !settings.pro.model || !settings.con.baseUrl || !settings.con.model;
  $('setup-notice').hidden = !missing;
}

/* =========================================================
 * 辩论台渲染（群聊式消息流）
 * ========================================================= */

function arenaScroll() {
  const arena = document.querySelector('.arena');
  const nearBottom = arena.scrollHeight - arena.scrollTop - arena.clientHeight < 200;
  if (nearBottom) arena.scrollTop = arena.scrollHeight;
}

function avatarText(msg) {
  if (msg.side === 'user') return '我';
  if (msg.side === 'judge') return '评';
  const role = (msg.role || (msg.side === 'pro' ? '正方' : '反方')).trim();
  return role.slice(0, 1) || '?';
}

function buildMessageNode(msg) {
  const align = alignOf(msg.side);
  const node = el('div', `msg ${align} ${msg.side}`);

  const avatar = el('div', `avatar ${msg.side}`, avatarText(msg));
  if (msg.role) avatar.title = msg.role;
  const main = el('div', 'msg-main');

  const meta = el('div', 'msg-meta');
  meta.appendChild(el('span', 'msg-name', msg.role));
  if (msg.agent && msg.agent !== msg.role) meta.appendChild(el('span', 'msg-model', msg.agent));
  if (msg.title) meta.appendChild(el('span', 'msg-title', msg.title));
  meta.appendChild(el('span', 'msg-time', fmtTime(msg.ts)));
  main.appendChild(meta);

  const bubble = el('div', 'bubble');
  bubble.textContent = msg.text || '';
  main.appendChild(bubble);

  node.appendChild(avatar);
  node.appendChild(main);

  msg._node = node;
  msg._bubble = bubble;
  return node;
}

function buildDividerNode(msg) {
  return el('div', 'phase-tag', msg.label);
}

/**
 * 结束卡片。
 * 点评之前流程是自走的，用户不用操心；点评之后流程停了，
 * 必须明确告诉用户「已经结束，但还能继续追问」，否则只能重新开一场。
 */
function buildEndNode(msg) {
  const box = el('div', 'end-card');
  box.appendChild(el('div', 'end-title', msg.title || '已结束'));
  if (msg.hint) box.appendChild(el('div', 'end-hint', msg.hint));
  return box;
}

function buildNodeByKind(msg) {
  if (msg.kind === 'divider') return buildDividerNode(msg);
  if (msg.kind === 'end') return buildEndNode(msg);
  return buildMessageNode(msg);
}

/**
 * 插话框提示语。
 * 辩论结束后流程不再自走，提示语必须换成「可以继续追问」，
 * 否则用户会以为这里只能重新开一场。
 */
function refreshSayPlaceholder() {
  const chat = isChatMode();
  const finished = !state.running && state.sessionActive;
  if (finished) {
    $('say-input').placeholder = chat
      ? '继续说点什么，两个 agent 会接着回应…'
      : '继续追问，正反方会回应你…';
    return;
  }
  $('say-input').placeholder = chat
    ? '给两个 AI 插一句话…（会进入双方上下文并触发回应）'
    : '给正方 / 反方插一句话…（会进入双方上下文并触发回应）';
}

/** 依据 state.messages 重建整条消息流（切换布局 / 清空时调用）。 */
function renderChat() {
  const chat = $('chat');
  chat.innerHTML = '';
  if (!state.messages.length) {
    if (emptyTemplate) chat.appendChild(emptyTemplate.cloneNode(true));
    return;
  }
  for (const msg of state.messages) {
    chat.appendChild(buildNodeByKind(msg));
  }
  arenaScroll();
}

function pushMessage(msg) {
  state.messages.push(msg);
  const chat = $('chat');
  if (state.messages.length === 1) chat.innerHTML = '';
  chat.appendChild(buildNodeByKind(msg));
  arenaScroll();
  return msg;
}

function updateMessage(msg) {
  if (msg._bubble) msg._bubble.textContent = msg.text || '';
  arenaScroll();
}

function pushError(message) {
  const msg = {
    kind: 'error',
    side: 'error',
    role: '系统',
    title: '',
    text: message,
    ts: Date.now(),
  };
  state.messages.push(msg);
  const chat = $('chat');
  if (state.messages.length === 1) chat.innerHTML = '';
  const node = el('div', 'msg left msg-error');
  const avatar = el('div', 'avatar judge', '!');
  const main = el('div', 'msg-main');
  const bubble = el('div', 'bubble', message);
  main.appendChild(bubble);
  node.appendChild(avatar);
  node.appendChild(main);
  msg._node = node;
  msg._bubble = bubble;
  chat.appendChild(node);
  arenaScroll();
}

let streamingMsg = null;

/* =========================================================
 * 辩论流程
 * ========================================================= */

async function startDebate() {
  if (state.running) {
    toast('辩论正在进行中', 'warn');
    return;
  }
  const topic = $('topic').value.trim();
  if (!topic && !isChatMode()) {
    toast('请先输入辩题', 'err');
    $('topic').focus();
    return;
  }

  const pro = await collectCfg('pro');
  const con = await collectCfg('con');
  if (!pro.baseUrl || !pro.model || !con.baseUrl || !con.model) {
    toast('请先在「设置」中配置正方与反方两个模型的 Base URL 与模型 ID', 'err');
    openSettings();
    return;
  }

  clearArena(true);

  const debate = {
    // 发给服务端的是当前模式的轮数
    rounds: Number($('rounds').value) || state.rounds[state.mode],
    wordLimit: Number($('wordLimit').value) || 400,
    style: $('style').value,
    judgeEnabled: $('judgeEnabled').checked,
    judgeSource: $('judgeSource').value,
  };

  try {
    const res = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, pro, con, debate, mode: state.mode }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.message || '启动失败', 'err');
      return;
    }
    state.sessionId = data.sessionId;
    state.running = true;
    state.sessionActive = true;
    state.endCardShown = false;
    state.startedAt = Date.now();
    // 聊天模式允许不填话题，此时不要用空字符串把标题清掉
    $('arena-topic-text').textContent = isChatMode()
      ? (topic || '两个 AI 的自由对话')
      : topic;
    $('btn-start').disabled = true;
    $('btn-stop').disabled = false;
    $('say-input').disabled = false;
    $('btn-say').disabled = false;
    $('stats-card').hidden = false;
    $('stat-turns').textContent = '0';
    $('stat-elapsed').textContent = '0s';
    $('stat-tokens').textContent = '0';
    setConn('辩论中', 'live');
    refreshSayPlaceholder();
    state.timer = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      $('stat-elapsed').textContent = `${s}s`;
    }, 1000);
    connectEvents(data.sessionId);
  } catch (err) {
    toast('启动失败：' + err.message, 'err');
  }
}

function connectEvents(sessionId) {
  if (state.source) state.source.close();
  const source = new EventSource(`/api/debate/${sessionId}/events`);
  state.source = source;

  source.onmessage = (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.data);
    } catch {
      return;
    }
    handleEvent(evt);
  };
  source.onerror = () => {
    if (!state.running) source.close();
  };
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'session': {
      const chatMode = evt.mode === 'chat';
      $('arena-topic-text').textContent = chatMode
        ? (evt.topic || '两个 AI 的自由对话')
        : evt.topic;
      $('arena-meta').textContent = chatMode
        ? `${evt.pro.role || 'AI A'} · ${evt.con.role || 'AI B'} · ${evt.debate.rounds} 轮交流`
        : `正方 ${evt.pro.model || '-'} · 反方 ${evt.con.model || '-'} · ${evt.debate.rounds} 轮交锋`;
      break;
    }
    case 'phase':
      pushMessage({ kind: 'divider', label: evt.phaseName || evt.phase, ts: evt.ts });
      break;
    case 'turn_start': {
      streamingMsg = pushMessage({
        kind: 'msg',
        side: evt.side,
        role: evt.role,
        agent: evt.agent,
        title: evt.title,
        phase: evt.phase,
        text: '',
        ts: evt.ts,
        streaming: true,
      });
      streamingMsg._node.classList.add('streaming');
      $('stat-turns').textContent = String(state.messages.filter((m) => m.kind === 'msg' && m.side !== 'user').length);
      break;
    }
    case 'delta':
      if (streamingMsg) {
        streamingMsg.text += evt.text || '';
        updateMessage(streamingMsg);
      }
      break;
    case 'turn_end':
    case 'judge_end': {
      if (!streamingMsg) break;
      if (evt.text && evt.text.length > streamingMsg.text.length) {
        streamingMsg.text = evt.text;
      }
      streamingMsg.streaming = false;
      if (streamingMsg._node) streamingMsg._node.classList.remove('streaming');
      updateMessage(streamingMsg);
      streamingMsg = null;
      break;
    }
    case 'user_message': {
      pushMessage({
        kind: 'msg',
        side: 'user',
        role: '我',
        agent: '我',
        title: '',
        text: evt.text || '',
        ts: evt.ts,
      });
      // 插话后引擎会安排回应，重新点亮运行状态
      state.running = true;
      $('btn-stop').disabled = false;
      setConn('辩论中', 'live');
      break;
    }
    case 'error':
      pushError(evt.message || '未知错误');
      break;
    case 'notice':
      toast(evt.message || '提示', 'warn');
      break;
    case 'done': {
      state.running = false;
      state.sessionActive = evt.reason !== 'stopped' && evt.reason !== 'error';
      clearInterval(state.timer);
      $('btn-start').disabled = false;
      $('btn-stop').disabled = true;
      // 注意：这里不要关闭 SSE —— 辩论结束后用户仍可追问，回应需要继续推送
      const usage = evt.usage || {};
      $('stat-tokens').textContent = String((usage.promptTokens || 0) + (usage.completionTokens || 0));
      if (evt.reason === 'completed') {
        setConn('已完成', 'live');
        toast(isChatMode() ? '聊天结束' : '辩论结束', 'ok');
        // 流程到这里不再自走，必须留下一个明确的落点，并说清还能做什么
        if (!state.endCardShown) {
          state.endCardShown = true;
          pushMessage({
            kind: 'end',
            title: isChatMode() ? '聊天已结束' : '辩论已结束',
            hint: isChatMode()
              ? '两个 agent 已经聊完。还想继续的话，直接在下方接着说话，它们会回你；点「开始」可开启新一场。'
              : '评委点评已结束。还想继续的话，直接在下方追问，正反方会回应你；点「开始」可开启新一场。',
            ts: evt.ts,
          });
        }
      } else if (evt.reason === 'stopped') {
        setConn('已停止', '');
        toast(isChatMode() ? '聊天已停止' : '辩论已停止', 'warn');
      } else {
        setConn('出错', 'error');
        toast('辩论异常结束：' + (evt.message || ''), 'err');
      }
      refreshSayPlaceholder();
      break;
    }
    default:
      break;
  }
}

async function stopDebate() {
  if (!state.sessionId || !state.running) return;
  $('btn-stop').disabled = true;
  try {
    await fetch(`/api/debate/${state.sessionId}/stop`, { method: 'POST' });
    toast('已发送停止指令', 'warn');
  } catch (err) {
    toast('停止失败：' + err.message, 'err');
  }
}

/** 用户插话：进入双方上下文，并触发下一位发言者回应。 */
async function sendSay() {
  const input = $('say-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.sessionId || !state.sessionActive) {
    toast('请先开始一场辩论，再进行插话', 'warn');
    return;
  }
  try {
    const res = await fetch(`/api/debate/${state.sessionId}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.message || '插话失败', 'err');
      return;
    }
    input.value = '';
    state.running = true;
    $('btn-stop').disabled = false;
    setConn('辩论中', 'live');
  } catch (err) {
    toast('插话失败：' + err.message, 'err');
  }
}

function clearArena(silent = false) {
  state.messages = [];
  streamingMsg = null;
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  state.sessionId = null;
  state.sessionActive = false;
  state.running = false;
  state.endCardShown = false;
  $('say-input').disabled = true;
  $('btn-say').disabled = true;
  refreshSayPlaceholder();
  renderChat();
  $('stat-turns').textContent = '0';
  $('stat-elapsed').textContent = '0s';
  $('stat-tokens').textContent = '0';
  $('arena-meta').textContent = '';
  if (!silent) {
    $('arena-topic-text').textContent = isChatMode() ? '两个 AI 的自由对话' : '等待选题';
    setConn('空闲', '');
  }
}

/* =========================================================
 * 导出
 * ========================================================= */

function buildMarkdown() {
  const s = state.settings;
  const chat = isChatMode();
  const lines = [];

  if (chat) {
    lines.push('# 自由聊天记录');
    lines.push('');
    lines.push(`- Agent A：${s?.pro?.name || '-'}（${s?.pro?.model || '-'}）`);
    lines.push(`- Agent B：${s?.con?.name || '-'}（${s?.con?.model || '-'}）`);
  } else {
    lines.push(`# 辩论记录：${$('arena-topic-text').textContent}`);
    lines.push('');
    lines.push(`- 正方：${s?.pro?.name || '-'}（${s?.pro?.model || '-'}）`);
    lines.push(`- 反方：${s?.con?.name || '-'}（${s?.con?.model || '-'}）`);
  }
  lines.push(`- 模式：${chat ? '自由聊天' : '辩论'}`);
  lines.push(`- 轮数：${$('rounds').value}`);
  lines.push(`- 布局模式：${state.layout === 'group' ? '群聊模式' : '对阵模式'}`);
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  const phaseNames = { debate: '自由辩论', chat: '自由聊天', reply: '回应插话', judge: '评委点评' };
  let lastPhase = '';
  for (const msg of state.messages) {
    if (msg.kind === 'divider') {
      lines.push(`## ${msg.label}`);
      lines.push('');
      continue;
    }
    if (msg.kind === 'error') {
      lines.push(`> ⚠️ ${msg.text}`);
      lines.push('');
      continue;
    }
    if (msg.kind === 'end') {
      lines.push(`> ${msg.title || '已结束'}`);
      lines.push('');
      continue;
    }
    if (msg.phase && msg.phase !== lastPhase) {
      lines.push(`## ${phaseNames[msg.phase] || msg.phase}`);
      lines.push('');
      lastPhase = msg.phase;
    }
    lines.push(`### ${msg.role}${msg.agent && msg.agent !== msg.role ? `·${msg.agent}` : ''}${msg.title ? `｜${msg.title}` : ''}`);
    lines.push('');
    lines.push(msg.text || '（无输出）');
    lines.push('');
  }
  return lines.join('\n');
}

function exportMarkdown() {
  if (!state.messages.length) {
    toast('当前还没有辩论记录', 'warn');
    return;
  }
  const blob = new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `辩论记录-${$('arena-topic-text').textContent.slice(0, 20)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('已导出 Markdown', 'ok');
}

/* =========================================================
 * 初始化
 * ========================================================= */

async function init() {
  applyTheme(state.theme);
  emptyTemplate = $('empty-hint') ? $('empty-hint').cloneNode(true) : null;
  setMode(state.mode);
  setLayout(state.layout);

  // 显示服务端版本：引擎改动需要重启服务，这个标记能一眼看出是否已重启
  fetch('/api/health')
    .then((r) => r.json())
    .then((d) => {
      if (d?.build) $('build-tag').textContent = `v${d.build}`;
    })
    .catch(() => {});

  try {
    const res = await fetch('/api/presets');
    const data = await res.json();
    state.presets = data.presets || [];
  } catch {
    state.presets = [];
  }

  renderApiCards();

  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    applySettings(data);
  } catch (err) {
    toast('读取设置失败：' + err.message, 'err');
  } finally {
    // 设置加载完成前不允许发起，避免拿空配置去调接口
    $('btn-start').disabled = false;
  }

  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-cancel-settings').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target === $('settings-modal')) closeSettings();
  });

  $('btn-start').addEventListener('click', startDebate);
  $('btn-stop').addEventListener('click', stopDebate);
  $('btn-clear').addEventListener('click', () => {
    if (state.running) {
      toast('请先停止辩论', 'warn');
      return;
    }
    clearArena();
  });
  $('btn-export').addEventListener('click', exportMarkdown);
  $('btn-say').addEventListener('click', sendSay);
  $('rounds').addEventListener('input', () => {
    const n = Number($('rounds').value);
    if (Number.isFinite(n) && n > 0) state.rounds[state.mode] = Math.min(Math.round(n), 200);
  });
  $('say-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) sendSay();
  });

  document.querySelectorAll('#layout-switch .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLayout(btn.dataset.layout));
  });
  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-modal').hidden) closeSettings();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startDebate();
  });
}

init();

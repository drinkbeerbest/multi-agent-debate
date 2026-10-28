/**
 * 辩论引擎。
 *
 * 设计要点：
 *  - 正方与反方各自维护**独立的上下文**，只能通过「对方的发言被作为 user 消息插入」来交流，
 *    因此不会出现两个 Agent 共用一份历史导致的自我串台。
 *  - 全部发言（开篇立论 / 自由辩论 / 总结陈词 / 回应插话 / 评委点评）进入同一条队列顺序执行，
 *    便于用户在辩论过程中「插话」，插话会同时进入双方上下文，并由下一位发言者正面回应。
 *  - 每一轮发言都会把完整文本推送给前端（turn_start → delta* → turn_end），实现全程实时观战。
 *  - 支持随时停止（AbortController），已生成的内容会保留在记录中。
 */
import { streamChat, isAbortError } from './llm.js';
import { uid } from './util.js';

export const PHASES = {
  debate: '自由辩论',
  chat: '自由聊天',
  reply: '回应插话',
  judge: '评委点评',
};

export const MODES = {
  DEBATE: 'debate',
  CHAT: 'chat',
};

const STYLE_HINT = {
  standard: '表达稳健、讲求逻辑闭环。',
  aggressive: '攻势凌厉，抓住对方漏洞穷追猛打',
  academic: '注重概念界定与证据链条。',
};

/**
 * 流式空闲超时（毫秒）：连续这么久没有任何新数据就判定本轮结束。
 * 真实厂商常常发完内容却不关闭连接，必须有兜底，否则界面会卡在最后一句。
 */
const IDLE_TIMEOUT = Number(process.env.DEBATE_IDLE_TIMEOUT || 90000);

/** 参与者在界面上的称谓。 */
export function agentLabel(side, cfg, mode) {
  if (mode === MODES.CHAT) {
    // 聊天模式下就是两个普通的 agent，不分正反方
    return side === 'pro' ? 'Agent A' : 'Agent B';
  }
  return side === 'pro' ? '正方' : '反方';
}

/**
 * 生成系统提示词。
 * 辩论模式：锁定身份、立场与底线；
 * 聊天模式：只说明「在和一个 AI 自由聊天」，不设辩题、不分立场、不加规则。
 */
export function buildSystemPrompt(side, topic, opts = {}) {
  const wordLimit = opts.wordLimit || 50;

  if (opts.mode === MODES.CHAT) {
    const label = opts.label || (side === 'pro' ? 'Agent A' : 'Agent B');
    // 聊天模式刻意保持极简：身份 + 在聊天 +（给了话题就带上），其余交给模型自由发挥。
    // 话题内联在同一行，避免提示词变长后又生出规则味。
    const chatTopic = String(topic || '').trim();
    return chatTopic
      ? `你是 ${label}，正在和一个 AI 聊天，话题是「${chatTopic}」。`
      : `你是 ${label}，正在和一个 AI 聊天。`;
  }

  const role = side === 'pro' ? '正方' : '反方';
  const stance = side === 'pro' ? `支持「${topic}」` : `反对「${topic}」`;
  const styleHint = STYLE_HINT[opts.style] || '';
  return [
    `你是一场中文辩论赛中的${role}辩手，立场是${stance}。`,
    `每次发言控制在 ${wordLimit} 字以内。`,
    '针对对方最新的发言自主思考后再回应：讲清自己的理由，不要复述对方原话，不要编造数据或引用，保持立场一致。',
    styleHint,
    '',
    `辩题：${topic}`,
  ].filter(Boolean).join('\n');
}

/** 一条待执行的发言任务（指令在执行时才生成，见 buildInstruction）。 */
function task(side, phase, round, title) {
  return { side, phase, round, title };
}

export class DebateSession {
  /**
   * @param {object} options
   * @param {string} options.topic 辩题
   * @param {object} options.pro  正方模型配置
   * @param {object} options.con  反方模型配置
   * @param {object} options.debate 辩论参数 { rounds, wordLimit, judgeEnabled, judgeSource, style }
   */
  constructor(options) {
    this.id = uid('deb');
    this.topic = String(options.topic || '').trim();
    this.options = options;
    this.mode = options.mode === MODES.CHAT ? MODES.CHAT : MODES.DEBATE;
    this.debate = {
      rounds: 100,
      wordLimit: 50,
      judgeEnabled: true,
      judgeSource: 'pro',
      style: 'aggressive',
      ...(options.debate || {}),
    };

    this.events = [];
    this.listeners = new Set();
    this.transcript = [];
    this.usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
    this.controller = new AbortController();
    this.state = 'pending';
    this.error = null;
    this.startedAt = Date.now();
    this.finishedAt = null;

    /** 待执行任务队列 */
    this.queue = [];
    this.pumping = false;
    this.speaking = false;
    this.judgeDone = false;
    this.pendingUserReply = false;
    this.lastSpeaker = null;
    this.lastPhase = null;
    /**
     * 对方最近一次发言的原文。
     * 原文本身已经写进对应 agent 的 messages，这里只用来判断「对方是否已发过言」，
     * 以便首轮与后续轮次给出不同的引导语。
     */
    this.lastOpponentText = { pro: '', con: '' };

    this.agents = {
      pro: {
        side: 'pro',
        role: agentLabel('pro', options.pro, this.mode),
        cfg: options.pro,
        name: options.pro?.name || options.pro?.model || '正方模型',
        messages: [{
          role: 'system',
          content: buildSystemPrompt('pro', this.topic, {
            ...this.debate,
            mode: this.mode,
            label: agentLabel('pro', options.pro, this.mode),
          }),
        }],
      },
      con: {
        side: 'con',
        role: agentLabel('con', options.con, this.mode),
        cfg: options.con,
        name: options.con?.name || options.con?.model || '反方模型',
        messages: [{
          role: 'system',
          content: buildSystemPrompt('con', this.topic, {
            ...this.debate,
            mode: this.mode,
            label: agentLabel('con', options.con, this.mode),
          }),
        }],
      },
    };
  }

  /* ---------- 事件 ---------- */

  /**
   * 累计一次模型调用的用量。
   * 调用次数与 token 分开计：厂商不返回 usage 时，至少还能看出调用了多少次。
   */
  recordUsage(res) {
    this.usage.calls += 1;
    if (!res?.usage) return;
    this.usage.promptTokens += Number(res.usage.prompt_tokens || 0);
    this.usage.completionTokens += Number(res.usage.completion_tokens || 0);
  }

  emit(event) {
    const payload = { ts: Date.now(), ...event };
    this.events.push(payload);
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* 单个订阅者异常不影响其他人 */
      }
    }
    return payload;
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------- 控制 ---------- */

  stop() {
    if (this.state === 'done' || this.state === 'stopped') return false;
    this.controller.abort();
    return true;
  }

  /**
   * 用户插话：进入双方上下文，并安排下一位发言者回应。
   * @returns {{ok:boolean, message?:string}}
   */
  say(text) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, message: '内容不能为空' };
    if (this.state === 'stopped' || this.state === 'error') {
      return { ok: false, message: '本场辩论已结束，无法插话' };
    }

    const stamp = `【用户插话】${clean}`;
    this.agents.pro.messages.push({ role: 'user', content: stamp });
    this.agents.con.messages.push({ role: 'user', content: stamp });
    this.transcript.push({
      side: 'user', role: '我', agent: '我', phase: 'reply', round: 0,
      title: '用户插话', text: clean, ts: Date.now(),
    });
    this.emit({ type: 'user_message', text: clean });

    if (!this.speaking && this.queue.length === 0) {
      // 当前没有待执行的发言（辩论已收尾）：立刻安排一次回应
      this.state = 'running';
      this.pendingUserReply = false;
      this.queue.push(this.makeReplyTask());
    } else {
      // 正在发言中：等这一轮结束后由 pump 插入回应任务
      this.pendingUserReply = true;
    }
    this.pump();
    return { ok: true };
  }

  /**
   * 在真正发言前，按当前状态即时生成这一轮要发给模型的指令。
   *
   * 这里只产出「引导语」，绝不复述对方原话或用户插话：那些原文已经由 speak()
   * 和 say() 作为独立的 user 消息写进上下文，再拼一遍会让同一段内容在请求体里
   * 出现两次，白占 token，也和 system 里「不要复述对方原话」自相矛盾。
   *
   * 仍然要在执行时才生成：首轮与后续轮次的引导语不同，需要读到最新的
   * lastOpponentText 才能判断对方是否已经说过话。
   */
  buildInstruction(side, phase) {
    const hasOpponentSpoken = Boolean(this.lastOpponentText[side]);

    if (phase === 'reply') {
      // 只说「上面那条插话」，不复制原文，也不复用【用户插话】这个标记，
      // 免得模型把引导语本身当成又一条插话
      return '请回应我上面的插话。';
    }

    if (this.mode === MODES.CHAT) {
      return hasOpponentSpoken ? '接着聊。' : '开始聊吧。';
    }

    return hasOpponentSpoken
      ? '请针对对方刚才的发言，自主思考后回应。'
      : '这是辩论的第一轮，请先表明你的立场并给出你的理由。';
  }

  /**
   * 生成一条发言任务（指令留到执行时再算）。
   */
  makeTurnTask(side, round) {
    const role = this.agents[side].role;
    if (this.mode === MODES.CHAT) {
      return task(side, 'chat', round, `第 ${round} 轮 · ${role}`);
    }
    return task(side, 'debate', round, `第 ${round} 轮 · ${role}发言`);
  }

  /**
   * 生成一条「回应用户插话」的任务。
   * 优先由「下一位本该发言的人」来回应，队列为空时（辩论已结束）才由对手回应。
   */
  makeReplyTask() {
    const side = this.queue.length
      ? this.queue[0].side
      : (this.lastSpeaker === 'pro' ? 'con' : 'pro');
    const role = this.agents[side].role;
    return task(side, 'reply', 0, `${role}回应用户插话`);
  }

  /* ---------- 发言 ---------- */

  /**
   * 让某一方发言（流式）。
   */
  async speak(side, meta) {
    const agent = this.agents[side];
    const other = this.agents[side === 'pro' ? 'con' : 'pro'];
    const { phase, round, title } = meta;

    // 指令在发言前即时生成，才能带上对方刚刚说的内容
    const instruction = this.buildInstruction(side, phase);
    agent.messages.push({ role: 'user', content: instruction });

    // 环节变化时广播一次，前端据此插入分隔标签
    if (this.lastPhase !== phase) {
      this.lastPhase = phase;
      this.emit({ type: 'phase', phase, phaseName: PHASES[phase] || phase, round });
    }

    this.emit({
      type: 'turn_start',
      side,
      role: agent.role,
      agent: agent.name,
      model: agent.cfg?.model || '',
      phase,
      phaseName: PHASES[phase] || phase,
      round,
      title,
    });

    let text = '';
    try {
      const res = await streamChat(agent.cfg, agent.messages, {
        signal: this.controller.signal,
        timeout: 300000,
        idleTimeout: IDLE_TIMEOUT,
        onDelta: (delta) => {
          text += delta;
          this.emit({ type: 'delta', side, phase, round, text: delta });
        },
      });
      if (res.text) text = res.text;
      if (res.downgradedFrom) {
        this.emit({
          type: 'notice',
          side,
          message: `【提示】该模型的最大输出上限低于 ${res.downgradedFrom}，已自动下调输出上限后重试。`,
        });
      }
      if (res.truncated) {
        this.emit({
          type: 'notice',
          side,
          message: '【提示】模型连接未正常结束，已按当前内容继续。',
        });
      }
      // 调用次数与用量分开计：厂商不返回 usage 时，至少还能看出调用了多少次
      this.recordUsage(res);
    } catch (err) {
      if (isAbortError(err) || this.controller.signal.aborted) {
        this.emit({ type: 'turn_end', side, phase, round, text, aborted: true, usage: { ...this.usage } });
        this.transcript.push({
          side, role: agent.role, agent: agent.name, phase, round, title, text, ts: Date.now(), aborted: true,
        });
        throw new Error('__STOPPED__');
      }
      this.emit({
        type: 'error',
        side,
        message: `【${agent.role}·${agent.name}】调用失败：${err.message}`,
      });
      throw err;
    }

    // 带上累计用量：前端据此在辩论进行中就实时更新统计，不必等到全部结束
    this.emit({ type: 'turn_end', side, phase, round, text, usage: { ...this.usage } });
    this.transcript.push({
      side, role: agent.role, agent: agent.name, phase, round, title, text, ts: Date.now(),
    });

    // 双方互相「听见」：这是对方原话进入本方上下文的唯一入口，
    // buildInstruction() 只补一句引导语，不再复述，否则同一段话会重复占上下文。
    // 聊天模式直接放原话不包装，辩论模式标注来源，方便模型区分是谁说的。
    other.messages.push({
      role: 'user',
      content: this.mode === MODES.CHAT
        ? text
        : `【${agent.role}·${agent.name} 的发言】\n${text}`,
    });
    // 本方记住自己说过的话
    agent.messages.push({ role: 'assistant', content: text });
    // 记录对方最新发言，供下一轮提示使用
    this.lastOpponentText[other.side] = text;
    this.lastSpeaker = side;
  }

  /* ---------- 环节编排 ---------- */

  /**
   * 编排辩论日程。
   * 严格一人一句交替发言（正方 → 反方 → 正方 → 反方 …），不会出现同一方连着说两次。
   * rounds 轮 = 每方各发言 rounds 次。
   */
  buildSchedule() {
    for (let round = 1; round <= this.debate.rounds; round += 1) {
      this.queue.push(this.makeTurnTask('pro', round));
      this.queue.push(this.makeTurnTask('con', round));
    }
  }

  async runJudge() {
    const source = this.agents[this.debate.judgeSource] || this.agents.pro;
    this.emit({
      type: 'phase',
      phase: 'judge',
      phaseName: PHASES.judge,
      round: 0,
      agent: source.name,
    });
    this.emit({
      type: 'turn_start',
      side: 'judge',
      role: '评委',
      agent: source.name,
      model: source.cfg?.model || '',
      phase: 'judge',
      phaseName: PHASES.judge,
      round: 0,
      title: '评委点评',
    });

    const transcriptText = this.transcript
      .map((t) => `【${t.role}·${t.agent}·${t.title}】\n${t.text}`)
      .join('\n\n');

    const system = [
      '你是一场辩论赛的中立评委，请基于完整辩论记录进行专业点评。',
      '输出结构：',
      '1. 双方核心立场与主要论点概述；',
      '2. 各自的优点与漏洞；',
      '3. 从论证质量、证据支撑、回应力度三个维度分别打分（各 10 分）；',
      '4. 最终胜负倾向与理由。',
      '保持中立客观，不要偏袒任何一方。',
    ].join('\n');

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `辩题：${this.topic}\n\n辩论记录：\n${transcriptText}` },
    ];

    let text = '';
    try {
      const res = await streamChat(source.cfg, messages, {
        signal: this.controller.signal,
        timeout: 300000,
        idleTimeout: IDLE_TIMEOUT,
        onDelta: (delta) => {
          text += delta;
          this.emit({ type: 'delta', side: 'judge', phase: 'judge', round: 0, text: delta });
        },
      });
      if (res.text) text = res.text;
      this.recordUsage(res);
      if (res.truncated) {
        this.emit({
          type: 'notice',
          side: 'judge',
          message: '【提示】评委点评的连接未正常结束，已按当前内容收尾。',
        });
      }
    } catch (err) {
      if (isAbortError(err) || this.controller.signal.aborted) throw new Error('__STOPPED__');
      this.emit({ type: 'error', side: 'judge', message: `【评委点评】调用失败：${err.message}` });
      return;
    }

    this.emit({ type: 'judge_end', text, usage: { ...this.usage } });
    this.transcript.push({
      side: 'judge', role: '评委', agent: source.name, phase: 'judge', round: 0,
      title: '评委点评', text, ts: Date.now(),
    });
  }

  /* ---------- 主流程 ---------- */

  /** 顺序消费任务队列；用户插话会在两次发言之间插入回应任务。 */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        if (this.controller.signal.aborted) throw new Error('__STOPPED__');

        if (this.queue.length === 0) {
          if (this.pendingUserReply) {
            this.pendingUserReply = false;
            this.queue.push(this.makeReplyTask());
            continue;
          }
          if (this.debate.judgeEnabled && !this.judgeDone && this.mode !== MODES.CHAT) {
            this.judgeDone = true;
            await this.runJudge();
            continue;
          }
          break;
        }

        const current = this.queue.shift();
        this.speaking = true;
        try {
          await this.speak(current.side, current);
        } finally {
          this.speaking = false;
        }

        if (this.pendingUserReply && !this.controller.signal.aborted) {
          this.pendingUserReply = false;
          const reply = this.makeReplyTask();
          // 回应任务占用「下一位发言者」的位置：若队首正是同一方，
          // 用回应替换掉它并插到队首 —— 否则它会被排到队尾，
          // 导致同一方在轮次交界处连说两次。
          if (this.queue.length && this.queue[0].side === reply.side) this.queue.shift();
          this.queue.unshift(reply);
        }
      }

      this.state = 'done';
      this.finishedAt = Date.now();
      this.emit({ type: 'done', reason: 'completed', usage: this.usage, transcript: this.transcript });
    } catch (err) {
      if (err?.message === '__STOPPED__' || this.controller.signal.aborted) {
        this.state = 'stopped';
        this.finishedAt = Date.now();
        this.emit({ type: 'done', reason: 'stopped', usage: this.usage, transcript: this.transcript });
        return;
      }
      this.state = 'error';
      this.error = err.message;
      this.finishedAt = Date.now();
      this.emit({ type: 'done', reason: 'error', message: err.message, usage: this.usage, transcript: this.transcript });
    } finally {
      this.pumping = false;
    }
  }

  async run() {
    this.state = 'running';
    this.emit({
      type: 'session',
      sessionId: this.id,
      topic: this.topic,
      mode: this.mode,
      pro: {
        name: this.agents.pro.name,
        model: this.agents.pro.cfg?.model || '',
        role: this.agents.pro.role,
      },
      con: {
        name: this.agents.con.name,
        model: this.agents.con.cfg?.model || '',
        role: this.agents.con.role,
      },
      debate: this.debate,
    });

    this.buildSchedule();
    await this.pump();
  }
}

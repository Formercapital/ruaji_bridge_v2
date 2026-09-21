/**
 * orchestration/inbound-flow.js — 入站主链路
 *
 * 顺序（每一步的位置都有理由）：
 *   0. 白名单门禁     非白名单私聊 / 非白名单群聊在规范化**之前**丢弃（媒体不落盘、不发 NapCat 请求）
 *   1. 规范化           NapCat 原始事件 → InboundMessage
 *   2. 去重             相同 messageId 只处理一次
 *   3. 记入滑窗         **在裁决之前**——被忽略的消息也要进上下文
 *   4. publish message.received  与是否回复无关，广播型，不阻塞
 *   5. 命令拦截         命令不发给模型
 *   6. 裁决             direct / auto / ignore
 *   7. 并发仲裁         主人打断 / 群友排队（附录 1）；无 @ 的 auto 插话遇在途直接丢弃（P2）
 *   8. 生成前二次频控   入队时放行、出队时已超限的排队项直接丢弃（堵住"排队绕过限速"）
 *   9. 防抖合并         800ms 内的多条消息并成一次生成；只合并同一个人（P1）
 *  10. 上下文聚合 → 生成 → 转换 → 发送
 *
 * 第 4 步的位置是关键：旧 Bridge 把 LivingMemory 广播放在所有 return 之前
 * （bridge.js:1162-1184，注释写明 "before any wake/ignore return"），
 * 保证记忆摄取不依赖回复路由。v2 沿用这一点，并把它变成正式的事件协议。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EVENTS, createEvent, newCorrelationId } from '../contracts/events.js';
import { ROUTES } from '../contracts/capabilities.js';
import { MESSAGE_TYPES, createInboundMessage } from '../contracts/messages.js';
import { classifyError } from '../contracts/errors.js';
import { getIdentityRole } from '../core/permission-policy.js';
import { evaluateRateLimit, resolveRateLimitPolicy } from '../core/rate-limit-policy.js';

export class InboundFlow {
  /**
   * @param {object} deps
   */
  constructor(deps = {}) {
    this.normalizer = deps.normalizer;
    this.dedup = deps.dedupStore;
    this.sessions = deps.sessionStore;
    this.eventBus = deps.eventBus;
    this.decisionFlow = deps.decisionFlow;
    this.contextFlow = deps.contextFlow;
    this.replyFlow = deps.replyFlow;
    this.inputStatus = deps.inputStatus ?? null;
    this.commandFlow = deps.commandFlow;
    /** 表情包收集会话要补拉 deferred 图片（见 _hydrateDeferredImages） */
    this.mediaIngestor = deps.mediaIngestor ?? null;
    this.affection = deps.affectionStore;
    this.memeStore = deps.memeStore ?? null;
    this.health = deps.health ?? null;
    this.shadow = deps.shadowRecorder ?? null;
    /** 可选：运维面板的追踪采集器，不注入就是 null，行为不变 */
    this.trace = deps.traceCollector ?? null;
    this.config = deps.config;
    this.log = deps.logger?.child({ component: 'inbound-flow' }) ?? console;
  }

  /**
   * 频控求值（现读活配置，与 decision-flow 共用同一份策略）。
   * 入站裁决与生成前复核都调它，保证两处口径一致。
   */
  _checkRateLimit(inbound) {
    return evaluateRateLimit(
      resolveRateLimitPolicy(inbound?.userId, inbound?.messageType, this.config),
      (userId, windowMs) => this.sessions.countRecentReplies(userId, windowMs),
    );
  }

  /**
   * NapCat 事件入口。永不抛异常——协议层的任何问题都不该拖垮 WebSocket 循环。
   * @param {object} rawEvent
   */
  async handleEvent(rawEvent) {
    const correlationId = newCorrelationId();
    try {
      await this._handle(rawEvent, correlationId);
    } catch (err) {
      const classified = classifyError(err, correlationId);
      this.log.error('入站链路异常', {
        correlationId,
        error: classified.message,
        stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
      });
    }
  }

  async _handle(rawEvent, correlationId) {
    // 私聊白名单门禁（第一道）：必须早于 normalize。normalize 内部会把图片/文件
    // 落盘并回拉引用消息（inbound-normalizer 的 _ingestMedia / _resolveQuote），
    // 非白名单用户不该有能力让我们写硬盘、发 NapCat 请求。
    if (
      rawEvent?.post_type === 'message' &&
      rawEvent.message_type !== 'group' &&
      String(rawEvent.user_id ?? '') !== String(this.config.identity?.robotId ?? '') &&
      !this._isPrivateAllowed(rawEvent.user_id)
    ) {
      this.health?.increment('messages', 'ignored');
      this.log.info('私聊非白名单用户，已在规范化前拦截丢弃', {
        correlationId,
        userId: String(rawEvent.user_id ?? ''),
        nickname: rawEvent.sender?.nickname ?? null,
      });
      return;
    }

    // 群聊白名单门禁（第一道）：与私聊门禁同理，必须早于 normalize——
    // 非白名单群的图片/文件不该被落盘，引用消息也不该被回拉。
    if (
      rawEvent?.post_type === 'message' &&
      rawEvent.message_type === 'group' &&
      !this._isGroupAllowed(rawEvent.group_id)
    ) {
      this.health?.increment('messages', 'ignored');
      this.log.info('群聊非白名单群，已在规范化前拦截丢弃', {
        correlationId,
        groupId: String(rawEvent.group_id ?? ''),
      });
      return;
    }

    const { message: inbound, dropped } = await this.normalizer.normalize(rawEvent, { correlationId });
    if (!inbound) {
      if (dropped && dropped !== 'not_a_message_event') {
        this.log.debug('消息已丢弃', { correlationId, reason: dropped });
      }
      return;
    }

    // 去重：NapCat 重连重推、多客户端并存时同一条消息会来两遍
    if (!this.dedup.markSeen(inbound.messageId)) {
      this.log.debug('重复消息，已丢弃', { correlationId, messageId: inbound.messageId });
      return;
    }

    // 私聊白名单门禁（第二道）：正常情况下第一道已经拦掉了，这里兜住归一化
    // 规则变化——normalizer 把一切非 group 的 message_type 都映射成 PRIVATE。
    // 拦在这里意味着：不进滑窗、不广播、不触发好感/表情包/大模型。
    if (inbound.messageType === MESSAGE_TYPES.PRIVATE && !this._isPrivateAllowed(inbound.userId)) {
      this.health?.increment('messages', 'ignored');
      this.log.info('私聊非白名单用户，已直接拦截丢弃', {
        correlationId,
        userId: inbound.userId,
        displayName: inbound.sender?.displayName,
      });
      return;
    }

    // 群聊白名单门禁（第二道）：正常情况下第一道已经拦掉了，这里兜住归一化
    // 规则变化——normalizer 把一切非 private 的 message_type 都映射成 GROUP。
    // 拦在这里意味着：不进滑窗、不广播、不触发好感/表情包/大模型。
    if (inbound.messageType === MESSAGE_TYPES.GROUP && !this._isGroupAllowed(inbound.groupId)) {
      this.health?.increment('messages', 'ignored');
      this.log.info('群聊非白名单群，已直接拦截丢弃', {
        correlationId,
        groupId: inbound.groupId,
      });
      return;
    }

    this.health?.increment('messages', 'received');

    // 滑窗要在裁决之前记，否则被忽略的群聊内容永远进不了上下文
    this.contextFlow.recordToWindow(inbound);

    // 广播：与是否回复无关
    this._publishReceived(inbound);

    // 好感度的"见过这个人"记录（仅旧体系）。Favour 模式下旧存储全面停写——
    // 互动时间由插件结算路径自己维护（合同第 7 条）。
    const legacyAffectionActive =
      !this.config.favourUltraEnabled || this.config.legacyAffectionEnabled === true;
    if (this.config.reply.sideEffectsEnabled && legacyAffectionActive) {
      try {
        this.affection.onUserMessage({ uid: inbound.userId, nickname: inbound.sender.displayName });
      } catch (err) {
        this.log.warn('好感度互动记录失败', { correlationId, error: err.message });
      }
    }

    // 表情包收集：处于收集会话中的用户发图自动入库
    let collectedCount = 0;
    if (this.memeStore?.isCollecting(inbound.userId) && Array.isArray(inbound.media)) {
      // 群聊非唤醒消息的图片默认不落盘（deferred）。收集会话是用户显式开启的
      // "我要存图"，这几张图必须真的入库，所以先按需补拉。
      await this._hydrateDeferredImages(inbound);
      for (const m of inbound.media) {
        if (m.kind === 'image' && m.localPath && fs.existsSync(m.localPath)) {
          try {
            const buf = fs.readFileSync(m.localPath);
            const item = this.memeStore.collectMeme({
              uid: inbound.userId,
              nickname: inbound.sender?.displayName ?? inbound.userId,
              filename: path.basename(m.localPath),
              buffer: buf,
              label: m.label,
            });
            if (item) collectedCount++;
          } catch (e) {
            this.log.error('收集表情处理异常', { error: e.message });
          }
        }
      }
    }

    // 命令：不发给模型
    const command = await this.commandFlow.handle(inbound);
    if (command.handled) {
      this.shadow?.record({ inbound, decision: { route: 'command', reason: command.command } });
      this.trace?.recordDecision(inbound.correlationId, {
        route: 'command',
        reason: command.command,
      });
      return;
    }

    // 处于表情包收集模式时：只要收录了图片且没有额外的实质提问文字，秒存即止，静默拦截
    if (this.memeStore?.isCollecting(inbound.userId) && (collectedCount > 0 || inbound.flags.hasImage)) {
      const cleanUserText = String(inbound.rawMessage || inbound.text || '')
        .replace(/\[CQ:[^\]]*\]/gi, '')
        .replace(/\[(?:图片|图片消息|screenshot|image|photo)\]/gi, '')
        .replace(/\s+/g, '')
        .trim();

      if (!cleanUserText) {
        this.log.info('表情包收集入库完毕，静默拦截，跳过模型生成', {
          correlationId,
          userId: inbound.userId,
          collectedCount,
        });
        return;
      }
    }

    const decision = await this.decisionFlow.decide(inbound);
    this.shadow?.record({ inbound, decision });
    this.trace?.recordDecision(inbound.correlationId, decision);

    if (decision.route === ROUTES.IGNORE) {
      this.health?.increment('messages', 'ignored');
      return;
    }

    const arbitration = await this.decisionFlow.arbitrateConcurrency(inbound, decision);
    if (arbitration.action === 'drop') {
      // 主动插话遇到在途生成：统一丢弃，不排队（P2，与 handleProactive 的 busy 行为一致）。
      // 消息已进本地滑窗（recordToWindow 在裁决前无条件执行），上下文不丢。
      // 与 route=ignore 同样记 ignored，否则这条只计 received、任何桶都不落账。
      this.health?.increment('messages', 'ignored');
      return;
    }
    if (arbitration.action === 'awaiting') {
      // 主人的补充已通过 Hermes 原生 redirect 并入在途轮：不打断、不排队、
      // 不触发新一轮生成（旧轮会带着修正继续跑完并投递）。只回一条带冷却的
      // 回执，让主人知道补充生效了——与 Hermes busy_ack 同款节奏，防刷屏。
      this._ackRedirect(inbound);
      return;
    }
    if (arbitration.action === 'queue') {
      this._buffer(inbound, decision);
      return;
    }

    this._buffer(inbound, decision);
    this._scheduleGeneration(inbound.executionKey);
  }

  /**
   * 表情包收集会话专用：把 deferred 图片补拉落盘。
   *
   * 群聊非唤醒消息默认不落盘（群聊媒体策略），但 /收集表情 是用户显式开启的
   * "我要存图"会话——后续图片必须真的入库，不能因为没 @ 就被策略挡在门外。
   * 只处理图片；落盘结果就地覆盖描述符，同时保留归属标注与 mface 标签。
   *
   * @returns {Promise<number>} 成功补拉的张数
   */
  async _hydrateDeferredImages(inbound) {
    const items = Array.isArray(inbound.media)
      ? inbound.media.filter((m) => m?.deferred === true && m.kind === 'image')
      : [];
    if (!this.mediaIngestor || items.length === 0) return 0;

    let hydrated = 0;
    for (const item of items) {
      try {
        const got = await this.mediaIngestor.ingestImage(
          { file: item.fileId ?? undefined, url: item.url ?? undefined },
          {},
        );
        if (!got) continue;
        Object.assign(item, got, {
          deferred: false,
          origin: item.origin,
          originAuthor: item.originAuthor,
          originIsBot: item.originIsBot,
          ...(item.label ? { label: item.label } : {}),
        });
        hydrated += 1;
      } catch (err) {
        this.log.warn('表情收集补拉图片失败', {
          correlationId: inbound.correlationId,
          error: err.message,
        });
      }
    }
    if (hydrated > 0) {
      this.log.debug('表情收集：deferred 图片已补拉落盘', {
        correlationId: inbound.correlationId,
        hydrated,
        total: items.length,
      });
    }
    return hydrated;
  }

  /**
   * redirect 回执。同会话 cooldownMs 内只发一条（主人连发多条补充时不刷屏），
   * 发送失败静默吞——回执只是提示，不影响已生效的 redirect。
   */
  _ackRedirect(inbound) {
    const ack = this.config.decision?.redirectAck;
    if (!ack?.enabled || !ack?.message) return;
    const now = Date.now();
    const last = this._lastRedirectAckAt?.get(inbound.executionKey) ?? 0;
    if (now - last < (ack.cooldownMs ?? 30000)) return;
    if (!this._lastRedirectAckAt) this._lastRedirectAckAt = new Map();
    this._lastRedirectAckAt.set(inbound.executionKey, now);
    try {
      this.commandFlow._reply(inbound, ack.message, '/redirect-ack');
    } catch (err) {
      this.log.warn('redirect 回执发送失败（忽略）', { correlationId: inbound.correlationId, error: err.message });
    }
  }

  /**
   * 排队超时巡检（decision.queueTimeout）。
   *
   * 在途生成迟迟不结束（上游慢 + 工具调用连环跑）时，排在缓冲里的消息
   * 会一直等下去。巡检器周期性扫一遍所有排队缓冲：等满 timeoutMs 的
   * 排队项直接从队列舍弃，并引用原消息回一条超时说明——堵着的人至少
   * 知道这条没被无视，后面再发也不会排在尸体后面。
   *
   * 巡检周期固定 5s（unref），超时判定每次 tick 现读配置，面板改完即热生效。
   */
  startQueueSweeper() {
    if (this._queueSweepTimer) return;
    this._queueSweepTimer = setInterval(() => {
      try {
        this._sweepQueueTimeout();
      } catch (err) {
        this.log.error('排队超时巡检异常', { error: err?.message ?? String(err) });
      }
    }, 5000);
    if (typeof this._queueSweepTimer.unref === 'function') this._queueSweepTimer.unref();
  }

  stopQueueSweeper() {
    if (!this._queueSweepTimer) return;
    clearInterval(this._queueSweepTimer);
    this._queueSweepTimer = null;
  }

  _sweepQueueTimeout() {
    const qt = this.config.decision?.queueTimeout;
    if (!qt || qt.enabled === false) return;
    const timeoutMs = Number(qt.timeoutMs);
    if (!(timeoutMs > 0)) return;

    const expired = this.sessions.drainExpiredPending(timeoutMs, this.sessions.now());
    if (!expired.length) return;

    // 按发言人归组：同一人的多条超时合成一条回执，引用其中最早的一条。
    // 不同的人各回各的，引用各自的消息。
    const byUser = new Map();
    for (const item of expired) {
      const uid = String(item.inbound.userId);
      const list = byUser.get(uid);
      if (list) list.push(item);
      else byUser.set(uid, [item]);
    }

    for (const items of byUser.values()) {
      const first = items[0].inbound;
      const base = qt.notice || '⏳ 这条消息排队太久，已超时舍弃~';
      const text = items.length > 1 ? `${base}（共 ${items.length} 条）` : base;
      this.log.info('排队消息超时，已从队列舍弃', {
        executionKey: first.executionKey,
        userId: first.userId,
        messageId: first.messageId,
        count: items.length,
      });
      try {
        // replyToMessageId 让回执带上引用气泡：OutboundBuilder 会把
        // [CQ:reply,id=…] 拼在消息最前，同时首段照常 @ 发送者。
        this.commandFlow._reply(first, text, '/queue-timeout', {
          replyToMessageId: first.messageId,
        });
      } catch (err) {
        this.log.warn('排队超时回执发送失败（忽略）', {
          correlationId: first.correlationId,
          error: err.message,
        });
      }
    }

    for (const item of expired) {
      this.health?.increment('messages', 'ignored');
    }
  }

  _publishReceived(inbound) {
    this.eventBus.publish(
      createEvent(EVENTS.MESSAGE_RECEIVED, {
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        timestamp: inbound.timestamp,
        payload: {
          messageId: inbound.messageId,
          selfId: inbound.selfId,
          userId: inbound.userId,
          groupId: inbound.groupId,
          messageType: inbound.messageType,
          rawMessage: inbound.rawMessage,
          text: inbound.text,
          content: inbound.content,
          nickname: inbound.sender.nickname,
          card: inbound.sender.card,
          displayName: inbound.sender.displayName,
          timestamp: inbound.timestamp,
          isAtBot: inbound.flags.isAtBot,
          isNameCall: inbound.flags.isNameCall,
          isOwner: inbound.flags.isOwner,
          hasImage: inbound.flags.hasImage,
          hasFile: inbound.flags.hasFile,
        },
      }),
    );
  }

  /**
   * 防抖缓冲：800ms 内的多条消息合并成一次生成。
   * 迁移自 bridge.js:1741-1798，但去掉了那里嵌套两层 setTimeout + 重复
   * 排队逻辑的结构（同一段逻辑在 :1744 与 :1775 各写了一遍）。
   *
   * queuedAt 记的是入队时刻——排队超时巡检（_sweepQueueTimeout）按它
   * 判定"这条已经在队列里等了多久"。
   */
  _buffer(inbound, decision) {
    const buf = this.sessions.getBuffer(inbound.executionKey);
    buf.pending.push({ inbound, decision, queuedAt: this.sessions.now() });
  }

  _scheduleGeneration(executionKey) {
    const buf = this.sessions.getBuffer(executionKey);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      buf.timer = null;
      this._runGeneration(executionKey).catch((err) => {
        this.log.error('生成任务异常', { executionKey, error: err.message });
      });
    }, this.config.decision.debounceMs);
    if (typeof buf.timer.unref === 'function') buf.timer.unref();
  }

  async _runGeneration(executionKey) {
    await this.sessions.waitForStop(executionKey);
    if (this.sessions.isBusy(executionKey)) return;
    const pending = this.sessions.drainBuffer(executionKey);
    if (pending.length === 0) return;

    // 生成前二次频控。裁决那一关是在**入队时**过的：在途生成期间排队的消息当时
    // 计数还没到阈值（典型：群聊被顶住时同一人连发三五条），等轮到它生成时限额
    // 早已用满。不在这里复核的话，"排队"就是绕过限速的正式后门。
    // 只丢超限用户自己的排队项，其余人照常——被丢的人不占别人的位，也不会饿死别人。
    const admitted = [];
    const suppressed = [];
    for (const item of pending) {
      if (this._checkRateLimit(item.inbound).limited) suppressed.push(item);
      else admitted.push(item);
    }
    if (suppressed.length > 0) {
      const sample = suppressed[0].inbound;
      this.log.warn('排队期间已触发频控，排队项直接丢弃', {
        executionKey,
        userId: sample.userId,
        displayName: sample.sender?.displayName,
        dropped: suppressed.length,
      });
      for (let i = 0; i < suppressed.length; i++) this.health?.increment('messages', 'ignored');
    }
    if (admitted.length === 0) {
      // 本轮没有可回的人；排队期间可能又进来了新消息，照常调下一轮
      const buf = this.sessions.getBuffer(executionKey);
      if (buf.pending.length > 0 && !buf.timer) this._scheduleGeneration(executionKey);
      return;
    }

    // 只合并同一个人的消息，其余人原序退回队列等下一轮（P1）
    const { batch, rest } = splitBySpeaker(admitted);
    if (rest.length > 0) {
      this.sessions.requeue(executionKey, rest);
      this.log.info('排队批次按发言人切分，其余人留待下一轮', {
        executionKey,
        replyingTo: batch[0].inbound.userId,
        merged: batch.length,
        requeued: rest.length,
      });
    }

    // 合并：内容按换行拼接，身份字段取最后一条，裁决取批次里最强的一条
    const merged = mergeBatch(batch);
    const { inbound, decision } = merged;

    const controller = new AbortController();
    this.sessions.beginExecution(executionKey, {
      controller,
      source: decision.route,
      correlationId: inbound.correlationId,
      sessionKey: inbound.executionKey,
    });

    // 门禁、去重、裁决与防抖均已通过；提示覆盖上下文、模型和分段投递。
    const stopInputStatus = this.inputStatus?.start(inbound, { signal: controller.signal });
    try {
      const { blocks, intercepted, reply } = await this.contextFlow.collect(inbound, {
        triggerType: decision.triggerType,
        signal: controller.signal,
      });

      if (intercepted) {
        if (reply) this.commandFlow._reply(inbound, reply, '/favour-intercept');
        this.health?.increment('messages', 'ignored');
        return;
      }

      const result = await this.replyFlow.run({
        inbound,
        triggerType: decision.triggerType,
        contextBlocks: blocks,
        signal: controller.signal,
      });

      if (result.status === 'ok') {
        this.health?.increment('messages', 'replied');
        // 计数只对"当前确实受频控约束"的用户发生（名单内，且私聊未启用时私聊不计），
        // 防止私聊回复把群聊的额度提前烧掉。windowMs 用该用户实际生效的窗口。
        const policy = resolveRateLimitPolicy(inbound.userId, inbound.messageType, this.config);
        if (policy) this.sessions.recordReply(policy.userId, policy.windowMs);
        this.shadow?.recordReply({ inbound, decision, result, contextBlocks: blocks });
      }

      // 强一致性时序：等本轮发完再放开下一轮，防止回答错位
      await this.replyFlow.waitForDelivery(inbound);
    } catch (err) {
      const classified = classifyError(err, inbound.correlationId);
      if (classified.preempted) {
        this.log.info('本轮生成被主人打断', { correlationId: inbound.correlationId });
      } else {
        this.log.error('生成失败', { correlationId: inbound.correlationId, error: classified.message });
        this.trace?.recordError(inbound.correlationId, classified.message);
      }
    } finally {
      stopInputStatus?.();
      this.sessions.endExecution(executionKey, controller);
      // 排队期间积压的消息：本轮结束后再跑一次
      const buf = this.sessions.getBuffer(executionKey);
      if (buf.pending.length > 0 && !buf.timer) this._scheduleGeneration(executionKey);
    }
  }

  /**
   * 外部触发的主动接话（旧 /api/dispatch_auto_reply → onAutoReply）。
   * v2 把它建模成一次合成的 InboundMessage 走同一条链路，
   * 从而复用全套隐式注入、流式切句、好感度剥离与审计。
   */
  async handleProactive({ groupId, userId, nickname, message, messageId }) {
    const executionKey = `group_${groupId}`;
    if (this.sessions.isBusy(executionKey)) {
      this.log.info('该群已有在途生成，丢弃本次主动接话', { groupId });
      return { accepted: false, reason: 'busy' };
    }

    const correlationId = newCorrelationId();
    const inbound = createInboundMessage({
      correlationId,
      messageId: String(messageId ?? `auto_${Date.now()}`),
      timestamp: Math.floor(Date.now() / 1000),
      platform: 'qq',
      selfId: String(this.config.identity.robotId),
      userId: String(userId ?? '0'),
      groupId: String(groupId),
      sessionId: `qq:group:${groupId}`,
      executionKey,
      messageType: MESSAGE_TYPES.GROUP,
      rawMessage: String(message ?? ''),
      text: String(message ?? ''),
      content: String(message ?? ''),
      segments: [],
      sender: { nickname: nickname ?? '群友', card: '', displayName: nickname ?? '群友' },
      flags: {
        isOwner: String(userId) === String(this.config.identity.ownerId),
        isAdmin: getIdentityRole(userId, this.config.identity) === 'admin',
        role: getIdentityRole(userId, this.config.identity),
      },
      media: [],
      extensions: { napcat: {}, proactive: true },
    });

    // 外部主动接话以前完全绕过频控（它不经过 decisionFlow.decide），名单内的
    // 用户只要被宿主点名“主动接话”就能无限拿到回复。这里补上同一把尺子。
    const limit = this._checkRateLimit(inbound);
    if (limit.limited) {
      this.log.warn(limit.blocked ? '主动接话被严格拦截' : '主动接话被频控拦截', {
        correlationId,
        groupId,
        userId: limit.policy.userId,
        count: limit.count,
        limit: limit.policy.maxReplies,
        windowMs: limit.policy.windowMs,
      });
      return { accepted: false, reason: limit.blocked ? 'blocked' : 'rate_limited' };
    }

    this._buffer(inbound, { route: ROUTES.AUTO, triggerType: 'ai_decision', reason: 'external_dispatch' });
    this._scheduleGeneration(executionKey);
    return { accepted: true };
  }

  _isPrivateAllowed(userId) {
    const uid = String(userId ?? '').trim();
    const ownerId = String(this.config.identity?.ownerId ?? '').trim();
    if (ownerId && uid === ownerId) return true;

    const whitelist = this.config.identity?.privateWhitelist;
    if (!Array.isArray(whitelist) || whitelist.length === 0) {
      return false;
    }
    return whitelist.map((id) => String(id).trim()).includes(uid);
  }

  /**
   * 群聊白名单（与私聊相反：**fail-open**）。
   *
   * 未配置 / 不是数组 / 空数组 = 全部群聊照常放行（完全向后兼容旧配置）；
   * 一旦填了名单，就只放行名单内的群，其余在入口处直接丢弃。
   * 群号与名单项都做 String+trim 归一化，兼容手写 JSON 时的数字写法。
   */
  _isGroupAllowed(groupId) {
    const whitelist = this.config.identity?.groupWhitelist;
    if (!Array.isArray(whitelist) || whitelist.length === 0) return true;

    const gid = String(groupId ?? '').trim();
    return whitelist.map((id) => String(id).trim()).includes(gid);
  }
}

/**
 * 从排队缓冲里切出本轮要合并的一组：**只合并同一个人的消息**。
 *
 * 不同人的话绝不合并（P1）。合并后只剩一个身份，而"@ 回谁"（replyToUserId）与
 * "扣谁的好感"（affection 中间件读 inbound.userId）都只认这一个身份——两个群友的话
 * 挂在一个人名下，回复也只 @ 得到其中一个，另一个等于被无视。
 *
 * 锚定谁：队列里有主人就先答主人，否则按 FIFO 取第一条的作者。前者是为了不让
 * 打断特权（附录 1）被队列里先到的群友挤掉——主人刚 abort 掉在途生成，结果这一轮
 * 回的是别人，特权就白给了。
 *
 * 锚定用户的消息一次答完，其余人原序留在队列里，由 _runGeneration 的 finally
 * 重新调度下一轮。每轮至少清掉一个人，不会饿死。
 *
 * @param {{ inbound: object, decision: object }[]} pending
 * @returns {{ batch: object[], rest: object[] }}
 */
export function splitBySpeaker(pending) {
  const anchorItem = pending.find((p) => p.inbound.flags?.isOwner) ?? pending[0];
  const anchorUserId = String(anchorItem.inbound.userId);

  const batch = [];
  const rest = [];
  for (const item of pending) {
    if (String(item.inbound.userId) === anchorUserId) batch.push(item);
    else rest.push(item);
  }
  return { batch, rest };
}

/**
 * 合并一批防抖消息：内容换行拼接，身份字段取最新一条，裁决取最强一条。
 * 调用方保证批次内是同一个人（splitBySpeaker）。extensions.batch 仍逐条保留
 * messageId/时间/身份/正文——渲染层据此一行一条，时间戳不会被末条统一顶掉，
 * 万一将来又有人把跨用户合并接回来，逐条标名也能兜住（P1）。
 */
export function mergeBatch(batch) {
  const last = batch.at(-1);
  if (batch.length === 1) return last;

  const merged = {
    ...last.inbound,
    content: batch.map((b) => b.inbound.content).filter(Boolean).join('\n'),
    text: batch.map((b) => b.inbound.text).filter(Boolean).join('\n'),
    media: batch.flatMap((b) => b.inbound.media ?? []),
    flags: {
      ...last.inbound.flags,
      hasImage: batch.some((b) => b.inbound.flags?.hasImage === true),
    },
    extensions: {
      ...last.inbound.extensions,
      batch: batch.map((b) => ({
        messageId: b.inbound.messageId,
        timestamp: b.inbound.timestamp,
        userId: b.inbound.userId,
        displayName: b.inbound.sender?.displayName ?? '',
        content: b.inbound.content,
      })),
    },
  };

  // 裁决取批次里最强的一条（direct > auto），不是无脑取最后一条：@ 消息与 auto
  // 插话落在同一个防抖窗口时，末条通吃会把被 @ 的人当成"主动插话"来回复——
  // 不 @ 回、不评好感、systemText 走主人同款分支。同强度取较新的那条。
  const strongest = batch.filter((b) => b.decision?.route === ROUTES.DIRECT).at(-1) ?? last;
  return { inbound: merged, decision: strongest.decision };
}

/**
 * 排队超时（decision.queueTimeout）：
 *   - 在途生成久堵时，等满 timeoutMs 的排队项从队列舍弃，其余原序保留
 *   - 舍弃时按发言人归组回执：一人一条，引用其最早超时的那条（replyToMessageId）
 *   - enabled=false / timeoutMs<=0 时恒不触发
 *   - OutboundBuilder 把 [CQ:reply,id=…] 拼在消息最前（OneBot v11 约定），
 *     且不被字面 CQ 转义实体化
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { EventBus } from '../../src/core/event-bus.js';
import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { createOutboundMessage } from '../../src/contracts/messages.js';
import { buildNapcatPayload } from '../../src/adapters/napcat/outbound-builder.js';
import { createTestLogger } from '../helpers.js';

const GROUP_ID = 1076958977;
const EXECUTION_KEY = `group_${GROUP_ID}`;
const TIMEOUT_MS = 120000;

function createTestInboundFlow({ queueTimeout } = {}) {
  const logger = createTestLogger();
  const config = {
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      botName: '瑞姬',
      rateLimitUsers: [],
      privateWhitelist: ['10000001'],
    },
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    decision: {
      // 防抖拉长：测试窗口内 timer 不会真的触发生成
      debounceMs: 60000,
      rateLimit: { maxReplies: 5, windowMs: 300000 },
      localWindowInject: 15,
      queueTimeout: queueTimeout ?? { enabled: true, timeoutMs: TIMEOUT_MS, notice: '⏳ 排队超时了~' },
    },
    reply: { sendEnabled: false, sideEffectsEnabled: true },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
  };

  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });
  const sessionStore = new SessionStore();
  const eventBus = new EventBus({ logger });
  const aggregator = new ContextAggregator({ totalBudget: 12000, perSourceBudget: 4000, logger });
  const contextFlow = new ContextFlow({ aggregator, sessionStore, config, logger });
  const commandFlow = new CommandFlow({ sessionStore, config, logger });

  const health = {
    counters: {},
    increment(group, key) {
      this.counters[`${group}.${key}`] = (this.counters[`${group}.${key}`] ?? 0) + 1;
    },
  };

  const inboundFlow = new InboundFlow({
    normalizer,
    dedupStore: new DedupStore(),
    sessionStore,
    eventBus,
    decisionFlow: {
      decide: async () => ({ route: 'direct', triggerType: 'at', reason: 'stub', providerId: null }),
      arbitrateConcurrency: async () => ({ action: 'queue' }),
    },
    contextFlow,
    replyFlow: null,
    commandFlow,
    affectionStore: null,
    memeStore: null,
    health,
    config,
    logger,
  });

  return { inboundFlow, sessionStore, config, health, commandFlow };
}

function groupRawEvent({ messageId, userId, nickname, text }) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: GROUP_ID,
    user_id: userId,
    self_id: 398276230,
    raw_message: text,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname, card: '' },
  };
}

async function queueMessage(flow, { messageId, userId, nickname, text }) {
  await flow.inboundFlow.handleEvent(groupRawEvent({ messageId, userId, nickname, text }));
}

/** 把缓冲里的排队项统一回拨 ageMs，模拟"已经等了这么久" */
function backdate(sessionStore, executionKey, ageMs) {
  for (const item of sessionStore.getBuffer(executionKey).pending) {
    item.queuedAt -= ageMs;
  }
}

test('排队超时：过期项被舍弃，按发言人归组回执并引用最早那条', async () => {
  const flow = createTestInboundFlow();
  const controller = new AbortController();
  flow.sessionStore.beginExecution(EXECUTION_KEY, { controller, source: 'direct', correlationId: 'c1' });

  await queueMessage(flow, { messageId: 90001, userId: 2260757842, nickname: '御娘狼三千', text: '瑞姬看看这个' });
  await queueMessage(flow, { messageId: 90002, userId: 2260757842, nickname: '御娘狼三千', text: '还在吗' });
  await queueMessage(flow, { messageId: 90003, userId: 333, nickname: '路人甲', text: '[CQ:at,qq=398276230] 帮我查下' });
  backdate(flow.sessionStore, EXECUTION_KEY, TIMEOUT_MS + 5000);

  const notices = [];
  flow.commandFlow._reply = (inbound, text, command, extraMetadata) => {
    notices.push({ inbound, text, command, extraMetadata });
    return { handled: true, command };
  };

  flow.inboundFlow._sweepQueueTimeout();

  assert.equal(flow.sessionStore.getBuffer(EXECUTION_KEY).pending.length, 0, '过期排队项应全部舍弃');
  assert.equal(notices.length, 2, '两个发言人各回一条');
  assert.equal(flow.health.counters['messages.ignored'], 3, '每条被舍弃的消息都要落 ignored 账');

  const [a, b] = notices;
  assert.equal(a.inbound.userId, '2260757842');
  assert.equal(a.extraMetadata.replyToMessageId, '90001', '引用该用户最早超时的那条');
  assert.equal(a.text, '⏳ 排队超时了~（共 2 条）', '同一人多条合并计数');
  assert.equal(a.command, '/queue-timeout');

  assert.equal(b.inbound.userId, '333');
  assert.equal(b.extraMetadata.replyToMessageId, '90003');
  assert.equal(b.text, '⏳ 排队超时了~');

  assert.equal(controller.signal.aborted, false, '巡检不得打断在途生成');
});

test('排队超时：未过期的排队项原序保留，不影响在途生成', async () => {
  const flow = createTestInboundFlow();
  flow.sessionStore.beginExecution(EXECUTION_KEY, {
    controller: new AbortController(),
    source: 'direct',
    correlationId: 'c2',
  });

  await queueMessage(flow, { messageId: 91001, userId: 2260757842, nickname: '御娘狼三千', text: '先发的' });
  backdate(flow.sessionStore, EXECUTION_KEY, TIMEOUT_MS + 1000);
  await queueMessage(flow, { messageId: 91002, userId: 2260757842, nickname: '御娘狼三千', text: '后发的' });

  const notices = [];
  flow.commandFlow._reply = (inbound, text, command, extraMetadata) => {
    notices.push({ inbound, text, command, extraMetadata });
    return { handled: true, command };
  };

  flow.inboundFlow._sweepQueueTimeout();

  const pending = flow.sessionStore.getBuffer(EXECUTION_KEY).pending;
  assert.equal(pending.length, 1, '只有过期那条被舍弃');
  assert.equal(pending[0].inbound.messageId, '91002', '未过期的按原序留在队列');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].extraMetadata.replyToMessageId, '91001');
});

test('排队超时：enabled=false 或 timeoutMs<=0 时恒不触发', async () => {
  for (const queueTimeout of [{ enabled: false, timeoutMs: TIMEOUT_MS, notice: 'x' }, { enabled: true, timeoutMs: 0, notice: 'x' }]) {
    const flow = createTestInboundFlow({ queueTimeout });
    await queueMessage(flow, { messageId: 92001, userId: 2260757842, nickname: '御娘狼三千', text: '瑞姬' });
    backdate(flow.sessionStore, EXECUTION_KEY, TIMEOUT_MS * 10);

    const notices = [];
    flow.commandFlow._reply = (inbound, text, command) => {
      notices.push(text);
      return { handled: true, command };
    };

    flow.inboundFlow._sweepQueueTimeout();
    assert.equal(flow.sessionStore.getBuffer(EXECUTION_KEY).pending.length, 1, '关闭时排队项保留');
    assert.equal(notices.length, 0);
  }
});

test('drainExpiredPending：缺 queuedAt 的项按未过期保留，maxAge<=0 恒返回空', () => {
  const store = new SessionStore();
  const buf = store.getBuffer('group_1');
  buf.pending.push({ inbound: { messageId: 'a' }, decision: {} }); // 无 queuedAt
  buf.pending.push({ inbound: { messageId: 'b' }, decision: {}, queuedAt: 1000 });

  assert.deepEqual(store.drainExpiredPending(0), [], 'maxAge<=0 视为关闭');
  assert.equal(buf.pending.length, 2, '关闭时不碰队列');

  // now=2000, maxAge=500：b（queuedAt=1000，已等 1000ms）过期；a 缺 queuedAt 按未过期保留
  const expired = store.drainExpiredPending(500, 2000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].inbound.messageId, 'b');
  assert.equal(buf.pending.length, 1);
  assert.equal(buf.pending[0].inbound.messageId, 'a', '缺 queuedAt 的项不得被误判过期');
});

test('buildNapcatPayload：replyToMessageId 前置 [CQ:reply,id=…] 且不被转义', () => {
  const payload = buildNapcatPayload(
    createOutboundMessage({
      correlationId: 'c',
      sessionId: 's',
      target: { type: 'group', id: '123' },
      replyToUserId: '456',
      text: 'hi [CQ:image,file=x]',
      metadata: { isFirst: true, replyToMessageId: '789' },
    }),
  );
  assert.equal(payload.message, '[CQ:reply,id=789][CQ:at,qq=456] hi &#91;CQ:image,file=x&#93;');
});

test('buildNapcatPayload：无 replyToMessageId 时不添加 reply 段', () => {
  const payload = buildNapcatPayload(
    createOutboundMessage({
      correlationId: 'c',
      sessionId: 's',
      target: { type: 'group', id: '123' },
      replyToUserId: '456',
      text: 'hi',
      metadata: { isFirst: true },
    }),
  );
  assert.equal(payload.message, '[CQ:at,qq=456] hi');
});

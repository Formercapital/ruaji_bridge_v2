import test from 'node:test';
import assert from 'node:assert/strict';

import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { EventBus } from '../../src/core/event-bus.js';
import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { DecisionFlow } from '../../src/orchestration/decision-flow.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { AffectionStore } from '../../src/storage/affection-store.js';
import { createTestLogger } from '../helpers.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function createTestInboundFlow(configOverrides = {}) {
  const logger = createTestLogger();
  const { dropGroupWhitelist = false, ...rest } = configOverrides;

  const identity = {
    ownerId: '10000001',
    robotId: '398276230',
    botName: '瑞姬',
    rateLimitUsers: [],
    privateWhitelist: ['10000001', '10000003'],
    groupWhitelist: [],
    ...(configOverrides.identity ?? {}),
  };

  const config = {
    identity,
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    decision: { debounceMs: 800, rateLimit: { maxReplies: 5, windowMs: 300000 }, localWindowSize: 15 },
    reply: { sendEnabled: false, sideEffectsEnabled: true },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
    ...rest,
    identity,
  };

  // 模拟"老配置升级上来、文件里根本没写这个键"
  if (dropGroupWhitelist) delete config.identity.groupWhitelist;

  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });
  // normalize 内部会落盘媒体并回拉引用消息，所以"有没有被调用"本身就是一项断言
  const normalizeCalls = [];
  const originalNormalize = normalizer.normalize.bind(normalizer);
  normalizer.normalize = async (rawEvent, ctx) => {
    normalizeCalls.push(rawEvent);
    return originalNormalize(rawEvent, ctx);
  };

  const healthCalls = [];
  const health = { increment: (section, field) => healthCalls.push(`${section}.${field}`) };
  const dedupStore = new DedupStore();
  const sessionStore = new SessionStore();
  const eventBus = new EventBus({ logger });
  const aggregator = new ContextAggregator({ totalBudget: 12000, perSourceBudget: 4000, logger });
  const contextFlow = new ContextFlow({ aggregator, sessionStore, config, logger });
  const capabilityBus = new CapabilityBus({ logger });
  const decisionFlow = new DecisionFlow({ capabilityBus, sessionStore, normalizer, config, logger });
  const commandFlow = new CommandFlow({ sessionStore, config, logger });
  const affectionStore = new AffectionStore({ ownerId: config.identity.ownerId, persistEnabled: false, logger });

  const inboundFlow = new InboundFlow({
    normalizer,
    dedupStore,
    sessionStore,
    eventBus,
    decisionFlow,
    contextFlow,
    replyFlow: null,
    commandFlow,
    affectionStore,
    memeStore: null,
    health,
    config,
    logger,
  });

  return { inboundFlow, eventBus, sessionStore, healthCalls, normalizeCalls, config };
}

/** NapCat 侧一条普通群聊消息 */
function groupEvent({ messageId, groupId, userId = 999999999, rawMessage = '群里说话' }) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    self_id: 398276230,
    raw_message: rawMessage,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: '普通群友', card: '' },
  };
}

// ---------------------------------------------------------------------------
// 向后兼容：没配 / 空数组 / 类型不对 = 全部放行
// ---------------------------------------------------------------------------

test('群聊白名单：配置里没有 groupWhitelist 键时，所有群聊照常放行（向后兼容）', async () => {
  const { inboundFlow, eventBus, sessionStore, config } = createTestInboundFlow({
    dropGroupWhitelist: true,
  });
  assert.equal(config.identity.groupWhitelist, undefined);

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-legacy', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20001, groupId: 1076958977 }));
  await flush();

  assert.ok(receivedEvent, '缺省该键时群聊必须照常放行，不能把老配置的群聊全锁死');
  assert.equal(receivedEvent.payload.groupId, '1076958977');
  assert.ok(
    sessionStore.getContextWindow('qq:group:1076958977').length > 0,
    '缺省该键时群聊消息应正常进入滑窗',
  );
});

test('群聊白名单：groupWhitelist 为空数组时，所有群聊照常放行（向后兼容）', async () => {
  const { inboundFlow, eventBus, sessionStore } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: [] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-empty', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20002, groupId: 1076958977 }));
  await flush();

  assert.ok(receivedEvent, '空名单＝全部放行');
  assert.ok(sessionStore.getContextWindow('qq:group:1076958977').length > 0, '空名单下群聊消息照常进滑窗');
});

test('群聊白名单：groupWhitelist 不是数组（手滑写成字符串/null）时按未配置处理，全部放行', async () => {
  for (const bad of ['1076958977', null, {}, 123]) {
    const { inboundFlow } = createTestInboundFlow({
      identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: bad },
    });
    assert.equal(
      inboundFlow._isGroupAllowed('1076958977'),
      true,
      `groupWhitelist=${JSON.stringify(bad)} 时应当 fail-open 全部放行`,
    );
    assert.equal(inboundFlow._isGroupAllowed('999999999'), true, '类型非法时不能误伤任何群');
  }
});

// ---------------------------------------------------------------------------
// 命中名单
// ---------------------------------------------------------------------------

test('群聊白名单：名单内的群聊正常放行（进滑窗、广播、好感度记录）', async () => {
  const { inboundFlow, eventBus, sessionStore } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-hit', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20003, groupId: 1076958977 }));
  await flush();

  assert.ok(receivedEvent, '白名单内的群必须放行并广播 message.received');
  assert.equal(receivedEvent.payload.groupId, '1076958977');
  assert.ok(
    sessionStore.getContextWindow('qq:group:1076958977').length > 0,
    '白名单内的群消息必须进入滑窗',
  );
});

test('群聊白名单：名单写成数字（非字符串）也能正确匹配', async () => {
  const { inboundFlow, eventBus } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: [1076958977] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-num', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20004, groupId: 1076958977 }));
  await flush();

  assert.ok(receivedEvent, '数字型白名单条目应与字符串 groupId 等价匹配');
});

test('群聊白名单：群号是数字、名单项带空格时也等价匹配（String + trim 归一化）', async () => {
  const { inboundFlow, eventBus } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: [' 1076958977 '] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-trim', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20005, groupId: 1076958977 }));
  await flush();

  assert.ok(receivedEvent, '数字 group_id 与带空格的字符串名单项应当匹配');
});

// ---------------------------------------------------------------------------
// 名单外拦截
// ---------------------------------------------------------------------------

test('群聊白名单：名单外的群聊在 normalize 之前就被拦掉（不落盘、不进滑窗、不广播）', async () => {
  const { inboundFlow, eventBus, sessionStore, healthCalls, normalizeCalls } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-miss', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent(
    groupEvent({
      messageId: 20006,
      groupId: 888888888, // 非白名单群
      rawMessage: '[CQ:image,file=spam.jpg,url=http://127.0.0.1:1/spam.jpg]',
    }),
  );
  await flush();

  assert.equal(
    normalizeCalls.length,
    0,
    '门禁必须早于 normalize：否则非白名单群的图片/文件会先落盘、引用消息会先回拉',
  );
  assert.equal(receivedEvent, null, '非白名单群绝不能广播 message.received');
  assert.equal(
    sessionStore.getContextWindow('qq:group:888888888').length,
    0,
    '非白名单群的消息绝不能进入滑窗',
  );
  assert.ok(healthCalls.includes('messages.ignored'), '被拦截的群聊要计入 messages.ignored');
  assert.ok(!healthCalls.includes('messages.received'), '被拦截的群聊不能计入 messages.received');
});

test('群聊白名单：第二道门禁兜底 —— 规范化后配置被热改成不放行，也要拦得住', async () => {
  const { inboundFlow, eventBus, sessionStore, healthCalls, normalizeCalls } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-backstop', async (e) => {
    receivedEvent = e;
  });

  // 模拟两道门禁之间的配置竞态：第一道放行，第二道（normalize 之后）已判定非白名单。
  // 只 stub 判定函数，不碰链路本身——这样才真的在测第二道门禁的位置。
  let calls = 0;
  inboundFlow._isGroupAllowed = () => {
    calls += 1;
    return calls === 1;
  };

  await inboundFlow.handleEvent(groupEvent({ messageId: 20007, groupId: 1076958977 }));
  await flush();

  assert.equal(normalizeCalls.length, 1, '第一道门禁放行，消息应当被规范化');
  assert.equal(receivedEvent, null, '第二道门禁必须兜住：规范化后仍不得广播');
  assert.equal(
    sessionStore.getContextWindow('qq:group:1076958977').length,
    0,
    '第二道门禁必须兜住：不得进滑窗',
  );
  assert.ok(healthCalls.includes('messages.ignored'), '第二道门禁拦截也要计入 messages.ignored');
});

test('群聊白名单：空群号不会因为名单里有空字符串而放行（fail-closed）', () => {
  const { inboundFlow } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  assert.equal(inboundFlow._isGroupAllowed(null), false, '空 groupId 不能匹配白名单');
  assert.equal(inboundFlow._isGroupAllowed(''), false, '空字符串 groupId 不能匹配白名单');
  assert.equal(inboundFlow._isGroupAllowed('  '), false, '纯空格 groupId 不能匹配白名单');

  const { inboundFlow: withBlank } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: [''] },
  });
  assert.equal(withBlank._isGroupAllowed(''), true, '名单里显式写了空串时按字面匹配（trim 后相等）');
});

// ---------------------------------------------------------------------------
// 与其他链路的关系
// ---------------------------------------------------------------------------

test('群聊白名单：不影响私聊白名单链路 —— 配了群聊名单，白名单私聊照常放行', async () => {
  const { inboundFlow, eventBus } = createTestInboundFlow({
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      privateWhitelist: ['10000003'],
      groupWhitelist: ['1076958977'],
    },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'gw-sub-private', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 20008,
    user_id: 10000003,
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  });
  await flush();

  assert.ok(receivedEvent, '群聊白名单不能误伤私聊链路');
  assert.equal(receivedEvent.payload.userId, '10000003');
});

test('群聊白名单：非消息事件（notice 等）不受门禁影响', async () => {
  const { inboundFlow, normalizeCalls } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  await inboundFlow.handleEvent({ post_type: 'notice', notice_type: 'group_increase', group_id: 888888888 });
  await flush();

  // notice 事件会被 normalize 判成 not_a_message_event 丢弃，但门禁不该在它之前误拦
  assert.equal(normalizeCalls.length, 1, '非 message 事件必须照常交给 normalizer 判定');
});

// ---------------------------------------------------------------------------
// 热更新
// ---------------------------------------------------------------------------

test('群聊白名单：热更新 config.identity.groupWhitelist 后立即生效（无需重启）', async () => {
  const { inboundFlow, eventBus, config } = createTestInboundFlow({
    identity: { ownerId: '10000001', robotId: '398276230', groupWhitelist: ['1076958977'] },
  });

  const received = [];
  eventBus.subscribe('message.received', 'gw-sub-hot', async (e) => {
    received.push(e.payload.groupId);
  });

  await inboundFlow.handleEvent(groupEvent({ messageId: 20009, groupId: 888888888 }));
  await flush();
  assert.deepEqual(received, [], '加白之前应被拦截');

  // 面板 PUT /api/config 就是这样 Object.assign 到运行态的
  config.identity.groupWhitelist = ['1076958977', '888888888'];

  await inboundFlow.handleEvent(groupEvent({ messageId: 20010, groupId: 888888888 }));
  await flush();
  assert.deepEqual(received, ['888888888'], '加白之后同一群应立刻放行');

  // 反向：热更新收窄名单后，原本放行的群应当立刻被拦
  config.identity.groupWhitelist = ['1076958977'];

  await inboundFlow.handleEvent(groupEvent({ messageId: 20011, groupId: 888888888 }));
  await flush();
  assert.deepEqual(received, ['888888888'], '收窄名单后原放行群应立刻恢复拦截');

  // 清空名单 = 恢复全部放行，同样立刻生效
  config.identity.groupWhitelist = [];

  await inboundFlow.handleEvent(groupEvent({ messageId: 20012, groupId: 123123123 }));
  await flush();
  assert.deepEqual(received, ['888888888', '123123123'], '清空名单后应立刻恢复全部放行');
});

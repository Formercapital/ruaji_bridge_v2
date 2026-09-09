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
  const { dropPrivateWhitelist = false } = configOverrides;
  const config = {
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      botName: '瑞姬',
      rateLimitUsers: [],
      privateWhitelist: ['10000001', '10000003'],
      ...(configOverrides.identity ?? {}),
    },
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    decision: { debounceMs: 800, rateLimit: { maxReplies: 5, windowMs: 300000 }, localWindowSize: 15 },
    reply: { sendEnabled: false, sideEffectsEnabled: true },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
    ...configOverrides,
  };

  // 模拟"老配置升级上来、文件里根本没写这个键"
  if (dropPrivateWhitelist) delete config.identity.privateWhitelist;

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

  return { inboundFlow, eventBus, sessionStore, affectionStore, config, normalizeCalls, healthCalls };
}

test('私聊白名单：白名单内用户放行，进入广播并记录好感度', async () => {
  const { inboundFlow, eventBus, affectionStore } = createTestInboundFlow();

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-1', async (e) => {
    receivedEvent = e;
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10001,
    user_id: 10000003,
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  assert.ok(receivedEvent, '白名单用户应成功广播 message.received');
  assert.equal(receivedEvent.payload.userId, '10000003');

  const aff = affectionStore.data.users['10000003'];
  assert.ok(aff, '白名单用户的互动应当被好感度模块记录');
});

test('私聊白名单：Favour 模式下不再写旧好感存储（合同第 7 条，P0 门控）', async () => {
  const { inboundFlow, eventBus, affectionStore } = createTestInboundFlow({
    favourUltraEnabled: true,
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-favour-gate', async (e) => {
    receivedEvent = e;
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10011,
    user_id: 10000003,
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  // 广播、滑窗等其余链路不受门控影响
  assert.ok(receivedEvent, '广播 message.received 不受好感门控影响');

  const aff = affectionStore.data.users['10000003'];
  assert.equal(aff, undefined, 'Favour 模式下 onUserMessage 不得被调用，旧存储零写入');
});

test('私聊白名单：Favour 模式下显式 legacyAffectionEnabled=true 才保留旧记录', async () => {
  const { inboundFlow, affectionStore } = createTestInboundFlow({
    favourUltraEnabled: true,
    legacyAffectionEnabled: true,
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10012,
    user_id: 10000003,
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  const aff = affectionStore.data.users['10000003'];
  assert.ok(aff, '显式回开旧体系时，"见过这个人"记录应照常工作');
});

test('私聊白名单：非白名单用户被直接拦截，不进滑窗、不广播、不记录好感度', async () => {
  const { inboundFlow, eventBus, sessionStore, affectionStore } = createTestInboundFlow();

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-2', async (e) => {
    receivedEvent = e;
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10002,
    user_id: 999999999, // 非白名单
    self_id: 398276230,
    raw_message: '陌生人私聊',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 999999999, nickname: '陌生人' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  assert.equal(receivedEvent, null, '非白名单用户绝不能广播 message.received');

  const aff = affectionStore.data.users['999999999'];
  assert.equal(aff, undefined, '非白名单用户的消息绝不能被好感度模块记录');

  const window = sessionStore.getContextWindow('qq:private:999999999');
  assert.equal(window.length, 0, '非白名单用户的消息绝不能进入私聊滑窗');
});

test('私聊白名单：主人(ownerId)始终保底放行，即使未显式写在数组中', async () => {
  const { inboundFlow, eventBus } = createTestInboundFlow({
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      privateWhitelist: ['10000003'], // 故意不写 10000001
    },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-3', async (e) => {
    receivedEvent = e;
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10003,
    user_id: 10000001,
    self_id: 398276230,
    raw_message: '主人测试指令',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000001, nickname: 'ruaji' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  assert.ok(receivedEvent, '主人私聊必须无条件放行');
  assert.equal(receivedEvent.payload.userId, '10000001');
});

test('私聊白名单：群聊不受私聊白名单影响', async () => {
  const { inboundFlow, eventBus, sessionStore } = createTestInboundFlow();

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-4', async (e) => {
    receivedEvent = e;
  });

  const rawEvent = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 10004,
    group_id: 1076958977,
    user_id: 999999999, // 非白名单群友
    self_id: 398276230,
    raw_message: '群里说话',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 999999999, nickname: '普通群友', card: '' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  assert.ok(receivedEvent, '群聊消息应正常放行进入广播');
  assert.equal(receivedEvent.payload.groupId, '1076958977');

  const window = sessionStore.getContextWindow('qq:group:1076958977');
  assert.ok(window.length > 0, '群聊消息应正常进入群聊滑窗');
});

test('私聊白名单：非白名单私聊在 normalize 之前就被拦掉（媒体不落盘、不回拉引用）', async () => {
  const { inboundFlow, normalizeCalls, healthCalls } = createTestInboundFlow();

  const rawEvent = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10005,
    user_id: 999999999,
    self_id: 398276230,
    raw_message: '[CQ:image,file=spam.jpg,url=http://127.0.0.1:1/spam.jpg]',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 999999999, nickname: '陌生人' },
  };

  await inboundFlow.handleEvent(rawEvent);
  await flush();

  assert.equal(
    normalizeCalls.length,
    0,
    '门禁必须早于 normalize：否则陌生人的图片/文件会先落盘、引用消息会先回拉',
  );
  assert.ok(healthCalls.includes('messages.ignored'), '被拦截的私聊要计入 messages.ignored');
});

test('私聊白名单：群聊照常进入 normalize，不被第一道门禁误伤', async () => {
  const { inboundFlow, normalizeCalls } = createTestInboundFlow();

  await inboundFlow.handleEvent({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 10006,
    group_id: 1076958977,
    user_id: 999999999,
    self_id: 398276230,
    raw_message: '群里说话',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 999999999, nickname: '普通群友', card: '' },
  });
  await flush();

  assert.equal(normalizeCalls.length, 1, '群聊消息必须照常规范化');
});

test('私聊白名单：配置里没有 privateWhitelist 键时，只有主人能私聊', async () => {
  const stranger = createTestInboundFlow({ dropPrivateWhitelist: true });
  let strangerEvent = null;
  stranger.eventBus.subscribe('message.received', 'test-sub-5', async (e) => {
    strangerEvent = e;
  });

  await stranger.inboundFlow.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10007,
    user_id: 10000003, // 原本在名单里，但键被删了
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  });
  await flush();
  assert.equal(strangerEvent, null, '缺省该键时应 fail-closed，非主人一律拦截');

  const owner = createTestInboundFlow({ dropPrivateWhitelist: true });
  let ownerEvent = null;
  owner.eventBus.subscribe('message.received', 'test-sub-6', async (e) => {
    ownerEvent = e;
  });

  await owner.inboundFlow.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10008,
    user_id: 10000001,
    self_id: 398276230,
    raw_message: '主人测试指令',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000001, nickname: 'ruaji' },
  });
  await flush();
  assert.ok(ownerEvent, '缺省该键时主人依然保底放行');
});

test('私聊白名单：名单写成数字（非字符串）也能正确匹配', async () => {
  const { inboundFlow, eventBus } = createTestInboundFlow({
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      privateWhitelist: [10000003], // 手写 JSON 时很容易漏引号
    },
  });

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-7', async (e) => {
    receivedEvent = e;
  });

  await inboundFlow.handleEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 10009,
    user_id: 10000003,
    self_id: 398276230,
    raw_message: '你好瑞姬',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000003, nickname: '测试白名单好友' },
  });
  await flush();

  assert.ok(receivedEvent, '数字型白名单条目应与字符串 userId 等价匹配');
});

test('私聊白名单：ownerId 为空时不会因空字符串匹配而放行任何人', () => {
  const { inboundFlow } = createTestInboundFlow({
    identity: { ownerId: '', robotId: '398276230', privateWhitelist: [] },
  });

  assert.equal(inboundFlow._isPrivateAllowed(''), false, '空 userId 不能匹配空 ownerId');
  assert.equal(inboundFlow._isPrivateAllowed('999999999'), false, '空名单加空主人应全拦');
});

test('私聊白名单：热更新 config.identity.privateWhitelist 后立即生效（无需重启）', async () => {
  const { inboundFlow, eventBus, config } = createTestInboundFlow();

  let receivedEvent = null;
  eventBus.subscribe('message.received', 'test-sub-8', async (e) => {
    receivedEvent = e;
  });

  const build = (messageId) => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 888888888,
    self_id: 398276230,
    raw_message: '临时加白测试',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 888888888, nickname: '待加白用户' },
  });

  await inboundFlow.handleEvent(build(10010));
  await flush();
  assert.equal(receivedEvent, null, '加白之前应被拦截');

  // 面板 PUT /api/config 就是这样 Object.assign 到运行态的
  config.identity.privateWhitelist = ['10000003', '888888888'];

  await inboundFlow.handleEvent(build(10011));
  await flush();
  assert.ok(receivedEvent, '加白之后同一用户应立刻放行');
  assert.equal(receivedEvent.payload.userId, '888888888');
});

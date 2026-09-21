/**
 * tests/unit/rate-limit.test.js — 频控（限速名单）全链路回归
 *
 * 这份用例锁死的是 2026-09 修掉的那一类 bug：
 *
 *   1. 名单在构造期被快照成 Set，面板保存后运行中的进程永远不认
 *      → "明明在 rateLimitUsers 里，却一直跟对方互动"
 *   2. 窗口毫秒数同样在构造期取一次，面板改窗口"保存成功但不生效"
 *   3. 私聊裁决在频控判定**之前**就直接 return direct，私聊成了绕过限速的通道
 *   4. handleProactive（宿主主动接话）完全不走 decisionFlow.decide，也不受频控
 *   5. 判定只看**入队时**的计数：在途生成期间排队的消息当时还没超限，
 *      等轮到它生成时额度早用满了，排队就成了绕过限速的后门
 *
 * 断言分四层：策略解析（纯函数）→ SessionStore 窗口 → DecisionFlow 裁决
 * → InboundFlow 端到端（排队丢弃 / 计数发生 / 主动接话）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_LIMIT_DEFAULTS,
  parseRateLimitEntry,
  formatRateLimitEntry,
  normalizeRateLimitList,
  toConfigRateLimitEntry,
  resolveRateLimitRule,
  resolveRateLimitPolicy,
  evaluateRateLimit,
} from '../../src/core/rate-limit-policy.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { DecisionFlow, IGNORE_REASONS } from '../../src/orchestration/decision-flow.js';
import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { EventBus } from '../../src/core/event-bus.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { CAPABILITIES, ROUTES, TRIGGER_TYPES } from '../../src/contracts/capabilities.js';
import { createInboundMessage, MESSAGE_TYPES } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function baseConfig(overrides = {}) {
  return {
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      botName: '瑞姬',
      ownerTitle: '主人',
      rateLimitUsers: [],
      privateWhitelist: ['10000001'],
      groupWhitelist: [],
      ...(overrides.identity ?? {}),
    },
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    decision: {
      rateLimit: { maxReplies: 5, windowMs: 300000 },
      debounceMs: 5,
      localWindowSize: 15,
      ...(overrides.decision ?? {}),
    },
    reply: { sendEnabled: false, sideEffectsEnabled: false },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
    favourUltraEnabled: true,
    legacyAffectionEnabled: false,
    ...overrides.rest,
  };
}

// ===========================================================================
// 一、策略解析（纯函数）
// ===========================================================================

test('parseRateLimitEntry：纯 QQ 号（字符串/数字）走全局默认额度', () => {
  const a = parseRateLimitEntry('3443746455');
  assert.deepEqual(a, { userId: '3443746455', maxReplies: null, windowMs: null, block: false });
  assert.deepEqual(parseRateLimitEntry(3443746455), a, '数字写法应与字符串等价');
  assert.deepEqual(parseRateLimitEntry('  3443746455  '), a, '前后空格应被归一');
});

test('parseRateLimitEntry：支持单独额度 / 单独窗口 / 严格拦截三种扩展写法', () => {
  assert.deepEqual(parseRateLimitEntry('2416406494:2'), {
    userId: '2416406494', maxReplies: 2, windowMs: null, block: false,
  });
  assert.deepEqual(parseRateLimitEntry('2416406494:2:600000'), {
    userId: '2416406494', maxReplies: 2, windowMs: 600000, block: false,
  });
  assert.deepEqual(parseRateLimitEntry('3768463847:block'), {
    userId: '3768463847', maxReplies: null, windowMs: null, block: true,
  });
  assert.deepEqual(parseRateLimitEntry('3768463847:Block'), parseRateLimitEntry('3768463847:block'), '关键字大小写不敏感');
  // 段顺序不敏感：block 写在前面也认
  assert.equal(parseRateLimitEntry('3768463847:block:3').block, true);
  assert.equal(parseRateLimitEntry('3768463847:block:3').maxReplies, 3);
  // id:0 = "窗口内允许 0 条"，语义上就是严格拦截，升格成 block 而不是静默丢弃
  assert.deepEqual(parseRateLimitEntry('3768463847:0'), {
    userId: '3768463847', maxReplies: null, windowMs: null, block: true,
  });
  assert.equal(parseRateLimitEntry({ userId: '3768463847', maxReplies: 0 }).block, true, '对象写法同理');
});

test('parseRateLimitEntry：对象写法（配置文件）与文本写法等价', () => {
  assert.deepEqual(
    parseRateLimitEntry({ userId: '2416406494', maxReplies: 2, windowMs: 600000, block: false }),
    parseRateLimitEntry('2416406494:2:600000'),
  );
  assert.deepEqual(
    parseRateLimitEntry({ id: '3768463847', block: true }),
    parseRateLimitEntry('3768463847:block'),
    '对象里的 id 是 userId 的别名',
  );
});

test('parseRateLimitEntry：非法输入一律 null，绝不把 NaN 带进判定式', () => {
  for (const bad of [null, undefined, '', '   ', ':2', {}, { userId: '' }, [], 0]) {
    assert.equal(parseRateLimitEntry(bad), null, `非法输入 ${JSON.stringify(bad)} 应返回 null`);
  }
  // 非法数字段被忽略，但条目本身仍然有效（保持 user 的默认额度）
  assert.deepEqual(parseRateLimitEntry('2416406494:abc:-5'), {
    userId: '2416406494', maxReplies: null, windowMs: null, block: false,
  });
});

test('formatRateLimitEntry 与 parseRateLimitEntry 对称（面板文本 ⇄ 运行时规则）', () => {
  for (const token of ['3443746455', '2416406494:2', '2416406494:2:600000', '3768463847:block']) {
    assert.equal(formatRateLimitEntry(parseRateLimitEntry(token)), token);
  }
  // 对象写法展平成文本
  assert.equal(formatRateLimitEntry({ userId: '2416406494', maxReplies: 2 }), '2416406494:2');
  assert.equal(formatRateLimitEntry({ userId: '3768463847', block: true }), '3768463847:block');
  // id:0 与 id:block 是同一件事，格式化后统一收敛到 block 写法
  assert.equal(formatRateLimitEntry('3768463847:0'), '3768463847:block');
});

test('normalizeRateLimitList：解析 + 按 userId 去重，后者覆盖前者且保留原顺序', () => {
  const rules = normalizeRateLimitList(['a', 'b:2', 'a:3', { userId: 'c', windowMs: 1000 }, 'b']);
  assert.deepEqual(rules.map((r) => r.userId), ['a', 'b', 'c'], '顺序按首次出现');
  assert.equal(rules[0].maxReplies, 3, '后写的 a:3 覆盖先前的 a');
  assert.equal(rules[1].maxReplies, 2, 'b 后写的裸条目不能把已有的单独额度抹掉');
  assert.equal(rules[2].windowMs, 1000);
  assert.deepEqual(normalizeRateLimitList('not-an-array'), [], '类型不对按空名单处理（fail-open）');
});

test('toConfigRateLimitEntry：纯默认额度存字符串，带覆盖项才存对象（向后兼容旧配置）', () => {
  assert.equal(toConfigRateLimitEntry(parseRateLimitEntry('3443746455')), '3443746455');
  assert.deepEqual(toConfigRateLimitEntry(parseRateLimitEntry('2416406494:2')), { userId: '2416406494', maxReplies: 2 });
  assert.deepEqual(toConfigRateLimitEntry(parseRateLimitEntry('3768463847:block')), { userId: '3768463847', block: true });
  assert.deepEqual(
    toConfigRateLimitEntry(parseRateLimitEntry('2416406494:2:600000')),
    { userId: '2416406494', maxReplies: 2, windowMs: 600000 },
  );
});

test('resolveRateLimitPolicy：不在名单 → null；在名单 → 合并全局默认值', () => {
  const config = baseConfig({ identity: { rateLimitUsers: ['2416406494'] } });
  assert.equal(resolveRateLimitPolicy('999', MESSAGE_TYPES.GROUP, config), null);
  assert.deepEqual(resolveRateLimitPolicy('2416406494', MESSAGE_TYPES.GROUP, config), {
    userId: '2416406494',
    maxReplies: RATE_LIMIT_DEFAULTS.maxReplies,
    windowMs: RATE_LIMIT_DEFAULTS.windowMs,
    block: false,
  });
});

test('resolveRateLimitPolicy：单独额度 / 单独窗口覆盖全局默认值', () => {
  const config = baseConfig({
    identity: { rateLimitUsers: ['2416406494:2', '3768463847:1:60000'] },
    decision: { rateLimit: { maxReplies: 5, windowMs: 300000 } },
  });
  assert.deepEqual(resolveRateLimitPolicy('2416406494', MESSAGE_TYPES.GROUP, config), {
    userId: '2416406494', maxReplies: 2, windowMs: 300000, block: false,
  });
  assert.deepEqual(resolveRateLimitPolicy('3768463847', MESSAGE_TYPES.GROUP, config), {
    userId: '3768463847', maxReplies: 1, windowMs: 60000, block: false,
  });
});

test('resolveRateLimitPolicy：全局默认值缺失时回落内置默认，不会变成 NaN 判定', () => {
  const config = baseConfig({ identity: { rateLimitUsers: ['2416406494'] }, decision: { rateLimit: {} } });
  const policy = resolveRateLimitPolicy('2416406494', MESSAGE_TYPES.GROUP, config);
  assert.equal(policy.maxReplies, RATE_LIMIT_DEFAULTS.maxReplies);
  assert.equal(policy.windowMs, RATE_LIMIT_DEFAULTS.windowMs);
});

test('resolveRateLimitPolicy：私聊默认不受频控，applyToPrivate=true 才纳入', () => {
  const off = baseConfig({ identity: { rateLimitUsers: ['2416406494'] } });
  assert.equal(resolveRateLimitPolicy('2416406494', MESSAGE_TYPES.PRIVATE, off), null);

  const on = baseConfig({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 60000, applyToPrivate: true } },
  });
  assert.equal(resolveRateLimitPolicy('2416406494', MESSAGE_TYPES.PRIVATE, on).maxReplies, 1);
});

test('resolveRateLimitRule：每次现读活配置（热更新语义的单元级保证）', () => {
  const config = baseConfig({ identity: { rateLimitUsers: [] } });
  assert.equal(resolveRateLimitRule('2416406494', config), null);

  config.identity.rateLimitUsers = ['2416406494:2'];
  assert.equal(resolveRateLimitRule('2416406494', config).maxReplies, 2);

  config.identity.rateLimitUsers = [];
  assert.equal(resolveRateLimitRule('2416406494', config), null, '移出名单后立即不再受限');
});

test('evaluateRateLimit：未到阈值放行、到阈值拦截、block 无视计数直接拦', () => {
  const policy = { userId: 'u', maxReplies: 5, windowMs: 1000, block: false };
  let count = 4;
  assert.equal(evaluateRateLimit(policy, () => count).limited, false);
  count = 5;
  assert.equal(evaluateRateLimit(policy, () => count).limited, true);
  assert.equal(evaluateRateLimit(null, () => 999).limited, false, '不在名单永不限流');
  assert.equal(evaluateRateLimit({ ...policy, block: true }, () => 0).limited, true, 'block 不看计数');
  assert.equal(evaluateRateLimit({ ...policy, block: true }, () => 0).blocked, true);
});

// ===========================================================================
// 二、SessionStore 的窗口语义
// ===========================================================================

test('SessionStore：countRecentReplies 支持按用户窗口，且不会截断更宽窗口的数据', () => {
  let now = 1000;
  const store = new SessionStore({ rateLimitWindowMs: 100, now: () => now });
  store.recordReply('u', 100);

  now = 1150;
  assert.equal(store.countRecentReplies('u'), 0, '窄窗口内已过期');
  assert.equal(store.countRecentReplies('u', 1000), 1, '宽窗口查询必须还能看到它（只读不破坏存储）');
  assert.equal(store.countRecentReplies('u'), 0, '再次用窄窗口查询结果不变');
});

test('SessionStore：rateLimitWindowMs 可热更新（面板改窗口即刻生效）', () => {
  let now = 1000;
  const store = new SessionStore({ rateLimitWindowMs: 100, now: () => now });
  store.recordReply('u');
  now = 1500;
  assert.equal(store.countRecentReplies('u'), 0);

  store.rateLimitWindowMs = 1000;
  assert.equal(store.countRecentReplies('u'), 1, '窗口调大后历史时间戳应重新计入');
});

test('SessionStore：recordReply 用传入窗口裁剪，单个用户不会无限堆积', () => {
  let now = 0;
  const store = new SessionStore({ rateLimitWindowMs: 1000, now: () => now });
  for (let i = 0; i < 5; i++) {
    now += 10;
    store.recordReply('u', 50);
  }
  now += 1000;
  store.recordReply('u', 50);
  assert.equal(store.countRecentReplies('u', 50), 1, '过期的历史应在写入时被裁掉');
});

// ===========================================================================
// 三、DecisionFlow 裁决层
// ===========================================================================

function makeDecisionFlow(config, providerRoute = 'direct') {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  capabilityBus.register({
    id: 'test-decider',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    priority: 100,
    timeoutMs: 100,
    invoke: async () => ({ route: providerRoute, reason: 'test' }),
  });
  const sessionStore = new SessionStore();
  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });
  const flow = new DecisionFlow({ capabilityBus, sessionStore, normalizer, config, logger });
  return { flow, sessionStore };
}

function inboundOf(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c1',
    messageId: 'm1',
    userId: '2416406494',
    groupId: '1076958977',
    messageType: MESSAGE_TYPES.GROUP,
    text: '随便说点什么',
    content: '随便说点什么',
    sender: { nickname: '铃兰', card: '', displayName: '铃兰' },
    ...overrides,
    flags: { isAtBot: true, isNameCall: false, isOwner: false, ...(overrides.flags ?? {}) },
  });
}

test('DecisionFlow（根因回归）：构造后热改 rateLimitUsers 立即生效，不再有构造期 Set 快照', async () => {
  const config = baseConfig({ identity: { rateLimitUsers: [] } });
  const { flow, sessionStore } = makeDecisionFlow(config);
  const inbound = inboundOf();

  assert.equal((await flow.decide(inbound)).route, ROUTES.DIRECT, '不在名单时正常回复');

  // 面板 PUT /api/config 就是这样把新数组落到运行态 config 上的
  config.identity.rateLimitUsers = ['2416406494'];
  for (let i = 0; i < 5; i++) sessionStore.recordReply('2416406494');

  const limited = await flow.decide(inbound);
  assert.equal(limited.route, ROUTES.IGNORE, '面板刚加进名单的人必须立刻受限，无需重启');
  assert.equal(limited.reason, IGNORE_REASONS.RATE_LIMITED);

  // 反向：热更新把名单清空，立刻恢复
  config.identity.rateLimitUsers = [];
  assert.equal((await flow.decide(inbound)).route, ROUTES.DIRECT, '移出名单后立即恢复回复');
});

test('DecisionFlow：单独额度生效 —— 全局 5 次，名单条目写 2 的只能在 2 次内回', async () => {
  const config = baseConfig({
    identity: { rateLimitUsers: ['2416406494:2'] },
    decision: { rateLimit: { maxReplies: 5, windowMs: 300000 } },
  });
  const { flow, sessionStore } = makeDecisionFlow(config);
  const inbound = inboundOf();

  sessionStore.recordReply('2416406494', 300000);
  assert.equal((await flow.decide(inbound)).route, ROUTES.DIRECT, '第 1 次放行（1 < 2）');
  sessionStore.recordReply('2416406494', 300000);

  const third = await flow.decide(inbound);
  assert.equal(third.route, ROUTES.IGNORE, '第 3 次必须被单独额度拦下（不是等到全局的 5）');
  assert.equal(third.reason, IGNORE_REASONS.RATE_LIMITED);
});

test('DecisionFlow：block 条目无视计数，第一条消息就严格拦截', async () => {
  const config = baseConfig({ identity: { rateLimitUsers: ['2416406494:block'] } });
  const { flow } = makeDecisionFlow(config);
  const decision = await flow.decide(inboundOf());
  assert.equal(decision.route, ROUTES.IGNORE);
  assert.equal(decision.reason, IGNORE_REASONS.RATE_LIMITED);
});

test('DecisionFlow：私聊默认不受频控（保持旧行为），applyToPrivate=true 时纳入', async () => {
  const offConfig = baseConfig({ identity: { rateLimitUsers: ['2416406494'] } });
  const off = makeDecisionFlow(offConfig);
  for (let i = 0; i < 20; i++) off.sessionStore.recordReply('2416406494');
  const privateInbound = inboundOf({ messageType: MESSAGE_TYPES.PRIVATE, groupId: null });
  assert.equal((await off.flow.decide(privateInbound)).route, ROUTES.DIRECT, '默认私聊仍恒 direct');

  const onConfig = baseConfig({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 2, windowMs: 300000, applyToPrivate: true } },
  });
  const on = makeDecisionFlow(onConfig);
  for (let i = 0; i < 2; i++) on.sessionStore.recordReply('2416406494', 300000);
  const gated = await on.flow.decide(privateInbound);
  assert.equal(gated.route, ROUTES.IGNORE, '开启后私聊不再绕过频控');
  assert.equal(gated.reason, IGNORE_REASONS.RATE_LIMITED);
});

test('DecisionFlow：热改 decision.rateLimit.windowMs 立即改变判定结果', async () => {
  const config = baseConfig({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 } },
  });
  const { flow, sessionStore } = makeDecisionFlow(config);
  const inbound = inboundOf();
  sessionStore.recordReply('2416406494', 300000);
  assert.equal((await flow.decide(inbound)).route, ROUTES.IGNORE);

  config.decision.rateLimit.windowMs = 1; // 1ms 窗口：上一条已过期
  await flush(10);
  assert.equal((await flow.decide(inbound)).route, ROUTES.DIRECT, '窗口热改后判定必须跟着变');
});

test('DecisionFlow：名单外用户即使计数很高也不受限（不误伤）', async () => {
  const config = baseConfig({ identity: { rateLimitUsers: ['2416406494'] } });
  const { flow, sessionStore } = makeDecisionFlow(config);
  for (let i = 0; i < 50; i++) sessionStore.recordReply('999999999');
  assert.equal((await flow.decide(inboundOf({ userId: '999999999' }))).route, ROUTES.DIRECT);
});

// ===========================================================================
// 四、InboundFlow 端到端
// ===========================================================================

function makeInboundFlow(configOverrides = {}) {
  const logger = createTestLogger();
  const config = baseConfig(configOverrides);
  const sessionStore = new SessionStore({ rateLimitWindowMs: config.decision.rateLimit.windowMs });
  const capabilityBus = new CapabilityBus({ logger });
  capabilityBus.register({
    id: 'test-decider',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    priority: 100,
    timeoutMs: 100,
    invoke: async () => ({ route: 'direct', reason: 'test' }),
  });
  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });
  const decisionFlow = new DecisionFlow({ capabilityBus, sessionStore, normalizer, config, logger });
  const commandFlow = new CommandFlow({ sessionStore, config, logger });

  /** 每一次真正进入模型生成的消息都会落在这里 */
  const generated = [];
  const replyFlow = {
    run: async ({ inbound, triggerType }) => {
      generated.push({ userId: inbound.userId, triggerType, text: inbound.text });
      return { status: 'ok', segments: 1, response: null };
    },
    waitForDelivery: async () => {},
  };
  const contextFlow = {
    recordToWindow: () => {},
    collect: async () => ({ blocks: [], intercepted: false, reply: null }),
  };
  const healthCalls = [];
  const health = { increment: (section, field) => healthCalls.push(`${section}.${field}`) };

  const inboundFlow = new InboundFlow({
    normalizer,
    dedupStore: new DedupStore(),
    sessionStore,
    eventBus: new EventBus({ logger }),
    decisionFlow,
    contextFlow,
    replyFlow,
    commandFlow,
    health,
    config,
    logger,
  });

  return { config, sessionStore, decisionFlow, inboundFlow, generated, healthCalls };
}

let msgSeq = 100000;
function groupEvent({ userId = '2416406494', groupId = '1076958977', rawMessage = '@瑞姬 在吗' } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: String(++msgSeq),
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: 398276230,
    raw_message: rawMessage,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: Number(userId), nickname: '铃兰', card: '' },
  };
}

test('InboundFlow 端到端：名单内用户的回复会被计数，达到额度后第二条立刻被忽略', async () => {
  const { config, sessionStore, inboundFlow, generated, healthCalls } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '第一条应正常生成');
  assert.equal(sessionStore.countRecentReplies('2416406494', config.decision.rateLimit.windowMs), 1, '回复成功后必须计数');

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '第二条必须被频控拦下，不得进入生成');
  assert.ok(healthCalls.includes('messages.ignored'), '被限流要计入 messages.ignored');
});

test('InboundFlow 端到端：名单外用户回复不计数（额度不会被无谓消耗）', async () => {
  const { sessionStore, inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(generated.length, 2, '不在名单里，发多少回多少');
  assert.equal(sessionStore.countRecentReplies('999999999'), 0);
});

test('InboundFlow（根因回归）：排队期间才触发的频控，会在生成前把排队项丢掉', async () => {
  const { config, sessionStore, inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  const key = 'group_1076958977';
  // 会话在途：这条消息只能排队（此刻计数还是 0，裁决层会放行——这正是旧代码的漏洞）
  const controller = new AbortController();
  sessionStore.beginExecution(key, { controller, source: 'direct' });
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(sessionStore.getBuffer(key).pending.length, 1, '在途期间应进入排队缓冲');
  assert.equal(generated.length, 0);

  // 排队期间额度被用满（例如别的消息已回完、或另一轮生成结算）
  sessionStore.recordReply('2416406494', config.decision.rateLimit.windowMs);
  sessionStore.endExecution(key, controller);

  await inboundFlow._runGeneration(key);
  assert.equal(generated.length, 0, '生成前复核必须拦下已超限的排队项');
  assert.equal(sessionStore.getBuffer(key).pending.length, 0, '被拦下的排队项要出队，不能留成尸体');
});

test('InboundFlow：排队队列里超限用户被丢弃，不影响同队其他群友照常回复', async () => {
  const { sessionStore, inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  const key = 'group_1076958977';
  const controller = new AbortController();
  sessionStore.beginExecution(key, { controller, source: 'direct' });
  await inboundFlow.handleEvent(groupEvent({ userId: '2416406494' }));
  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(sessionStore.getBuffer(key).pending.length, 2);

  sessionStore.recordReply('2416406494');
  sessionStore.endExecution(key, controller);

  await inboundFlow._runGeneration(key);
  assert.deepEqual(generated.map((g) => g.userId), ['999999999'], '被限流的人被丢，其他人照答');

  // 队列里还剩被限流者的那条吗？不该剩——它应当已被丢弃
  await inboundFlow._runGeneration(key);
  assert.equal(generated.length, 1, '第二轮不应再冒出被限流者的回复');
});

test('InboundFlow：handleProactive 主动接话也受频控约束', async () => {
  const { config, sessionStore, inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494'] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  const first = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '2416406494', nickname: '铃兰', message: '睡了吗',
  });
  assert.equal(first.accepted, true);
  await flush();
  assert.equal(generated.length, 1);
  assert.equal(sessionStore.countRecentReplies('2416406494', config.decision.rateLimit.windowMs), 1);

  const second = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '2416406494', nickname: '铃兰', message: '还没睡吗',
  });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'rate_limited');
  await flush();
  assert.equal(generated.length, 1, '主动接话不得绕过频控');
});

test('InboundFlow：block 名单里的主动接话直接被严格拦截', async () => {
  const { inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: ['2416406494:block'] },
    decision: { rateLimit: { maxReplies: 5, windowMs: 300000 } },
  });
  const res = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '2416406494', nickname: '铃兰', message: '在吗',
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'blocked');
  await flush();
  assert.equal(generated.length, 0);
});

test('InboundFlow：热更新名单后，同一条消息的裁决立即翻转（面板保存即生效）', async () => {
  const { config, sessionStore, inboundFlow, generated } = makeInboundFlow({
    identity: { rateLimitUsers: [] },
    decision: { rateLimit: { maxReplies: 1, windowMs: 300000 }, debounceMs: 5 },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1);

  config.identity.rateLimitUsers = ['2416406494'];
  sessionStore.recordReply('2416406494', 300000);

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '加入名单后应立刻生效，无需重启');
});

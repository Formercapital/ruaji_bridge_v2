/**
 * tests/unit/group-rate-limit.test.js — 群白名单频控（identity.groupWhitelist）
 *
 * 需求：群白名单条目除纯群号外，还支持 "群号:条数[:窗口毫秒]" / "群号:block"。
 * 额度用尽后，后续每个 @ 瑞姬 的消息被直接拦截，并自动回一条带剩余冷却分钟数的
 * 提示（"瑞姬去休息啦，xx分钟再来找她吧"）。纯群号 = 不限速（旧行为不变）。
 *
 * 断言分四层：
 *   1. 策略解析（parse/format/normalize/toConfig —— 复用 rate-limit-policy 语法）
 *   2. 额度求值与冷却剩余量（resolveGroupRateLimitPolicy / evaluateGroupRateLimit）
 *   3. 提示渲染（renderGroupCooldownNotice）
 *   4. InboundFlow 端到端（限额内放行 / 超额自动回复 / 纯群号无限制 / 主动接话 / 热更新）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGroupRateLimitEntry,
  formatGroupRateLimitEntry,
  normalizeGroupRateLimitList,
  toConfigGroupRateLimitEntry,
  resolveGroupRateLimitRule,
  resolveGroupRateLimitPolicy,
  evaluateGroupRateLimit,
} from '../../src/core/rate-limit-policy.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { InboundFlow, renderGroupCooldownNotice } from '../../src/orchestration/inbound-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { EventBus } from '../../src/core/event-bus.js';
import { createTestLogger } from '../helpers.js';

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const WAKE_PATTERN = '(^|[\\s，,。.!！?？~、；;:：])瑞姬';

// ===========================================================================
// 一、策略解析（纯函数）—— 与用户级名单共用一套语法
// ===========================================================================

test('parseGroupRateLimitEntry：纯群号 / 群号:条数 / 群号:条数:窗口 / block / 对象写法', () => {
  const plain = { groupId: '1076958977', maxReplies: null, windowMs: null, block: false };
  assert.deepEqual(parseGroupRateLimitEntry('1076958977'), plain);
  assert.deepEqual(parseGroupRateLimitEntry(1076958977), plain, '数字写法等价');
  assert.deepEqual(parseGroupRateLimitEntry('  1076958977  '), plain, '前后空格归一');

  assert.deepEqual(parseGroupRateLimitEntry('1076958977:5'), {
    groupId: '1076958977', maxReplies: 5, windowMs: null, block: false,
  });
  assert.deepEqual(parseGroupRateLimitEntry('1076958977:5:300000'), {
    groupId: '1076958977', maxReplies: 5, windowMs: 300000, block: false,
  });
  assert.equal(parseGroupRateLimitEntry('1076958977:block').block, true);
  assert.equal(parseGroupRateLimitEntry('1076958977:0').block, true, '群号:0 等价严格拦截');

  assert.deepEqual(parseGroupRateLimitEntry({ groupId: '1076958977', maxReplies: 2, windowMs: 60000 }), {
    groupId: '1076958977', maxReplies: 2, windowMs: 60000, block: false,
  });
  assert.deepEqual(parseGroupRateLimitEntry({ gid: '1076958977', limit: 3 }), {
    groupId: '1076958977', maxReplies: 3, windowMs: null, block: false,
  });

  assert.equal(parseGroupRateLimitEntry(''), null, '空串不可解析');
  assert.equal(parseGroupRateLimitEntry(0), null, '0 不是合法群号');
  assert.equal(parseGroupRateLimitEntry({ maxReplies: 3 }), null, '缺群号不可解析');
});

test('formatGroupRateLimitEntry：与 parse 对称（前端展示与落盘同一形状）', () => {
  assert.equal(formatGroupRateLimitEntry('1076958977'), '1076958977');
  assert.equal(formatGroupRateLimitEntry('1076958977:5'), '1076958977:5');
  assert.equal(formatGroupRateLimitEntry('1076958977:5:300000'), '1076958977:5:300000');
  assert.equal(formatGroupRateLimitEntry({ groupId: '1076958977', block: true }), '1076958977:block');
  assert.equal(formatGroupRateLimitEntry(''), '');
});

test('normalizeGroupRateLimitList：解析 + 按 groupId 去重（后来者补齐覆盖项）', () => {
  const normalized = normalizeGroupRateLimitList(['1076958977', '1076958977:5', '888888888:2:60000']);
  assert.deepEqual(normalized, [
    { groupId: '1076958977', maxReplies: 5, windowMs: null, block: false },
    { groupId: '888888888', maxReplies: 2, windowMs: 60000, block: false },
  ]);
  assert.deepEqual(normalizeGroupRateLimitList('not-an-array'), [], '非数组安全回退空名单');
});

test('toConfigGroupRateLimitEntry：纯群号存字符串，带额度/拦截才存对象', () => {
  assert.equal(
    toConfigGroupRateLimitEntry({ groupId: '1076958977', maxReplies: null, windowMs: null, block: false }),
    '1076958977',
  );
  assert.deepEqual(
    toConfigGroupRateLimitEntry({ groupId: '1076958977', maxReplies: 5, windowMs: null, block: false }),
    { groupId: '1076958977', maxReplies: 5 },
  );
  assert.deepEqual(
    toConfigGroupRateLimitEntry({ groupId: '1076958977', maxReplies: 5, windowMs: 60000, block: false }),
    { groupId: '1076958977', maxReplies: 5, windowMs: 60000 },
  );
});

// ===========================================================================
// 二、额度求值与冷却剩余量
// ===========================================================================

const configWith = (groupWhitelist, extra = {}) => ({
  identity: { groupWhitelist },
  decision: { rateLimit: { maxReplies: 5, windowMs: 300000 }, ...extra },
});

test('resolveGroupRateLimitPolicy：纯群号不限速，写条数才限速，窗口回落全局', () => {
  assert.equal(resolveGroupRateLimitPolicy('1076958977', configWith(['1076958977'])), null, '纯群号 = 无频控');
  assert.equal(resolveGroupRateLimitPolicy('1076958977', configWith([])), null);
  assert.equal(resolveGroupRateLimitPolicy('999999999', configWith(['1076958977:5'])), null, '名单外群不参与');

  assert.deepEqual(resolveGroupRateLimitPolicy('1076958977', configWith(['1076958977:5'])), {
    groupId: '1076958977', maxReplies: 5, windowMs: 300000, block: false,
  });
  assert.deepEqual(resolveGroupRateLimitPolicy('1076958977', configWith(['1076958977:5:60000'])), {
    groupId: '1076958977', maxReplies: 5, windowMs: 60000, block: false,
  });
  const blocked = resolveGroupRateLimitPolicy('1076958977', configWith(['1076958977:block']));
  assert.equal(blocked.block, true);
  assert.equal(blocked.maxReplies, 0);

  // 群级没有全局默认额度：只写群号永远不会因为 decision.rateLimit 而被限速
  assert.equal(
    resolveGroupRateLimitPolicy('1076958977', configWith(['1076958977'], { rateLimit: { maxReplies: 1, windowMs: 1000 } })),
    null,
  );
});

test('resolveGroupRateLimitRule：每次现读 config（面板保存后无需推送活实例）', () => {
  const config = configWith(['1076958977']);
  assert.deepEqual(resolveGroupRateLimitRule('1076958977', config), {
    groupId: '1076958977', maxReplies: null, windowMs: null, block: false,
  });
  config.identity.groupWhitelist = ['1076958977:2'];
  assert.equal(resolveGroupRateLimitRule('1076958977', config).maxReplies, 2, '热改后立刻读出新额度');
});

test('evaluateGroupRateLimit：未到阈值放行，到阈值拦截并算出冷却剩余毫秒', () => {
  const policy = { groupId: '1076958977', maxReplies: 2, windowMs: 300000, block: false };
  const now = 1_000_000;

  const under = evaluateGroupRateLimit(policy, () => [now - 1000], now);
  assert.equal(under.limited, false);
  assert.equal(under.retryAfterMs, 0);

  // 恰好到阈值：边界是最早那条，还差 windowMs - 已过时间
  const at = evaluateGroupRateLimit(policy, () => [now - 250000, now - 1000], now);
  assert.equal(at.limited, true);
  assert.equal(at.count, 2);
  assert.equal(at.retryAfterMs, 50000);

  // 超发：要等最早的 (count-maxReplies+1) 条滑出窗口
  const over = evaluateGroupRateLimit(policy, () => [now - 250000, now - 200000, now - 1000], now);
  assert.equal(over.limited, true);
  assert.equal(over.retryAfterMs, 100000);

  const blocked = evaluateGroupRateLimit({ ...policy, block: true, maxReplies: 0 }, () => [], now);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.retryAfterMs, 300000, 'block 至少等一个窗口');

  assert.equal(evaluateGroupRateLimit(null, () => []).limited, false);
});

// ===========================================================================
// 三、冷却提示渲染
// ===========================================================================

test('renderGroupCooldownNotice：剩余时间向上取整到分钟，至少 1 分钟', () => {
  assert.equal(renderGroupCooldownNotice('{minutes} 分钟后见', 0), '1 分钟后见');
  assert.equal(renderGroupCooldownNotice('{minutes} 分钟后见', 30000), '1 分钟后见');
  assert.equal(renderGroupCooldownNotice('{minutes} 分钟后见', 60000), '1 分钟后见');
  assert.equal(renderGroupCooldownNotice('{minutes} 分钟后见', 240000), '4 分钟后见');
  assert.equal(renderGroupCooldownNotice('{minutes} 分钟后见', 240001), '5 分钟后见');
  assert.equal(renderGroupCooldownNotice(null, 300000), '瑞姬去休息啦，5分钟再来找她吧', '缺省文案');
});

// ===========================================================================
// 四、SessionStore 群级计数
// ===========================================================================

test('SessionStore：群级计数与用户级分开存，同一个字符串键不串账，窗口裁剪生效', () => {
  const clock = { t: 1000 };
  const store = new SessionStore({ now: () => clock.t });

  store.recordGroupReply('1076958977', 1000);
  store.recordReply('1076958977', 1000);

  assert.equal(store.countRecentGroupReplies('1076958977', 1000), 1, '群级 1 条');
  assert.equal(store.countRecentReplies('1076958977', 1000), 1, '用户级 1 条 —— 两个 Map 互不影响');

  assert.equal(store.getRecentGroupReplies('1076958977', 1000).length, 1, '时间戳可读，供冷却换算用');

  clock.t += 1001;
  assert.equal(store.countRecentGroupReplies('1076958977', 1000), 0, '滑出窗口即清零');
});

// ===========================================================================
// 五、InboundFlow 端到端
// ===========================================================================

function makeGroupFlow({ configOverrides = {}, now = () => Date.now() } = {}) {
  const logger = createTestLogger();
  const config = {
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      botName: '瑞姬',
      ownerTitle: '主人',
      rateLimitUsers: [],
      privateWhitelist: ['10000001'],
      groupWhitelist: [],
      ...(configOverrides.identity ?? {}),
    },
    wake: { mode: 'both', namePattern: WAKE_PATTERN },
    decision: {
      rateLimit: { maxReplies: 5, windowMs: 300000 },
      debounceMs: 5,
      localWindowSize: 15,
      groupRateLimit: { notice: '瑞姬去休息啦，{minutes}分钟再来找她吧' },
      ...(configOverrides.decision ?? {}),
    },
    reply: { sendEnabled: false, sideEffectsEnabled: false },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
    favourUltraEnabled: true,
    legacyAffectionEnabled: false,
  };

  const sessionStore = new SessionStore({ now, rateLimitWindowMs: config.decision.rateLimit.windowMs });
  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });

  /** 桥接真正发出去的提示/回执落点 */
  const sent = [];
  const commandFlow = new CommandFlow({
    sessionStore,
    config,
    logger,
    sender: { enqueue: (message) => sent.push(message) },
  });

  /** 每一次真正进入模型生成的消息都会落在这里 */
  const generated = [];
  const replyFlow = {
    run: async ({ inbound }) => {
      generated.push({ userId: inbound.userId, groupId: inbound.groupId, text: inbound.text });
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
  const decisionFlow = {
    decide: async () => ({ route: 'direct', triggerType: 'at', reason: 'test', providerId: null }),
    arbitrateConcurrency: async (inbound) => (
      sessionStore.isBusy(inbound.executionKey) ? { action: 'queue' } : { action: 'start' }
    ),
  };

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

  return { config, sessionStore, inboundFlow, generated, sent, healthCalls };
}

let seq = 700000;
function groupEvent({ groupId = '1076958977', userId = '999999999', rawMessage = '[CQ:at,qq=398276230] 在吗' } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: String(++seq),
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: 398276230,
    raw_message: rawMessage,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: Number(userId), nickname: '普通群友', card: '' },
  };
}

test('群频控端到端：限额内放行并计数，超出后 @ 消息被拦截且回一条冷却提示', async () => {
  const clock = { t: 1_000_000 };
  const { sessionStore, inboundFlow, generated, sent, healthCalls } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '第一条应正常生成');
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1, '回复成功后群级必须计数');
  assert.equal(sent.length, 0, '限额内不该回冷却提示');

  // 过了 1 分钟，额度已用满：@ 消息被拦截，提示按剩余 4 分钟换算
  clock.t += 60000;
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '超额后不得进入生成');
  assert.equal(sent.length, 1, '超额后 @ 消息必须回一条冷却提示');
  assert.equal(sent[0].text, '瑞姬去休息啦，4分钟再来找她吧');
  assert.ok(healthCalls.includes('messages.ignored'), '被拦截要计入 messages.ignored');

  // 再过 3 分钟（累计 4 分钟）：剩余 1 分钟，提示动态变化
  clock.t += 180000;
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, '瑞姬去休息啦，1分钟再来找她吧');

  // 窗口滑过最早那条回复后，重新放行
  clock.t += 60001;
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 2, '窗口过期后应恢复放行');
});

test('群频控端到端：纯群号不限制（旧配置行为一字不变，也不产生计数）', async () => {
  const clock = { t: 2_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977'] } },
  });

  for (let i = 0; i < 3; i++) {
    await inboundFlow.handleEvent(groupEvent());
    await flush();
  }

  assert.equal(generated.length, 3, '纯群号 = 不限速，发多少回多少');
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 0, '不限速就不该产生群级计数');
  assert.equal(sent.length, 0);
});

test('群频控端到端：白名单里带额度的条目仍能正确放行该群，名单外群照旧拦在入口', async () => {
  const clock = { t: 3_000_000 };
  const { inboundFlow, generated } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:2:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent({ groupId: '1076958977' }));
  await flush();
  assert.equal(generated.length, 1, '带额度的条目仍是对应群的白名单项');

  await inboundFlow.handleEvent(groupEvent({ groupId: '888888888' }));
  await flush();
  assert.equal(generated.length, 1, '名单外群仍应被入口门禁丢弃');
});

test('群频控端到端：block 群第一条就被严格拦截并回提示', async () => {
  const clock = { t: 4_000_000 };
  const { inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:block'] } },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 0, 'block 群永不生成');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '瑞姬去休息啦，5分钟再来找她吧', 'block 至少等一个窗口（默认 5 分钟）');
});

test('群频控端到端：非 @ 消息在冷却期被静默拦截，不刷提示', async () => {
  const clock = { t: 5_000_000 };
  const { inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1);

  await inboundFlow.handleEvent(groupEvent({ rawMessage: '大家早上好' }));
  await flush();
  assert.equal(generated.length, 1, '冷却期非 @ 消息也不进生成');
  assert.equal(sent.length, 0, '非 @ 消息不该收到冷却提示（避免刷屏）');
});

test('群频控端到端：冷却期宿主主动接话也被拦截', async () => {
  const clock = { t: 6_000_000 };
  const { inboundFlow, generated } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  const first = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '999999999', nickname: '群友', message: '睡了吗',
  });
  assert.equal(first.accepted, true);
  await flush();
  assert.equal(generated.length, 1);

  const second = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '999999999', nickname: '群友', message: '还没睡吗',
  });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'rate_limited');
  await flush();
  assert.equal(generated.length, 1, '群冷却不得被主动接话绕过');
});

test('群频控端到端：热更新群额度后立即生效（面板保存即生效）', async () => {
  const clock = { t: 7_000_000 };
  const { config, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1);

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 1, '额度用满后被拦');
  assert.equal(sent.length, 1);

  // 面板 PUT /api/config 就是这样 Object.assign 到运行态：把名额放开
  config.identity.groupWhitelist = ['1076958977'];
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(generated.length, 2, '热更新去掉额度后，同一群立刻恢复放行');
});

test('群频控端到端：排队期间才用满额度，生成前复核把排队项丢掉并补一条提示', async () => {
  const clock = { t: 9_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  const key = 'group_1076958977';
  const controller = new AbortController();
  sessionStore.beginExecution(key, { controller, source: 'direct' });

  // 在途期间这条只能排队——此刻群计数还是 0，闸门会放行
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(sessionStore.getBuffer(key).pending.length, 1, '在途期间应进入排队缓冲');
  assert.equal(generated.length, 0);

  // 排队期间额度被用满，然后放开在途轮
  sessionStore.recordGroupReply('1076958977', 300000);
  sessionStore.endExecution(key, controller);

  await inboundFlow._runGeneration(key);
  assert.equal(generated.length, 0, '生成前复核必须拦下已超群额的排队项');
  assert.equal(sessionStore.getBuffer(key).pending.length, 0, '被拦下的排队项要出队');
  assert.equal(sent.length, 1, '排队期间被群冷却拦下的 @ 消息也补一条提示');
  assert.match(sent[0].text, /瑞姬去休息啦，\d+分钟再来找她吧/);
});

test('群频控端到端：自定义提示文案热生效，{minutes} 被替换', async () => {
  const clock = { t: 8_000_000 };
  const { config, inboundFlow, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(sent.length, 0);

  config.decision.groupRateLimit.notice = '别催啦，{minutes} 分钟后再来~';
  clock.t += 120000; // 剩余 3 分钟
  await inboundFlow.handleEvent(groupEvent());
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '别催啦，3 分钟后再来~');
});

// ===========================================================================
// 六、主人 / 管理员特权豁免（群频控门禁 + 计数双双豁免）
// ===========================================================================

test('群频控豁免：群冷却期间主人 @ 仍正常生成、不回冷却提示，且不计入群额度', async () => {
  const clock = { t: 10_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  // 先让普通群友把额度用满
  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(generated.length, 1);
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1);

  // 冷却期内普通群友被拦
  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(generated.length, 1, '普通群友仍受冷却约束');
  assert.equal(sent.length, 1, '普通群友收到冷却提示');

  // 主人 @ 必须放行：不进冷却提示、正常生成
  await inboundFlow.handleEvent(groupEvent({ userId: '10000001' }));
  await flush();
  assert.equal(generated.length, 2, '主人不得被群冷却拦截');
  assert.equal(generated[1].userId, '10000001');
  assert.equal(sent.length, 1, '主人不该收到「瑞姬去休息啦」提示');
  assert.equal(
    sessionStore.countRecentGroupReplies('1076958977', 300000),
    1,
    '主人的成功回复不占用群额度',
  );
});

test('群频控豁免：群冷却期间管理员 @ 仍正常生成，且不计入群额度', async () => {
  const clock = { t: 11_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: {
      identity: { groupWhitelist: ['1076958977:1:300000'], adminIds: ['10000002'] },
    },
  });

  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1);

  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(generated.length, 1, '普通群友仍被拦');

  await inboundFlow.handleEvent(groupEvent({ userId: '10000002' }));
  await flush();
  assert.equal(generated.length, 2, '管理员不得被群冷却拦截');
  assert.equal(generated[1].userId, '10000002');
  assert.equal(sent.length, 1, '管理员不该收到冷却提示');
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1, '管理员回复不计数');
});

test('群频控豁免：主人连发多条始终不产生群级计数（纯计数豁免，不依赖冷却状态）', async () => {
  const clock = { t: 12_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:2:300000'] } },
  });

  for (let i = 0; i < 3; i++) {
    await inboundFlow.handleEvent(groupEvent({ userId: '10000001' }));
    await flush();
  }

  assert.equal(generated.length, 3, '主人不受额度 2 的限制');
  assert.equal(sent.length, 0);
  assert.equal(
    sessionStore.countRecentGroupReplies('1076958977', 300000),
    0,
    '主人回复一条都不该计入群额度',
  );
});

test('群频控豁免：冷却期间宿主的主动接话（主人身份）也被放行', async () => {
  const clock = { t: 13_000_000 };
  const { sessionStore, inboundFlow, generated } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  await inboundFlow.handleEvent(groupEvent({ userId: '999999999' }));
  await flush();
  assert.equal(generated.length, 1);
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1);

  const accepted = await inboundFlow.handleProactive({
    groupId: '1076958977', userId: '10000001', nickname: '主人', message: '在吗',
  });
  assert.equal(accepted.accepted, true, '主人的主动接话不受群冷却约束');
  await flush();
  assert.equal(generated.length, 2);
  assert.equal(sessionStore.countRecentGroupReplies('1076958977', 300000), 1, '主动接话也不计数');
});

test('群频控豁免：生成前排队复核处主人也不被丢弃（额度在排队期间才用满）', async () => {
  const clock = { t: 14_000_000 };
  const { sessionStore, inboundFlow, generated, sent } = makeGroupFlow({
    now: () => clock.t,
    configOverrides: { identity: { groupWhitelist: ['1076958977:1:300000'] } },
  });

  const key = 'group_1076958977';
  const controller = new AbortController();
  sessionStore.beginExecution(key, { controller, source: 'direct' });

  // 在途期间主人这条只能排队——此刻群计数还是 0，闸门会放行
  await inboundFlow.handleEvent(groupEvent({ userId: '10000001' }));
  await flush();
  assert.equal(sessionStore.getBuffer(key).pending.length, 1);

  // 排队期间额度被普通群友用满，然后放开在途轮
  sessionStore.recordGroupReply('1076958977', 300000);
  sessionStore.endExecution(key, controller);

  await inboundFlow._runGeneration(key);
  assert.equal(generated.length, 1, '生成前复核不得丢弃主人的排队项');
  assert.equal(generated[0].userId, '10000001');
  assert.equal(sessionStore.getBuffer(key).pending.length, 0);
  assert.equal(sent.length, 0, '主人不该收到冷却提示');
});

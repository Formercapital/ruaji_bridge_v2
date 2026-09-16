import test from 'node:test';
import assert from 'node:assert/strict';

import { DecisionFlow, IGNORE_REASONS } from '../../src/orchestration/decision-flow.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { ROUTES, TRIGGER_TYPES, CAPABILITIES, normalizeRoute } from '../../src/contracts/capabilities.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger, loadFixture } from '../helpers.js';

const CONFIG = {
  identity: { ownerId: '10000001', robotId: '398276230', botName: '瑞姬', rateLimitUsers: ['10000002'] },
  wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
  decision: { rateLimit: { maxReplies: 5, windowMs: 300000 }, localWindowSize: 15, localWindowInject: 6 },
};

function makeFlow({ providerRoute, providerFails = false, sessionStore } = {}) {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });

  if (providerRoute !== undefined || providerFails) {
    capabilityBus.register({
      id: 'test-decider',
      capability: CAPABILITIES.DECISION_GROUP_REPLY,
      priority: 100,
      timeoutMs: 100,
      invoke: async () => {
        if (providerFails) throw new Error('provider down');
        return { route: providerRoute, reason: 'test' };
      },
    });
  }

  const sessions = sessionStore ?? new SessionStore();
  const normalizer = new InboundNormalizer({ identity: CONFIG.identity, wake: CONFIG.wake, logger });

  return new DecisionFlow({ capabilityBus, sessionStore: sessions, normalizer, config: CONFIG, logger });
}

function makeInbound(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c1',
    messageId: 'm1',
    userId: '2260757842',
    groupId: '793019665',
    messageType: 'group',
    text: '随便说点什么',
    content: '随便说点什么',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    ...overrides,
    flags: { isAtBot: false, isNameCall: false, isOwner: false, ...(overrides.flags ?? {}) },
  });
}

test('normalizeRoute 把上游各种取值归一', () => {
  assert.equal(normalizeRoute('direct'), ROUTES.DIRECT);
  assert.equal(normalizeRoute('auto'), ROUTES.AUTO);
  assert.equal(normalizeRoute('ignore'), ROUTES.IGNORE);
  assert.equal(normalizeRoute('duplicate'), ROUTES.IGNORE, 'duplicate 映射到 ignore');
  assert.equal(normalizeRoute('none'), ROUTES.IGNORE);
  assert.equal(normalizeRoute(''), ROUTES.IGNORE);
  assert.equal(normalizeRoute(undefined), ROUTES.IGNORE);
  assert.equal(normalizeRoute('未知取值'), ROUTES.IGNORE);
});

test('私聊恒 direct，不问裁决 Provider', async () => {
  const flow = makeFlow({ providerRoute: 'ignore' });
  const decision = await flow.decide(
    makeInbound({ messageType: 'private', groupId: null, userId: '10000001' }),
  );
  assert.equal(decision.route, ROUTES.DIRECT);
  assert.equal(decision.reason, 'private_message');
});

test('Provider 返回 direct 且消息未 @ 时，v2 放行（修正旧 bridge.js:1239 的缺陷）', async () => {
  const flow = makeFlow({ providerRoute: 'direct' });
  const decision = await flow.decide(makeInbound());
  assert.equal(decision.route, ROUTES.DIRECT, '这正是与旧 Bridge 的有意识差异');
  assert.equal(decision.reason, 'provider_direct');
});

test('Provider 返回 auto 时走主动接话', async () => {
  const flow = makeFlow({ providerRoute: 'auto' });
  const decision = await flow.decide(makeInbound());
  assert.equal(decision.route, ROUTES.AUTO);
  assert.equal(decision.triggerType, TRIGGER_TYPES.AI_DECISION);
});

test('Provider 返回 ignore 且没被 @ 时忽略', async () => {
  const flow = makeFlow({ providerRoute: 'ignore' });
  const decision = await flow.decide(makeInbound());
  assert.equal(decision.route, ROUTES.IGNORE);
  assert.equal(decision.reason, IGNORE_REASONS.PROVIDER_IGNORE);
});

test('真 @ 优先于 Provider 的 ignore —— 被点名不能不理人', async () => {
  const flow = makeFlow({ providerRoute: 'ignore' });
  const decision = await flow.decide(makeInbound({ flags: { isAtBot: true } }));
  assert.equal(decision.route, ROUTES.DIRECT);
  assert.equal(decision.reason, 'at_overrides_provider_ignore');
});

test('Provider 不可用时降级为真 @ 兜底', async () => {
  const atFlow = makeFlow({ providerFails: true });
  const woken = await atFlow.decide(makeInbound({ flags: { isAtBot: true } }));
  assert.equal(woken.route, ROUTES.DIRECT);
  assert.equal(woken.reason, 'provider_unavailable_at_fallback');

  const notWoken = await atFlow.decide(makeInbound());
  assert.equal(notWoken.route, ROUTES.IGNORE);
  assert.equal(notWoken.reason, IGNORE_REASONS.NOT_WOKEN);
});

test('完全没注册裁决 Provider 时同样走真 @ 兜底', async () => {
  const flow = makeFlow();
  const decision = await flow.decide(makeInbound({ flags: { isNameCall: true } }));
  assert.equal(decision.route, ROUTES.DIRECT);
  assert.equal(decision.triggerType, TRIGGER_TYPES.KEYWORD);
});

test('triggerType：真 @ → at，名字呼唤 → keyword', async () => {
  const flow = makeFlow({ providerRoute: 'direct' });
  assert.equal((await flow.decide(makeInbound({ flags: { isAtBot: true } }))).triggerType, TRIGGER_TYPES.AT);
  assert.equal((await flow.decide(makeInbound({ flags: { isNameCall: true } }))).triggerType, TRIGGER_TYPES.KEYWORD);
});

test('限流：名单内用户超过 5 次 / 5 分钟后静默忽略', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ providerRoute: 'direct', sessionStore: sessions });
  const bot = makeInbound({ userId: '10000002', flags: { isAtBot: true } });

  for (let i = 0; i < 5; i++) {
    const d = await flow.decide(bot);
    assert.equal(d.route, ROUTES.DIRECT, `第 ${i + 1} 次应放行`);
    sessions.recordReply('10000002');
  }

  const blocked = await flow.decide(bot);
  assert.equal(blocked.route, ROUTES.IGNORE);
  assert.equal(blocked.reason, IGNORE_REASONS.RATE_LIMITED);
});

test('限流不影响名单外用户', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ providerRoute: 'direct', sessionStore: sessions });
  for (let i = 0; i < 20; i++) sessions.recordReply('2260757842');

  const decision = await flow.decide(makeInbound({ flags: { isAtBot: true } }));
  assert.equal(decision.route, ROUTES.DIRECT);
});

// ===== 并发仲裁与打断特权（附录 1）=====

test('空闲时直接开始', async () => {
  const flow = makeFlow();
  assert.deepEqual(await flow.arbitrateConcurrency(makeInbound()), { action: 'start' });
});

test('在途生成时，普通群友只排队不打断', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ sessionStore: sessions });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct' });

  const result = await flow.arbitrateConcurrency(makeInbound({ executionKey: 'group_793019665' }));
  assert.equal(result.action, 'queue');
  assert.equal(controller.signal.aborted, false, '普通群友不得打断在途生成');
});

test('ruaji 的消息拥有即时打断特权', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ sessionStore: sessions });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct' });

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    flags: { isOwner: true, isAtBot: true },
  });
  const result = await flow.arbitrateConcurrency(owner);

  assert.equal(result.action, 'preempt');
  assert.equal(controller.signal.aborted, true, '主人消息必须立即打断在途生成');
  assert.ok(controller.signal.reason?.preempted);
});

test('在途生成时，无 @ 的 auto 插话直接丢弃而不是排队（P2）', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ sessionStore: sessions });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct' });

  const result = await flow.arbitrateConcurrency(makeInbound({ executionKey: 'group_793019665' }), {
    route: ROUTES.AUTO,
  });

  assert.equal(result.action, 'drop');
  assert.equal(controller.signal.aborted, false, '丢弃不能打断在途生成');
});

test('在途生成时，被真 @ 的 auto 消息仍然排队（真 @ 优先于裁决者）', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ sessionStore: sessions });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct' });

  const atMe = makeInbound({ executionKey: 'group_793019665', flags: { isAtBot: true } });
  assert.equal((await flow.arbitrateConcurrency(atMe, { route: ROUTES.AUTO })).action, 'queue');

  // 主人的 auto 消息同样不享有介入权。
  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    flags: { isOwner: true },
  });
  assert.equal((await flow.arbitrateConcurrency(owner, { route: ROUTES.AUTO })).action, 'drop');
  assert.equal(controller.signal.aborted, false);
});

test('不传 decision 时仲裁行为与旧签名一致（永不 drop）', async () => {
  const sessions = new SessionStore();
  const flow = makeFlow({ sessionStore: sessions });
  sessions.beginExecution('group_793019665', { controller: new AbortController(), source: 'direct' });

  assert.equal((await flow.arbitrateConcurrency(makeInbound({ executionKey: 'group_793019665' }))).action, 'queue');
});

// ===== 主人补充 redirect（Hermes 原生丝滑打断）=====

function makeRedirectFlow(redirectResult, { ownerRedirect = true } = {}) {
  const flow = makeFlow();
  flow.modelRouter = {
    redirect: async () => redirectResult,
  };
  flow.config = { ...flow.config, decision: { ...flow.config.decision, ownerRedirect } };
  return flow;
}

test('主人补充 redirect 成功：不打断在途轮，返回 awaiting', async () => {
  const sessions = new SessionStore();
  const flow = makeRedirectFlow({ ok: true }, {});
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '等等，改成先回我这条',
    flags: { isOwner: true },
  });
  const result = await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(result.action, 'awaiting');
  assert.equal(result.redirected, true);
  assert.equal(controller.signal.aborted, false, 'redirect 成功绝不能打断在途生成');
});

test('redirect 被拒（409 无在途轮）：回退硬打断', async () => {
  const sessions = new SessionStore();
  const flow = makeRedirectFlow({ ok: false, code: 'no_active_run', detail: 'no live run' });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '补充',
    flags: { isOwner: true },
  });
  const result = await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(result.action, 'preempt', 'redirect 失败必须回退到打断特权');
  assert.equal(controller.signal.aborted, true);
});

test('ownerRedirect=false：完全不试 redirect，直接打断（旧行为）', async () => {
  const sessions = new SessionStore();
  const flow = makeRedirectFlow({ ok: true }, { ownerRedirect: false });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '补充',
    flags: { isOwner: true },
  });
  const result = await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(result.action, 'preempt');
  assert.equal(controller.signal.aborted, true);
});

test('redirect 网络失败也回退硬打断，不能吞掉主人的消息', async () => {
  const sessions = new SessionStore();
  const flow = makeRedirectFlow({ ok: false, code: 'network_error', detail: 'timeout' });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '补充',
    flags: { isOwner: true },
  });
  const result = await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(result.action, 'preempt');
  assert.equal(controller.signal.aborted, true);
});

test('redirect 文本带主人身份前缀：模型能归因是主人介入而非原轮发起者', async () => {
  const sessions = new SessionStore();
  const redirectCalls = [];
  const flow = makeFlow();
  flow.modelRouter = { redirect: async (key, text) => { redirectCalls.push(text); return { ok: true }; } };
  flow.config = { ...flow.config, decision: { ...flow.config.decision, ownerRedirect: true } };
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '中世纪我似乎有订阅，你要不看看steamid呢',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji(阵亡)' },
    flags: { isOwner: true },
  });
  await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(redirectCalls.length, 1);
  assert.ok(
    redirectCalls[0].startsWith('【主人介入】ruaji(阵亡)(ID:10000001)在你回复期间补充：'),
    `实际文本: ${redirectCalls[0]}`,
  );
  assert.ok(redirectCalls[0].endsWith('中世纪我似乎有订阅，你要不看看steamid呢'));
});

test('redirect 前缀用 ownerTitle 配置，昵称缺失时退 userId', async () => {
  const sessions = new SessionStore();
  const redirectCalls = [];
  const flow = makeFlow();
  flow.modelRouter = { redirect: async (key, text) => { redirectCalls.push(text); return { ok: true }; } };
  flow.config = {
    ...flow.config,
    identity: { ...flow.config.identity, ownerTitle: '爸爸' },
    decision: { ...flow.config.decision, ownerRedirect: true },
  };
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  // 无 displayName/nickname 的 sender
  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '补充',
    flags: { isOwner: true },
    sender: undefined,
  });
  await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.ok(redirectCalls[0].startsWith('【爸爸介入】10000001(ID:10000001)在你回复期间补充：'), `实际: ${redirectCalls[0]}`);
});

test('redirect 带引用消息时，前置引用摘要：模型能看清主人引用的上下文', async () => {
  const sessions = new SessionStore();
  const redirectCalls = [];
  const flow = makeFlow();
  flow.modelRouter = { redirect: async (key, text) => { redirectCalls.push(text); return { ok: true }; } };
  flow.config = { ...flow.config, decision: { ...flow.config.decision, ownerRedirect: true } };
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    sessionKey: 'group_793019665',
  });
  flow.sessions = sessions;

  const owner = makeInbound({
    userId: '10000001',
    executionKey: 'group_793019665',
    text: '他说的是这个报错',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    flags: { isOwner: true, hasQuote: true },
    extensions: {
      quote: {
        summary: '[引用 狼三千 的消息: 那个报错怎么解决]',
        sourceMessageId: '99999',
      },
    },
  });
  await flow.arbitrateConcurrency(owner, { route: ROUTES.DIRECT });

  assert.equal(redirectCalls.length, 1);
  assert.equal(
    redirectCalls[0],
    '【主人介入】ruaji(ID:10000001)在你回复期间补充：[引用 狼三千 的消息: 那个报错怎么解决] 他说的是这个报错',
  );
});

test('Golden fixture 的裁决结果符合预期', async () => {
  const logger = createTestLogger();
  const normalizer = new InboundNormalizer({ identity: CONFIG.identity, wake: CONFIG.wake, logger });

  for (const name of ['group-at-bot', 'group-name-call', 'group-normal', 'private-message']) {
    const fixture = loadFixture(name);
    const { message } = await normalizer.normalize(fixture.event);
    if (!message) continue;

    // 裁决 Provider 不可用（现实中 GCP 可能没起），走兜底路径
    const flow = makeFlow({ providerFails: true });
    const decision = await flow.decide(message);
    assert.equal(decision.route, fixture.expect.route, `${name} 的裁决应为 ${fixture.expect.route}`);
  }
});

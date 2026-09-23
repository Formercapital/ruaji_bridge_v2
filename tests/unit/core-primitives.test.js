import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');

import { CircuitBreaker, CircuitBreakerRegistry, CIRCUIT_STATE } from '../../src/core/circuit-breaker.js';
import { IdempotencyStore } from '../../src/core/idempotency-store.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { ModelSessionStore } from '../../src/storage/model-session-store.js';
import { Logger, redact } from '../../src/core/logger.js';
import { resolveTemplate, extractResult, matchesCondition } from '../../src/plugins/template.js';
import {
  buildNapcatPayload,
  escapeLiteralCqCodes,
  stripMentions,
} from '../../src/adapters/napcat/outbound-builder.js';
import { createOutboundMessage } from '../../src/contracts/messages.js';
import { CircuitOpenError } from '../../src/contracts/errors.js';
import { OpenAiCompatibleAdapter } from '../../src/adapters/model/openai-compatible.js';

// ===== 熔断器 =====

test('连续失败达到阈值后打开', () => {
  const breaker = new CircuitBreaker('t', { threshold: 3, cooldownMs: 1000 });
  for (let i = 0; i < 2; i++) breaker.recordFailure(new Error('x'));
  assert.equal(breaker.state, CIRCUIT_STATE.CLOSED);

  breaker.recordFailure(new Error('x'));
  assert.equal(breaker.state, CIRCUIT_STATE.OPEN);
  assert.equal(breaker.canAttempt(), false);
});

test('冷却期满后进入半开，只放行一次探测', () => {
  let now = 1000;
  const breaker = new CircuitBreaker('t', { threshold: 1, cooldownMs: 500, now: () => now });
  breaker.recordFailure(new Error('x'));
  assert.equal(breaker.canAttempt(), false);

  now = 1600;
  assert.equal(breaker.canAttempt(), true, '冷却期满放行一次探测');
  assert.equal(breaker.state, CIRCUIT_STATE.HALF_OPEN);
  assert.equal(breaker.canAttempt(), false, '半开时不再放行第二个请求');
});

test('半开探测失败立即回到打开并重新计时', () => {
  let now = 1000;
  const breaker = new CircuitBreaker('t', { threshold: 1, cooldownMs: 500, now: () => now });
  breaker.recordFailure(new Error('x'));
  now = 1600;
  breaker.canAttempt();
  breaker.recordFailure(new Error('again'));

  assert.equal(breaker.state, CIRCUIT_STATE.OPEN);
  assert.equal(breaker.nextRetryAt, 2100);
});

test('半开探测成功则完全关闭', () => {
  let now = 1000;
  const breaker = new CircuitBreaker('t', { threshold: 1, cooldownMs: 500, now: () => now });
  breaker.recordFailure(new Error('x'));
  now = 1600;
  breaker.canAttempt();
  breaker.recordSuccess();

  assert.equal(breaker.state, CIRCUIT_STATE.CLOSED);
  assert.equal(breaker.failures, 0);
});

test('assertCanAttempt 抛出的是 suppressed 错误，不该被计入失败', () => {
  const breaker = new CircuitBreaker('t', { threshold: 1, cooldownMs: 60000 });
  breaker.recordFailure(new Error('x'));
  assert.throws(() => breaker.assertCanAttempt(), (err) => {
    assert.ok(err instanceof CircuitOpenError);
    assert.equal(err.suppressed, true);
    return true;
  });
});

test('CircuitBreakerRegistry 按 key 复用同一个熔断器', () => {
  const registry = new CircuitBreakerRegistry({ threshold: 2 });
  assert.equal(registry.get('a:b'), registry.get('a:b'));
  assert.notEqual(registry.get('a:b'), registry.get('c:d'));
  assert.equal(registry.getStatusAll().length, 2);
});

// ===== manifest 熔断参数按能力覆盖 =====

test('能力级 breaker 覆盖插件级默认（context.enrich 宽松、decision 严格）', async () => {
  const { loadManifests } = await import('../../src/plugins/manifest-loader.js');
  const { PluginRegistry } = await import('../../src/core/plugin-registry.js');
  const { EventBus } = await import('../../src/core/event-bus.js');
  const { CapabilityBus } = await import('../../src/core/capability-bus.js');
  const { createTestLogger } = await import('../helpers.js');

  const logger = createTestLogger();
  const { manifests } = loadManifests(
    [
      {
        id: 'p1',
        version: '1.0.0',
        enabled: true,
        transport: 'http',
        baseUrl: 'http://127.0.0.1:9999',
        capabilities: [
          { name: 'context.enrich', path: '/c', method: 'POST', breaker: { threshold: 6, cooldownMs: 15000 } },
          { name: 'decision.group_reply', path: '/d', method: 'POST' },
        ],
        breaker: { threshold: 3, cooldownMs: 60000 },
      },
    ],
    { logger },
  );

  // 归一化层：能力级覆盖 > 插件级 > 默认
  const [enrich, decision] = manifests[0].capabilities;
  assert.equal(enrich.breaker.threshold, 6);
  assert.equal(enrich.breaker.cooldownMs, 15000);
  assert.equal(decision.breaker.threshold, 3, '未声明能力级时回落插件级');
  assert.equal(decision.breaker.cooldownMs, 60000);

  // 注册层：按能力生效不同阈值
  const capabilityBus = new CapabilityBus({ logger });
  const registry = new PluginRegistry({
    eventBus: new EventBus({ logger }),
    capabilityBus,
    logger,
    fetchImpl: async () => { throw new Error('unreachable'); },
  });
  registry.registerManifest(manifests[0]);

  // context.enrich 连续失败 3 次（达到插件级阈值但未达能力级阈值）：仍可用。
  // collect() 对失败 Provider 静默丢弃不抛异常，这里只看熔断状态。
  for (let i = 0; i < 3; i++) {
    await capabilityBus.collect('context.enrich', {}, { sessionId: 's' });
  }
  assert.equal(capabilityBus.listProviders('context.enrich')[0].circuit.state, 'closed',
    '能力级 threshold=6 未达，熔断不得打开');

  // decision 达到插件级阈值 3：打开。requestOrNull 失败返回 null 不抛。
  for (let i = 0; i < 3; i++) {
    const r = await capabilityBus.requestOrNull('decision.group_reply', {}, { sessionId: 's' });
    assert.equal(r, null);
  }
  assert.equal(capabilityBus.listProviders('decision.group_reply')[0].circuit.state, 'open',
    '插件级 threshold=3 达到，熔断必须打开');
});

// ===== 幂等 =====

test('同一个键只能占用一次', () => {
  const store = new IdempotencyStore();
  const key = store.buildKey('message.sent', 'msg-1', 'napcat');
  assert.equal(store.claim(key), true);
  assert.equal(store.claim(key), false);
  assert.equal(store.has(key), true);
});

test('release 后可以重新占用（发送失败要允许重试）', () => {
  const store = new IdempotencyStore();
  const key = store.buildKey('message.send', 'tx-1', 'napcat');
  store.claim(key);
  store.release(key);
  assert.equal(store.claim(key), true);
});

test('TTL 过期后可以重新占用', () => {
  let now = 1000;
  const store = new IdempotencyStore({ ttlMs: 100, now: () => now });
  const key = store.buildKey('e', 'm', 'p');
  assert.equal(store.claim(key), true);
  now = 1200;
  assert.equal(store.claim(key), true);
});

test('幂等键包含事件名、messageId 与 providerId 三段', () => {
  const store = new IdempotencyStore();
  assert.equal(store.buildKey('a', 'b', 'c'), 'a|b|c');
  // 同一条消息推给不同插件互不影响
  assert.equal(store.claim(store.buildKey('message.received', 'm1', 'p1')), true);
  assert.equal(store.claim(store.buildKey('message.received', 'm1', 'p2')), true);
});

// ===== 入站去重 =====

test('相同 messageId 只处理一次', () => {
  const dedup = new DedupStore();
  assert.equal(dedup.markSeen('170512001'), true);
  assert.equal(dedup.markSeen('170512001'), false);
  assert.equal(dedup.markSeen('170512002'), true);
});

test('拿不到 messageId 时不去重，宁可多处理也不漏', () => {
  const dedup = new DedupStore();
  assert.equal(dedup.markSeen(null), true);
  assert.equal(dedup.markSeen(''), true);
});

// ===== 会话状态 =====

test('滑窗保留固定条数并按格式渲染', () => {
  const sessions = new SessionStore({ windowSize: 3 });
  for (let i = 1; i <= 5; i++) {
    sessions.recordContext('qq:group:1', { nickname: `u${i}`, text: `m${i}`, time: '10:00:0' + i });
  }
  const window = sessions.getContextWindow('qq:group:1');
  assert.equal(window.length, 3);
  assert.equal(window[0].text, 'm3');
  assert.equal(sessions.renderContext('qq:group:1', 2), '[10:00:04] u4: m4\n[10:00:05] u5: m5');
});

test('滑窗排除：renderContext 第三参支持整批 messageId 数组，单个字符串用法不变', () => {
  const sessions = new SessionStore({ windowSize: 10 });
  sessions.recordContext('qq:group:2', { messageId: 'a', nickname: 'u1', text: 'm1', time: '10:00:01' });
  sessions.recordContext('qq:group:2', { messageId: 'b', nickname: 'u2', text: 'm2', time: '10:00:02' });
  sessions.recordContext('qq:group:2', { messageId: 'c', nickname: 'u3', text: 'm3', time: '10:00:03' });

  assert.equal(
    sessions.renderContext('qq:group:2', 10, ['a', 'b']),
    '[10:00:03] u3: m3',
    '数组应整批排除，防抖合并批次不再以滑窗形式重复出现',
  );

  assert.equal(
    sessions.renderContext('qq:group:2', 10, 'a'),
    '[10:00:02] u2: m2\n[10:00:03] u3: m3',
    '单个字符串（旧用法）行为不变',
  );

  assert.equal(
    sessions.renderContext('qq:group:2', 10),
    '[10:00:01] u1: m1\n[10:00:02] u2: m2\n[10:00:03] u3: m3',
    '不传排除项时全部保留',
  );
});

test('限流窗口滚动过期', () => {
  let now = 1000;
  const sessions = new SessionStore({ rateLimitWindowMs: 500, now: () => now });
  sessions.recordReply('u1');
  sessions.recordReply('u1');
  assert.equal(sessions.countRecentReplies('u1'), 2);
  now = 1600;
  assert.equal(sessions.countRecentReplies('u1'), 0);
});

test('endExecution 只清理当前登记的 controller', () => {
  const sessions = new SessionStore();
  const a = new AbortController();
  const b = new AbortController();
  sessions.beginExecution('k', { controller: a });
  sessions.endExecution('k', b);
  assert.ok(sessions.getActive('k'), '别人的 controller 不能误删');
  sessions.endExecution('k', a);
  assert.equal(sessions.getActive('k'), null);
});

test('preempt 只在有在途且未取消时生效', () => {
  const sessions = new SessionStore();
  assert.equal(sessions.preempt('k', new Error('x')), false);

  const controller = new AbortController();
  sessions.beginExecution('k', { controller });
  assert.equal(sessions.preempt('k', new Error('x')), true);
  assert.equal(sessions.preempt('k', new Error('x')), false, '已取消的不重复取消');
});

test('requeue 把本轮不处理的消息放回队首，不排在 drain 之后新到的消息后面', () => {
  const sessions = new SessionStore();
  const buf = sessions.getBuffer('group_1');
  buf.pending.push({ id: 'old1' }, { id: 'old2' });

  const drained = sessions.drainBuffer('group_1');
  // 模拟生成期间又来了一条
  sessions.getBuffer('group_1').pending.push({ id: 'new' });
  sessions.requeue('group_1', drained.slice(1));

  assert.deepEqual(
    sessions.getBuffer('group_1').pending.map((p) => p.id),
    ['old2', 'new'],
    '退回的旧消息必须排在后到的消息前面',
  );

  sessions.requeue('group_1', []);
  assert.equal(sessions.getBuffer('group_1').pending.length, 2, '空数组是 no-op');
});

// ===== 日志脱敏 =====

test('敏感键名一律替换', () => {
  const out = redact({
    apiKey: 'sk-real-secret',
    access_token: 'abc',
    Authorization: 'Bearer xyz',
    nested: { password: 'p', normal: 'ok' },
  });
  assert.equal(out.apiKey, '***');
  assert.equal(out.access_token, '***');
  assert.equal(out.Authorization, '***');
  assert.equal(out.nested.password, '***');
  assert.equal(out.nested.normal, 'ok');
});

test('值级脱敏兜住藏在字符串里的密钥', () => {
  assert.equal(redact('调用失败: Bearer abc123XYZ'), '调用失败: ***');
  assert.equal(redact('key=sk-abcdefgh12345'), 'key=***');
});

test('默认不把消息正文写进日志', () => {
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (l) => lines.push(l) });
  logger.info('收到消息', { body: logger.body('这是一条很私密的聊天内容') });
  assert.equal(lines[0].body, '[len=12]');
  assert.ok(!JSON.stringify(lines[0]).includes('私密'));
});

test('显式开启后才落正文', () => {
  const lines = [];
  const logger = new Logger({ level: 'debug', logMessageBodies: true, sink: (l) => lines.push(l) });
  logger.info('收到消息', { body: logger.body('内容') });
  assert.equal(lines[0].body, '内容');
});

test('child logger 继承配置并附加固定字段', () => {
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (l) => lines.push(l) });
  logger.child({ component: 'x' }).warn('出事了');
  assert.equal(lines[0].component, 'x');
  assert.equal(lines[0].level, 'warn');
});

test('低于阈值的级别不输出', () => {
  const lines = [];
  const logger = new Logger({ level: 'warn', sink: (l) => lines.push(l) });
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  assert.equal(lines.length, 1);
});

// ===== manifest 模板 =====

test('整串占位符保留原类型', () => {
  const out = resolveTemplate({ is_at: '{{isAtBot}}', uid: '{{userId}}' }, { isAtBot: true, userId: 123 });
  assert.equal(out.is_at, true, '布尔必须还是布尔');
  assert.equal(out.uid, 123, '数字必须还是数字');
});

test('混合插值转成字符串', () => {
  assert.equal(resolveTemplate('qq_{{userId}}', { userId: 123 }), 'qq_123');
  assert.equal(resolveTemplate('{{a}}-{{b}}', { a: 1, b: 2 }), '1-2');
});

test('支持点号路径与缺失字段', () => {
  assert.equal(resolveTemplate('{{sender.nickname}}', { sender: { nickname: 'x' } }), 'x');
  assert.equal(resolveTemplate('{{missing}}', {}), null);
  assert.equal(resolveTemplate('a{{missing}}b', {}), 'ab');
});

test('嵌套对象与数组递归解析', () => {
  const out = resolveTemplate(
    { sender: { user_id: '{{userId}}', nickname: '{{name}}' }, tags: ['{{a}}', 'lit'] },
    { userId: 1, name: 'n', a: 'A' },
  );
  assert.deepEqual(out, { sender: { user_id: 1, nickname: 'n' }, tags: ['A', 'lit'] });
});

test('extractResult 按点号路径取值', () => {
  assert.equal(extractResult({ data: { context: 'x' } }, 'data.context'), 'x');
  assert.deepEqual(extractResult({ a: 1 }, null), { a: 1 });
});

test('matchesCondition 支持等值与数组包含', () => {
  assert.equal(matchesCondition({ messageType: 'group' }, { messageType: 'group' }), true);
  assert.equal(matchesCondition({ messageType: 'group' }, { messageType: 'private' }), false);
  assert.equal(matchesCondition({ messageType: ['group', 'private'] }, { messageType: 'private' }), true);
  assert.equal(matchesCondition(null, {}), true);
});

// ===== 出站构建 =====

function makeOutbound(overrides = {}) {
  return createOutboundMessage({
    correlationId: 'c1',
    sessionId: 'qq:group:1',
    target: { type: 'group', id: '793019665' },
    replyToUserId: '2260757842',
    text: '内容',
    ...overrides,
  });
}

test('群聊首段自动 @ 触发者', () => {
  const payload = buildNapcatPayload(makeOutbound({ metadata: { isFirst: true } }));
  assert.equal(payload.message, '[CQ:at,qq=2260757842] 内容');
  assert.equal(payload.isGroup, true);
  assert.equal(payload.targetId, '793019665');
});

test('非首段不 @', () => {
  const payload = buildNapcatPayload(makeOutbound({ metadata: { isFirst: false } }));
  assert.equal(payload.message, '内容');
});

test('私聊永不 @', () => {
  const payload = buildNapcatPayload(
    makeOutbound({ target: { type: 'private', id: '10000001' }, metadata: { isFirst: true } }),
  );
  assert.equal(payload.message, '内容');
  assert.equal(payload.isGroup, false);
});

test('主动接话禁用自动 @ 并清掉正文里的 @', () => {
  const payload = buildNapcatPayload(
    makeOutbound({
      text: '[CQ:at,qq=123] 我插一句 @所有人',
      metadata: { isFirst: true, disableAutoMention: true },
    }),
  );
  assert.ok(!payload.message.includes('CQ:at'));
  assert.ok(!payload.message.includes('@所有人'));
  assert.equal(payload.message, '我插一句');
});

test('字面 CQ 码被实体化，真图片与真 @ 放行', () => {
  assert.equal(
    escapeLiteralCqCodes('[CQ:image,file=file:///F:/a.png]'),
    '[CQ:image,file=file:///F:/a.png]',
  );
  assert.equal(escapeLiteralCqCodes('[CQ:at,qq=123]'), '[CQ:at,qq=123]');
  assert.equal(escapeLiteralCqCodes('[CQ:poke,id=1]'), '&#91;CQ:poke,id=1&#93;');
  assert.equal(
    escapeLiteralCqCodes('[CQ:image,file=http://evil/x.png]'),
    '&#91;CQ:image,file=http://evil/x.png&#93;',
  );
});

test('内容为空时不生成 payload（纯分割线不该打给 NapCat）', () => {
  assert.equal(buildNapcatPayload(makeOutbound({ text: '   ' })), null);
  assert.equal(buildNapcatPayload(makeOutbound({ text: '' })), null);
});

test('stripMentions 清掉所有 @', () => {
  assert.equal(stripMentions('[CQ:at,qq=1]你好 @所有人'), '你好');
});

// ===== OpenAiCompatibleAdapter 会话每日 07:00 轮转 =====

test('业务日期标记以每日 07:00 为分界', () => {
  const before7 = new Date('2026-08-28T06:59:59+08:00');
  const at7 = new Date('2026-08-28T07:00:00+08:00');
  const after7 = new Date('2026-08-28T23:59:59+08:00');
  const nextDayEarly = new Date('2026-08-29T06:59:59+08:00');

  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(before7), '20260827');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at7), '20260828');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(after7), '20260828');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(nextDayEarly), '20260828');
});

test('跨过 07:00 自动开启新会话，resetSession 带上当前日期 tag', async () => {
  const adapter = new OpenAiCompatibleAdapter({
    sessionPrefix: 'qq_',
    sessionHeader: 'X-Hermes-Session-Id',
  });

  const t1 = new Date('2026-08-28T06:50:00+08:00');
  const id1 = adapter.getSessionId('group_793019665', t1);
  assert.equal(id1, 'qq_group_793019665_20260827');

  // 同一天 7 点前重用
  assert.equal(adapter.getSessionId('group_793019665', t1), id1);

  // 跨过 7 点后自动生成新日期的 session
  const t2 = new Date('2026-08-28T07:05:00+08:00');
  const id2 = adapter.getSessionId('group_793019665', t2);
  assert.equal(id2, 'qq_group_793019665_20260828');
  assert.notEqual(id1, id2);

  // resetSession 轮换
  const resetId = await adapter.resetSession('group_793019665', t2);
  assert.equal(resetId, 'qq_group_793019665_20260828_#02');

  const resetId2 = await adapter.resetSession('group_793019665', t2);
  assert.equal(resetId2, 'qq_group_793019665_20260828_#03');

  // 支持自定义 sessionCutoffHour (比如 5 点分界)
  const adapterCustom = new OpenAiCompatibleAdapter({
    sessionPrefix: 'qq_',
    sessionCutoffHour: 5,
  });
  const t5Before = new Date('2026-08-28T04:59:59+08:00');
  const t5After = new Date('2026-08-28T05:00:01+08:00');
  assert.equal(adapterCustom.getSessionId('group_1', t5Before), 'qq_group_1_20260827');
  assert.equal(adapterCustom.getSessionId('group_1', t5After), 'qq_group_1_20260828');
});

test('getBusinessDateTag 支持一天两次轮转（N=2，07:00/19:00 分界）', () => {
  const before7 = new Date('2026-08-28T06:59:59+08:00');
  const at7 = new Date('2026-08-28T07:00:00+08:00');
  const before19 = new Date('2026-08-28T18:59:59+08:00');
  const at19 = new Date('2026-08-28T19:00:00+08:00');
  const nextDayBefore7 = new Date('2026-08-29T06:59:59+08:00');
  const nextDayAt7 = new Date('2026-08-29T07:00:00+08:00');

  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(before7, 7, 2), '20260827_2');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at7, 7, 2), '20260828_1');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(before19, 7, 2), '20260828_1');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at19, 7, 2), '20260828_2');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(nextDayBefore7, 7, 2), '20260828_2');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(nextDayAt7, 7, 2), '20260829_1');
});

test('getBusinessDateTag 支持一天三次轮转（N=3，07:00/15:00/23:00 分界）', () => {
  const at7 = new Date('2026-08-28T07:00:00+08:00');
  const before15 = new Date('2026-08-28T14:59:59+08:00');
  const at15 = new Date('2026-08-28T15:00:00+08:00');
  const at23 = new Date('2026-08-28T23:00:00+08:00');

  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at7, 7, 3), '20260828_1');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(before15, 7, 3), '20260828_1');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at15, 7, 3), '20260828_2');
  assert.equal(OpenAiCompatibleAdapter.getBusinessDateTag(at23, 7, 3), '20260828_3');
});

test('N=2 的 adapter：周期翻转即换会话，/new 序号随 tag 重置', async () => {
  const adapter = new OpenAiCompatibleAdapter({
    sessionPrefix: 'qq_',
    sessionHeader: 'X-Hermes-Session-Id',
    sessionRotationsPerDay: 2,
  });

  const t1 = new Date('2026-08-28T15:00:00+08:00');
  assert.equal(adapter.getSessionId('group_1', t1), 'qq_group_1_20260828_1');

  // 跨过 19:00 周期分界，自动换新会话
  const t2 = new Date('2026-08-28T19:00:00+08:00');
  assert.equal(adapter.getSessionId('group_1', t2), 'qq_group_1_20260828_2');

  // 周期 2 内 /new：序号递增
  const resetId = await adapter.resetSession('group_1', t2);
  assert.equal(resetId, 'qq_group_1_20260828_2_#02');

  // 翻到次日周期 1：tag 变了，counter 随之重置，回到无序号基础 ID
  const t3 = new Date('2026-08-29T07:00:00+08:00');
  assert.equal(adapter.getSessionId('group_1', t3), 'qq_group_1_20260829_1');
});

test('非法 sessionRotationsPerDay 回落为 1（tag 无周期后缀）', () => {
  for (const bad of [0, 5, 13, 1.5, '2x', null]) {
    const adapter = new OpenAiCompatibleAdapter({ sessionRotationsPerDay: bad });
    assert.equal(adapter.sessionRotationsPerDay, 1, `值 ${bad} 应回落为 1`);
  }
  const t = new Date('2026-08-28T12:00:00+08:00');
  const adapter = new OpenAiCompatibleAdapter({ sessionPrefix: 'qq_', sessionRotationsPerDay: 0 });
  assert.equal(adapter.getSessionId('group_1', t), 'qq_group_1_20260828');
});

test('sessionOverrideId 优先于 sessionKey 派生（唤醒自投递钉住已有会话）', async () => {
  const seen = [];
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:8642/v1',
    model: 'hermes-agent',
    sessionPrefix: 'qq_',
    sessionHeader: 'X-Hermes-Session-Id',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'r1', choices: [{ message: { content: 'ok' } }], usage: {} }),
        text: async () => '',
      };
    },
  });

  await adapter.generate({
    correlationId: 'c1',
    model: 'hermes-agent',
    messages: [{ role: 'user', content: 'hi' }],
    sessionKey: 'group_1',
    sessionOverrideId: 'qq_group_1_20260922_1',
    stream: false,
    generation: { hermes_wake_turn: true },
  });

  assert.equal(seen[0].headers['X-Hermes-Session-Id'], 'qq_group_1_20260922_1');
  assert.equal(seen[0].body.hermes_wake_turn, true, '唤醒轮标记必须随请求体发出');
  assert.equal(seen[0].body.stream, false);
});

test('ModelSessionStore 兼容周期后缀 tag：解析成功且不被 prune 当脏数据', () => {
  const tmpCacheDir = path.join(ROOT, 'tests', 'fixtures', `tmp_cache_rotations_${Date.now()}`);
  const store = new ModelSessionStore({ cacheDir: tmpCacheDir, retainDays: 2 });

  assert.equal(ModelSessionStore.tagToMs('20260828_2'), Date.UTC(2026, 7, 28));
  assert.ok(Number.isNaN(ModelSessionStore.tagToMs('这不是tag')));

  store.set('p1', { tag: '20260828_1', sessionId: 'qq_p1_20260828_1', counter: 1 });
  store.set('p2', { tag: '20260828_2', sessionId: 'qq_p2_20260828_2', counter: 1 });
  store.set('old', { tag: '20260801_1', sessionId: 'qq_old_20260801_1', counter: 1 });

  // 带 _P 后缀的条目不能被 prune 当脏数据删掉；隔天旧条目仍正常裁剪
  assert.ok(store.get('p1') != null);
  assert.ok(store.get('p2') != null);
  assert.equal(store.get('old'), null);

  // 重启后带后缀的条目依然在
  const reloaded = new ModelSessionStore({ cacheDir: tmpCacheDir, retainDays: 2 });
  assert.equal(reloaded.get('p2')?.sessionId, 'qq_p2_20260828_2');

  try {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('多个 adapter 共用同一个 store，画像通道不会覆盖掉主会话的 /new 分支', async () => {
  const tmpCacheDir = path.join(ROOT, 'tests', 'fixtures', `tmp_cache_shared_${Date.now()}`);
  const t = new Date('2026-08-28T12:00:00+08:00');

  // container 的接线方式：建一个 store，注入主对话与画像两个 adapter
  const boot = () => {
    const store = new ModelSessionStore({ cacheDir: tmpCacheDir });
    const mk = () => new OpenAiCompatibleAdapter({
      sessionPrefix: 'qq_',
      sessionHeader: 'X-Hermes-Session-Id',
      sessionStore: store,
    });
    return { main: mk(), portrayal: mk() };
  };

  const { main, portrayal } = boot();
  portrayal.getSessionId('portrayal_777', t);
  const afterNew = await main.resetSession('private_3054039169', t);
  assert.equal(afterNew, 'qq_private_3054039169_20260828_#02');
  // 画像再写一个新 key —— 若两边各持一份内存快照，这一步会把上面的 /new 分支整条抹掉
  portrayal.getSessionId('portrayal_888', t);

  // 重启：/new 分支与画像条目都应当还在
  const rebooted = boot();
  assert.equal(rebooted.main.getSessionId('private_3054039169', t), afterNew);
  assert.equal(rebooted.portrayal.getSessionId('portrayal_777', t), 'qq_portrayal_777_20260828');

  try {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('ModelSessionStore 裁剪过期条目，文件不会无限膨胀', () => {
  const tmpCacheDir = path.join(ROOT, 'tests', 'fixtures', `tmp_cache_prune_${Date.now()}`);
  const store = new ModelSessionStore({ cacheDir: tmpCacheDir, retainDays: 2 });

  store.set('stale', { tag: '20260101', sessionId: 'qq_stale_20260101', counter: 1 });
  store.set('yesterday', { tag: '20260827', sessionId: 'qq_yesterday_20260827', counter: 1 });
  store.set('today', { tag: '20260828', sessionId: 'qq_today_20260828', counter: 2 });

  // 基准是「库内最新 tag」而非墙上时钟，所以断言不随运行日期漂移
  assert.equal(store.get('stale'), null);
  assert.equal(store.get('yesterday')?.sessionId, 'qq_yesterday_20260827');
  assert.equal(store.get('today')?.sessionId, 'qq_today_20260828');

  const reloaded = new ModelSessionStore({ cacheDir: tmpCacheDir, retainDays: 2 });
  assert.equal(reloaded.get('stale'), null);
  assert.equal(reloaded.get('today')?.counter, 2);

  try {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('会话映射文件损坏时隔离留档，并以空白映射启动', () => {
  const tmpCacheDir = path.join(ROOT, 'tests', 'fixtures', `tmp_cache_corrupt_${Date.now()}`);
  fs.mkdirSync(tmpCacheDir, { recursive: true });
  fs.writeFileSync(path.join(tmpCacheDir, 'model_sessions.json'), '{ 这不是 JSON', 'utf8');

  const store = new ModelSessionStore({ cacheDir: tmpCacheDir });
  assert.equal(store.get('whatever'), null);
  const quarantined = fs.readdirSync(tmpCacheDir).filter((f) => f.includes('.corrupt_'));
  assert.equal(quarantined.length, 1);

  try {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('ModelSessionStore 持久化：重启后能恢复当前分支会话 ID 与序号', async () => {
  const tmpCacheDir = path.join(ROOT, 'tests', 'fixtures', `tmp_cache_${Date.now()}`);
  const store = new ModelSessionStore({ cacheDir: tmpCacheDir });

  const adapter1 = new OpenAiCompatibleAdapter({
    sessionPrefix: 'qq_',
    sessionStore: store,
  });

  const t = new Date('2026-08-28T12:00:00+08:00');
  const id1 = adapter1.getSessionId('private_3054039169', t);
  assert.equal(id1, 'qq_private_3054039169_20260828');

  // 模拟 /new 触发 resetSession
  const newId = await adapter1.resetSession('private_3054039169', t);
  assert.equal(newId, 'qq_private_3054039169_20260828_#02');

  // 模拟桥接重启：创建新的 Store 实例从 disk 读取
  const storeRecovered = new ModelSessionStore({ cacheDir: tmpCacheDir });
  const adapter2 = new OpenAiCompatibleAdapter({
    sessionPrefix: 'qq_',
    sessionStore: storeRecovered,
  });

  // 重启后获取 session，应当依然是 #02，而不是退回基础 ID
  assert.equal(adapter2.getSessionId('private_3054039169', t), 'qq_private_3054039169_20260828_#02');

  // 重启后再次 /new，序号递增到 #03
  const newId2 = await adapter2.resetSession('private_3054039169', t);
  assert.equal(newId2, 'qq_private_3054039169_20260828_#03');

  // 清理临时文件
  try {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

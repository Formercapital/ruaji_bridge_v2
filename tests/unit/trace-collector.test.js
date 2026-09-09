/**
 * tests/unit/trace-collector.test.js — 追踪采集器
 *
 * 重点守两件事：
 *   1. 环形缓冲真的有界 —— 这东西挂在主链路的事件总线上，无界就是内存泄漏
 *   2. 洋葱模型的耗时折算正确 —— 折算错会让面��把 typing-delay 的等待
 *      算到 affection 头上，运维会照着这个错数字去优化错的地方
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TraceCollector, TRACE_STATUS, SPAN_CATEGORY } from '../../src/web/trace-collector.js';
import { EventBus } from '../../src/core/event-bus.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { MiddlewarePipeline } from '../../src/core/middleware-pipeline.js';
import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { createTestLogger, flush } from '../helpers.js';

function envelope(event, correlationId, payload = {}) {
  return createEvent(event, { correlationId, sessionId: 'qq:group:1', payload });
}

test('环形缓冲严格有界，超出后淘汰最旧的', () => {
  const collector = new TraceCollector({ maxTraces: 3 });
  for (let i = 0; i < 10; i++) {
    collector._ensure(`c${i}`, { messageId: String(i) });
  }
  assert.equal(collector.traces.size, 3);
  assert.deepEqual([...collector.traces.keys()], ['c7', 'c8', 'c9']);
  assert.equal(collector.get('c0'), null);
});

test('单条 trace 的 span 数量也有上限', () => {
  const collector = new TraceCollector();
  const trace = collector._ensure('c1', {});
  for (let i = 0; i < 300; i++) {
    collector._push(trace, { name: `s${i}`, category: SPAN_CATEGORY.MIDDLEWARE, elapsedMs: 1 });
  }
  assert.equal(trace.spans.length, 200);
  // 保留的是最近的那些
  assert.equal(trace.spans.at(-1).name, 's299');
});

test('订阅 EventBus 后能还原出 接收→请求→响应 的骨架', async () => {
  const logger = createTestLogger();
  const eventBus = new EventBus({ logger });
  const collector = new TraceCollector().attach({ eventBus });

  await eventBus.publish(envelope(EVENTS.MESSAGE_RECEIVED, 'corr-1', {
    messageId: 'm1', userId: '42', groupId: '707', displayName: '群友A',
    text: '瑞姬在吗', messageType: 'group', isAtBot: true,
  }));
  await eventBus.publish(envelope(EVENTS.LLM_REQUEST, 'corr-1', {
    messageId: 'm1', model: 'hermes-agent', systemTextLength: 1200, contextBlockCount: 2,
    contextSources: ['group-chat-plus', 'local-window'],
  }));
  await eventBus.publish(envelope(EVENTS.LLM_RESPONSE, 'corr-1', {
    messageId: 'm1', textLength: 88, segments: 2, latencyMs: 850, totalMs: 900,
  }));

  const trace = collector.get('corr-1');
  assert.equal(trace.messageId, 'm1');
  assert.equal(trace.displayName, '群友A');
  assert.equal(trace.status, TRACE_STATUS.REPLIED);
  assert.equal(trace.llm.latencyMs, 850);
  assert.deepEqual(trace.llm.contextSources, ['group-chat-plus', 'local-window']);

  const names = trace.spans.map((s) => s.name);
  assert.ok(names.includes('NapCat 接收'));
  assert.ok(names.includes('LLM 推理'));
});

test('CapabilityBus 的 observer 会把裁决与上下文分成两类 span', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  const collector = new TraceCollector().attach({ capabilityBus });

  capabilityBus.register({
    id: 'group-chat-plus',
    capability: 'decision.group_reply',
    invoke: async () => ({ route: 'direct', reason: 'at' }),
  });
  capabilityBus.register({
    id: 'living-memory',
    capability: 'context.enrich',
    invoke: async () => [{ text: '记忆片段' }],
  });

  await capabilityBus.request('decision.group_reply', {}, { correlationId: 'corr-2' });
  await capabilityBus.collect('context.enrich', {}, { correlationId: 'corr-2' });

  const trace = collector.get('corr-2');
  const categories = trace.spans.map((s) => s.category);
  assert.ok(categories.includes(SPAN_CATEGORY.DECISION), '裁决应当归到 decision 类');
  assert.ok(categories.includes(SPAN_CATEGORY.CONTEXT), '上下文应当归到 context 类');
});

test('能力调用失败也会留下 span，且标记 ok=false', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  const collector = new TraceCollector().attach({ capabilityBus });

  capabilityBus.register({
    id: 'flaky',
    capability: 'decision.group_reply',
    invoke: async () => { throw new Error('boom'); },
  });

  await capabilityBus.requestOrNull('decision.group_reply', {}, { correlationId: 'corr-3' });

  const span = collector.get('corr-3').spans.at(-1);
  assert.equal(span.meta.ok, false);
  assert.equal(span.meta.error, 'boom');
});

test('observer 抛异常不影响能力调用结果', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  capabilityBus.observer = () => { throw new Error('观察者自己炸了'); };
  capabilityBus.register({
    id: 'p',
    capability: 'decision.group_reply',
    invoke: async () => ({ route: 'auto', reason: 'ok' }),
  });

  const out = await capabilityBus.request('decision.group_reply', {}, { correlationId: 'c' });
  assert.equal(out.result.route, 'auto');
});

test('Middleware 的 observer 记录调用次数与耗时', async () => {
  const logger = createTestLogger();
  const pipeline = new MiddlewarePipeline({ logger });
  const collector = new TraceCollector().attach({ pipeline });

  pipeline.register('a', { process: async (ctx, next) => next(ctx) });
  pipeline.register('b', { process: async (ctx, next) => next(ctx) });
  pipeline.configure('response.transform', ['a', 'b']);

  await pipeline.run('response.transform', { correlationId: 'corr-4', text: 'x' });
  await pipeline.run('response.transform', { correlationId: 'corr-4', text: 'y' });

  const metrics = collector.metrics();
  assert.equal(metrics.middleware.a.calls, 2);
  assert.equal(metrics.middleware.b.calls, 2);
  assert.equal(collector.get('corr-4').spans.length, 4);
});

test('middleware observer 抛异常不影响管线产出', async () => {
  const logger = createTestLogger();
  const pipeline = new MiddlewarePipeline({ logger });
  pipeline.observer = () => { throw new Error('观察者自己炸了'); };
  pipeline.register('a', { process: async (ctx, next) => next({ ...ctx, text: 'done' }) });
  pipeline.configure('p', ['a']);

  const out = await pipeline.run('p', { text: 'start' });
  assert.equal(out.text, 'done');
});

test('recordDecision 会把 ignore 标成 IGNORED 并计数', () => {
  const collector = new TraceCollector();
  collector.recordDecision('c1', { route: 'ignore', reason: 'not_woken' });
  collector.recordDecision('c2', { route: 'direct', reason: 'at' });
  collector.recordDecision('c3', { route: 'direct', reason: 'at' });

  assert.equal(collector.get('c1').status, TRACE_STATUS.IGNORED);
  assert.equal(collector.metrics().decisions.ignore, 1);
  assert.equal(collector.metrics().decisions.direct, 2);
});

test('recordContext 保留每块的字符数与截断原因', () => {
  const collector = new TraceCollector();
  collector.recordContext('c1', {
    blocks: [
      { source: 'gcp', priority: 90, text: 'a'.repeat(120), metadata: { slot: 'recent' } },
      { source: 'lm', priority: 80, text: 'b'.repeat(50), truncatedReason: 'per-source budget 50' },
    ],
    stats: { blocksKept: 2, blocksDropped: 1, charsRendered: 170, elapsedMs: 45 },
    dropped: [{ source: 'local-window', reason: 'deduped' }],
  });

  const ctx = collector.get('c1').context;
  assert.equal(ctx.blocks[0].chars, 120);
  assert.equal(ctx.blocks[0].slot, 'recent');
  assert.equal(ctx.blocks[1].truncatedReason, 'per-source budget 50');
  assert.deepEqual(ctx.dropped, [{ source: 'local-window', reason: 'deduped' }]);
});

test('list() 支持按 correlationId / 文本 / 昵称 检索，并按时间倒序', () => {
  const collector = new TraceCollector();
  collector._ensure('aaa-1', { text: '今天天气不错', displayName: '张三', messageId: 'm1' });
  collector._ensure('bbb-2', { text: '瑞姬帮我看看', displayName: '李四', messageId: 'm2' });

  assert.equal(collector.list({ q: '瑞姬' })[0].correlationId, 'bbb-2');
  assert.equal(collector.list({ q: '张三' })[0].correlationId, 'aaa-1');
  assert.equal(collector.list({ q: 'aaa' }).length, 1);
  // 倒序：最新的在前
  assert.equal(collector.list({})[0].correlationId, 'bbb-2');
});

test('list() 的摘要不含 spans 与上下文正文（防止一次拉回几 MB）', () => {
  const collector = new TraceCollector();
  const t = collector._ensure('c1', { text: 'x' });
  collector._push(t, { name: 'a', category: 'llm', elapsedMs: 1 });
  collector.recordContext('c1', { blocks: [{ source: 's', text: 'y'.repeat(9999) }], stats: {} });

  const [row] = collector.list({});
  assert.equal(row.spans, undefined);
  assert.equal(row.context, undefined);
  assert.equal(row.spanCount, 2); // 一条 push + 一条 recordContext 的 span
});

test('吞吐量只统计最近 60 秒', async () => {
  let clock = 1_000_000;
  const collector = new TraceCollector({ now: () => clock });
  const eventBus = new EventBus({ logger: createTestLogger() });
  collector.attach({ eventBus });

  await eventBus.publish(envelope(EVENTS.MESSAGE_RECEIVED, 'c1', { messageId: '1' }));
  clock += 70_000; // 推进 70 秒，上一条应当滑出窗口
  await eventBus.publish(envelope(EVENTS.MESSAGE_RECEIVED, 'c2', { messageId: '2' }));

  await flush();
  const m = collector.metrics();
  assert.equal(m.throughput.messages, 1, '窗口外的消息不该再计入吞吐');
  assert.equal(m.messages, 2, '累计计数不受窗口影响');
});

test('洋葱耗时折算：内层的等待不能算到外层头上', async () => {
  const logger = createTestLogger();
  const pipeline = new MiddlewarePipeline({ logger });
  const collector = new TraceCollector().attach({ pipeline });

  // 模拟真实形态：最内层的 typing-delay 等 60ms，外层三个各自只跑几乎 0ms。
  // 洋葱模型下外层的实测耗时全都 ≥60ms。
  pipeline.register('affection', { process: async (ctx, next) => next(ctx) });
  pipeline.register('meme', { process: async (ctx, next) => next(ctx) });
  pipeline.register('typing-delay', {
    process: async (ctx) => { await new Promise((r) => setTimeout(r, 60)); return ctx; },
  });
  pipeline.configure('response.transform', ['affection', 'meme', 'typing-delay']);

  await pipeline.run('response.transform', { correlationId: 'onion' });

  const { createTracesApi } = await import('../../src/web/api/traces.js');
  const api = createTracesApi({
    traceCollector: collector,
    config: { context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000 } },
  });
  const { body } = await api['GET /api/traces/*']({ pathname: '/api/traces/onion' });
  const timeline = body.trace.timeline;

  // 翻回执行顺序展示
  assert.deepEqual(
    timeline.map((s) => s.meta.middleware),
    ['affection', 'meme', 'typing-delay'],
    '时序图必须按真实执行顺序展示，而不是观察者的上报顺序',
  );

  const byName = Object.fromEntries(timeline.map((s) => [s.meta.middleware, s]));
  assert.ok(byName['typing-delay'].elapsedMs >= 55, 'typing-delay 的等待应当算在它自己头上');
  assert.ok(byName.affection.elapsedMs < 20, `affection 自身耗时不该带上内层等待，实际 ${byName.affection.elapsedMs}ms`);
  assert.ok(byName.meme.elapsedMs < 20, `meme 自身耗时不该带上内层等待，实际 ${byName.meme.elapsedMs}ms`);
  assert.ok(byName.affection.inclusiveMs >= 55, '外层耗时仍以 inclusiveMs 保留，便于排查');
});

test('时序原点取最早的 span 起点，偏移量不出现负数', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  const collector = new TraceCollector().attach({ capabilityBus });

  capabilityBus.register({
    id: 'slow',
    capability: 'decision.group_reply',
    invoke: async () => { await new Promise((r) => setTimeout(r, 40)); return { route: 'auto', reason: 'x' }; },
  });
  await capabilityBus.request('decision.group_reply', {}, { correlationId: 'origin' });

  const trace = collector.get('origin');
  const span = trace.spans[0];
  assert.ok(span.startedAt <= span.at - 35, 'span 的起点要按耗时往前推');
  assert.equal(trace.createdAt, span.startedAt, '时间轴原点应当被拉到最早的 span 起点');
});

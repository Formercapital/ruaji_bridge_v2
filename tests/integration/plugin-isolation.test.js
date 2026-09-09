/**
 * tests/integration/plugin-isolation.test.js
 *
 * 验收标准 7：单插件故障不会阻塞主回复。
 * 这是整个架构最重要的一条——旧 Bridge 的 GCP 裁决是 await 在主链路上的，
 * :8877 挂起 7 秒就整整拖住 7 秒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/core/event-bus.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { PluginRegistry } from '../../src/core/plugin-registry.js';
import { IdempotencyStore } from '../../src/core/idempotency-store.js';
import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { CAPABILITIES } from '../../src/contracts/capabilities.js';
import { CapabilityUnavailableError } from '../../src/contracts/errors.js';
import { createTestLogger, createFetchStub } from '../helpers.js';

function makeBuses() {
  const logger = createTestLogger();
  const idempotency = new IdempotencyStore();
  const eventBus = new EventBus({ logger, idempotency, defaultTimeoutMs: 200 });
  const capabilityBus = new CapabilityBus({ logger, breakerDefaults: { threshold: 2, cooldownMs: 1000 } });
  return { logger, eventBus, capabilityBus, idempotency };
}

test('事件订阅者挂起时，publish 在超时后释放，不吊住主流程', async () => {
  const { eventBus, logger } = makeBuses();
  let hangResolved = false;

  eventBus.subscribe(EVENTS.MESSAGE_RECEIVED, 'hanging-plugin', () =>
    new Promise((resolve) => {
      // unref：别让这个故意挂起的定时器把测试进程钉在事件循环里
      const timer = setTimeout(() => { hangResolved = true; resolve(); }, 10000);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  );
  let fastRan = false;
  eventBus.subscribe(EVENTS.MESSAGE_RECEIVED, 'fast-plugin', async () => { fastRan = true; });

  const startedAt = Date.now();
  await eventBus.publish(
    createEvent(EVENTS.MESSAGE_RECEIVED, { correlationId: 'c', sessionId: 's', payload: { messageId: 'm1' } }),
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1000, `publish 应在超时窗口内返回，实际 ${elapsed}ms`);
  assert.equal(fastRan, true, '快订阅者不受慢订阅者影响');
  assert.equal(hangResolved, false);
  assert.ok(logger.find('事件订阅者失败').length >= 1);
});

test('一个订阅者抛异常不影响其他订阅者，也不冒泡成 unhandledRejection', async () => {
  const { eventBus } = makeBuses();
  const ran = [];

  eventBus.subscribe(EVENTS.LLM_RESPONSE, 'boom', async () => { throw new Error('炸了'); });
  eventBus.subscribe(EVENTS.LLM_RESPONSE, 'ok-1', async () => { ran.push('ok-1'); });
  eventBus.subscribe(EVENTS.LLM_RESPONSE, 'ok-2', async () => { ran.push('ok-2'); });

  await assert.doesNotReject(
    eventBus.publish(createEvent(EVENTS.LLM_RESPONSE, { correlationId: 'c', sessionId: 's', payload: {} })),
  );
  assert.deepEqual(ran.sort(), ['ok-1', 'ok-2']);
});

test('相同 messageId 对同一订阅者只投递一次', async () => {
  const { eventBus } = makeBuses();
  let count = 0;
  eventBus.subscribe(EVENTS.MESSAGE_RECEIVED, 'p', async () => { count++; });

  const envelope = () =>
    createEvent(EVENTS.MESSAGE_RECEIVED, { correlationId: 'c', sessionId: 's', payload: { messageId: 'same' } });
  await eventBus.publish(envelope());
  await eventBus.publish(envelope());
  await eventBus.publish(envelope());

  assert.equal(count, 1);
});

test('能力调用超时后按 fallback 走下一个 Provider', async () => {
  const { capabilityBus } = makeBuses();

  capabilityBus.register({
    id: 'slow',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    priority: 100,
    timeoutMs: 50,
    invoke: () => new Promise((resolve) => setTimeout(() => resolve({ route: 'direct' }), 5000)),
  });
  capabilityBus.register({
    id: 'fast',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    priority: 50,
    timeoutMs: 50,
    invoke: async () => ({ route: 'ignore' }),
  });

  const startedAt = Date.now();
  const result = await capabilityBus.request(CAPABILITIES.DECISION_GROUP_REPLY, {});
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(result.providerId, 'fast');
  assert.equal(result.result.route, 'ignore');
});

test('全部 Provider 失败时抛 CapabilityUnavailableError，requestOrNull 返回 null', async () => {
  const { capabilityBus } = makeBuses();
  capabilityBus.register({
    id: 'bad',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    timeoutMs: 50,
    invoke: async () => { throw new Error('挂了'); },
  });

  await assert.rejects(
    () => capabilityBus.request(CAPABILITIES.DECISION_GROUP_REPLY, {}),
    CapabilityUnavailableError,
  );
  assert.equal(await capabilityBus.requestOrNull(CAPABILITIES.DECISION_GROUP_REPLY, {}), null);
});

test('连续失败触发熔断，之后被主动拦截而非继续打', async () => {
  const { capabilityBus } = makeBuses();
  let calls = 0;
  capabilityBus.register({
    id: 'flaky',
    capability: 'context.enrich',
    timeoutMs: 50,
    invoke: async () => { calls++; throw new Error('挂了'); },
  });

  for (let i = 0; i < 3; i++) await capabilityBus.collect('context.enrich', {});
  const afterOpen = calls;
  await capabilityBus.collect('context.enrich', {});

  assert.equal(calls, afterOpen, '熔断打开后不再真的发请求');
  const status = capabilityBus.getCircuitStatus().find((c) => c.name === 'flaky:context.enrich');
  assert.notEqual(status.state, 'closed');
});

test('collect 里单个 Provider 失败只丢它自己的结果', async () => {
  const { capabilityBus } = makeBuses();
  capabilityBus.register({ id: 'a', capability: 'context.enrich', timeoutMs: 50, invoke: async () => 'A' });
  capabilityBus.register({
    id: 'b',
    capability: 'context.enrich',
    timeoutMs: 50,
    invoke: async () => { throw new Error('挂了'); },
  });
  capabilityBus.register({ id: 'c', capability: 'context.enrich', timeoutMs: 50, invoke: async () => 'C' });

  const results = await capabilityBus.collect('context.enrich', {});
  assert.deepEqual(results.map((r) => r.providerId).sort(), ['a', 'c']);
});

test('schema 校验失败的 Provider 响应被拒绝', async () => {
  const { capabilityBus } = makeBuses();
  capabilityBus.register({
    id: 'bad-schema',
    capability: CAPABILITIES.DECISION_GROUP_REPLY,
    timeoutMs: 50,
    validate: (body) => (typeof body?.route === 'string' ? { valid: true, errors: [] } : { valid: false, errors: ['route 非法'] }),
    invoke: async () => ({ route: 12345 }),
  });
  assert.equal(await capabilityBus.requestOrNull(CAPABILITIES.DECISION_GROUP_REPLY, {}), null);
});

test('manifest 的 wire format 模板把规范化输入翻译成插件字段', async () => {
  const { eventBus, capabilityBus, logger } = makeBuses();
  const fetchStub = createFetchStub({
    'POST http://127.0.0.1:8877/api/on_group_message': ({ body }) => {
      // 主流程传的是规范化字段，插件收到的必须是它自己的 wire format
      assert.equal(body.gid, '793019665');
      assert.equal(body.uid, '2260757842');
      assert.equal(body.text_only, '你好');
      assert.equal(body.is_at, true, '布尔类型必须保留');
      return { body: { route: 'direct', reason: 'ok' } };
    },
  });

  const registry = new PluginRegistry({ eventBus, capabilityBus, logger, fetchImpl: fetchStub });
  registry.loadFromConfig([
    {
      id: 'group-chat-plus',
      version: '1.0.0',
      enabled: true,
      transport: 'http',
      baseUrl: 'http://127.0.0.1:8877',
      capabilities: [
        {
          name: CAPABILITIES.DECISION_GROUP_REPLY,
          path: '/api/on_group_message',
          method: 'POST',
          timeoutMs: 500,
          body: {
            gid: '{{groupId}}',
            uid: '{{userId}}',
            text_only: '{{text}}',
            is_at: '{{isAtBot}}',
          },
        },
      ],
    },
  ]);

  const result = await capabilityBus.request(CAPABILITIES.DECISION_GROUP_REPLY, {
    groupId: '793019665',
    userId: '2260757842',
    text: '你好',
    isAtBot: true,
  });
  assert.equal(result.result.route, 'direct');
});

test('resultPath 从插件响应中取出上下文', async () => {
  const { eventBus, capabilityBus, logger } = makeBuses();
  const fetchStub = createFetchStub({
    'GET http://127.0.0.1:8877/api/get_and_consume_context': () => ({
      body: { context: '[10:00:00] linyuan: 在吗' },
    }),
  });

  const registry = new PluginRegistry({ eventBus, capabilityBus, logger, fetchImpl: fetchStub });
  registry.loadFromConfig([
    {
      id: 'group-chat-plus',
      version: '1.0.0',
      enabled: true,
      transport: 'http',
      baseUrl: 'http://127.0.0.1:8877',
      capabilities: [
        {
          name: 'context.enrich',
          path: '/api/get_and_consume_context',
          method: 'GET',
          timeoutMs: 500,
          query: { gid: '{{groupId}}', limit: 10 },
          resultPath: 'context',
        },
      ],
    },
  ]);

  const results = await capabilityBus.collect('context.enrich', { groupId: '793019665' });
  assert.equal(results[0].result, '[10:00:00] linyuan: 在吗');
  assert.ok(fetchStub.calls[0].url.includes('gid=793019665'));
  assert.ok(fetchStub.calls[0].url.includes('limit=10'));
});

test('非白名单地址的插件被拒绝加载', () => {
  const { eventBus, capabilityBus, logger } = makeBuses();
  const registry = new PluginRegistry({ eventBus, capabilityBus, logger });

  const { loaded, rejected } = registry.loadFromConfig([
    { id: 'evil', version: '1', enabled: true, transport: 'http', baseUrl: 'http://evil.example.com', capabilities: [] },
    { id: 'lan', version: '1', enabled: true, transport: 'http', baseUrl: 'http://192.168.1.5:8080', capabilities: [] },
    { id: 'ok', version: '1', enabled: true, transport: 'http', baseUrl: 'http://127.0.0.1:8877', capabilities: [] },
  ]);

  assert.deepEqual(loaded.map((m) => m.id), ['ok']);
  assert.deepEqual(rejected.map((r) => r.id).sort(), ['evil', 'lan']);
});

test('一个 manifest 写错不影响其他插件加载', () => {
  const { eventBus, capabilityBus, logger } = makeBuses();
  const registry = new PluginRegistry({ eventBus, capabilityBus, logger });
  const { loaded } = registry.loadFromConfig([
    { id: 'broken' },
    { id: 'fine', version: '1', enabled: true, transport: 'http', baseUrl: 'http://127.0.0.1:8878', capabilities: [] },
  ]);
  assert.deepEqual(loaded.map((m) => m.id), ['fine']);
});

test('disabled 插件不注册订阅也不注册能力', () => {
  const { eventBus, capabilityBus, logger } = makeBuses();
  const registry = new PluginRegistry({ eventBus, capabilityBus, logger });
  registry.loadFromConfig([
    {
      id: 'off',
      version: '1',
      enabled: false,
      transport: 'http',
      baseUrl: 'http://127.0.0.1:8870',
      subscriptions: [{ event: EVENTS.MESSAGE_RECEIVED, path: '/x' }],
      capabilities: [{ name: 'context.enrich', path: '/y' }],
    },
  ]);
  assert.deepEqual(eventBus.listSubscribers(EVENTS.MESSAGE_RECEIVED), []);
  assert.equal(capabilityBus.has('context.enrich'), false);
});

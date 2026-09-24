import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/core/event-bus.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { PluginRegistry } from '../../src/core/plugin-registry.js';
import { Mem0Ingestor } from '../../src/orchestration/mem0-ingestor.js';
import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { MESSAGE_TYPES } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

const OWNER_ID = '1216245687';
const OTHER_ID = '2260757842';

test('记忆分流架构：主人私聊进 Mem0，跳过 LivingMemory', async () => {
  const logger = createTestLogger();
  const eventBus = new EventBus({ logger });
  const capabilityBus = new CapabilityBus({ logger });

  const mem0Calls = [];
  const livingMemoryCalls = [];

  const config = {
    identity: {
      ownerId: OWNER_ID,
      robotId: '931338416',
      privateWhitelist: [OWNER_ID, '*'],
    },
    mem0: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:29990',
      userId: 'ruaji',
    },
  };

  // 1. Mem0 组件
  const mem0Ingestor = new Mem0Ingestor({
    eventBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      mem0Calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ results: [{ memory: '主人偏好记忆' }] }) };
    },
  });
  mem0Ingestor.start();

  // 2. PluginRegistry 注册 LivingMemory
  const livingMemoryManifest = {
    id: 'living-memory',
    version: '1.0.0',
    enabled: true,
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8870',
    subscriptions: [
      { event: 'message.received', path: '/api/v1/events', method: 'POST' },
      { event: 'llm.response', path: '/api/v1/events', method: 'POST' },
    ],
    capabilities: [],
    timeouts: { connectMs: 1000, requestMs: 2500 },
  };

  const pluginRegistry = new PluginRegistry({
    eventBus,
    capabilityBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      livingMemoryCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  pluginRegistry.registerManifest(livingMemoryManifest);

  // 主人私聊消息收到
  await eventBus.publish(
    createEvent(EVENTS.MESSAGE_RECEIVED, {
      correlationId: 'c-owner-1',
      sessionId: `qq:private:${OWNER_ID}`,
      payload: {
        messageId: 'm-owner-1',
        userId: OWNER_ID,
        messageType: MESSAGE_TYPES.PRIVATE,
        isPrivate: true,
        isOwner: true,
        text: '主人私聊指令',
        content: '主人私聊指令',
      },
    }),
  );

  // 主人私聊模型回复
  await eventBus.publish(
    createEvent(EVENTS.LLM_RESPONSE, {
      correlationId: 'c-owner-1',
      sessionId: `qq:private:${OWNER_ID}`,
      payload: {
        messageId: 'm-owner-1',
        userId: OWNER_ID,
        messageType: MESSAGE_TYPES.PRIVATE,
        isPrivate: true,
        isOwner: true,
        userText: '主人私聊指令',
        completionText: '收到主人吩咐，已处理完成。',
        text: '收到主人吩咐，已处理完成。',
      },
    }),
  );

  await mem0Ingestor.stop();

  // 断言：Mem0 收到主人私聊沉淀
  assert.equal(mem0Calls.length, 1, '主人私聊必须进入 Mem0');
  assert.match(mem0Calls[0].body.content, /收到主人吩咐/);

  // 断言：LivingMemory 零调用（跳过 message.received 与 llm.response）
  assert.equal(livingMemoryCalls.length, 0, '主人私聊必须跳过向 LivingMemory 投递与反思');
});

test('记忆分流架构：非主人私聊进 LivingMemory，跳过 Mem0', async () => {
  const logger = createTestLogger();
  const eventBus = new EventBus({ logger });
  const capabilityBus = new CapabilityBus({ logger });

  const mem0Calls = [];
  const livingMemoryCalls = [];

  const config = {
    identity: {
      ownerId: OWNER_ID,
      robotId: '931338416',
      privateWhitelist: [OWNER_ID, '*'],
    },
    mem0: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:29990',
      userId: 'ruaji',
    },
  };

  const mem0Ingestor = new Mem0Ingestor({
    eventBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      mem0Calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
  });
  mem0Ingestor.start();

  const livingMemoryManifest = {
    id: 'living-memory',
    version: '1.0.0',
    enabled: true,
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8870',
    subscriptions: [
      { event: 'message.received', path: '/api/v1/events', method: 'POST' },
      { event: 'llm.response', path: '/api/v1/events', method: 'POST' },
    ],
    capabilities: [],
    timeouts: { connectMs: 1000, requestMs: 2500 },
  };

  const pluginRegistry = new PluginRegistry({
    eventBus,
    capabilityBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      livingMemoryCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  pluginRegistry.registerManifest(livingMemoryManifest);

  // 非主人私聊收到
  await eventBus.publish(
    createEvent(EVENTS.MESSAGE_RECEIVED, {
      correlationId: 'c-other-1',
      sessionId: `qq:private:${OTHER_ID}`,
      payload: {
        messageId: 'm-other-1',
        userId: OTHER_ID,
        messageType: MESSAGE_TYPES.PRIVATE,
        isPrivate: true,
        isOwner: false,
        text: '你好呀，我是群友',
        content: '你好呀，我是群友',
      },
    }),
  );

  // 非主人私聊模型回复
  await eventBus.publish(
    createEvent(EVENTS.LLM_RESPONSE, {
      correlationId: 'c-other-1',
      sessionId: `qq:private:${OTHER_ID}`,
      payload: {
        messageId: 'm-other-1',
        userId: OTHER_ID,
        messageType: MESSAGE_TYPES.PRIVATE,
        isPrivate: true,
        isOwner: false,
        userText: '你好呀，我是群友',
        completionText: '你好你好，有什么我可以帮你的吗？',
        text: '你好你好，有什么我可以帮你的吗？',
      },
    }),
  );

  await mem0Ingestor.stop();

  // 断言：Mem0 零调用（跳过非主人私聊）
  assert.equal(mem0Calls.length, 0, '非主人私聊必须跳过 Mem0');

  // 断言：LivingMemory 收到 2 次投递（message.received 与 llm.response）
  assert.equal(livingMemoryCalls.length, 2, '非主人私聊必须正常投递 LivingMemory');
  assert.equal(livingMemoryCalls[0].body.event, 'message.received');
  assert.equal(livingMemoryCalls[0].body.userId, OTHER_ID);
  assert.equal(livingMemoryCalls[1].body.event, 'llm.response');
  assert.equal(livingMemoryCalls[1].body.userId, OTHER_ID);
});

test('记忆分流架构：群聊中主人发言仍正常进入 LivingMemory，不进 Mem0', async () => {
  const logger = createTestLogger();
  const eventBus = new EventBus({ logger });
  const capabilityBus = new CapabilityBus({ logger });

  const mem0Calls = [];
  const livingMemoryCalls = [];

  const config = {
    identity: {
      ownerId: OWNER_ID,
      robotId: '931338416',
      privateWhitelist: [OWNER_ID, '*'],
    },
    mem0: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:29990',
      userId: 'ruaji',
    },
  };

  const mem0Ingestor = new Mem0Ingestor({
    eventBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      mem0Calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
  });
  mem0Ingestor.start();

  const livingMemoryManifest = {
    id: 'living-memory',
    version: '1.0.0',
    enabled: true,
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8870',
    subscriptions: [
      { event: 'message.received', path: '/api/v1/events', method: 'POST' },
      { event: 'llm.response', path: '/api/v1/events', method: 'POST' },
    ],
    capabilities: [],
    timeouts: { connectMs: 1000, requestMs: 2500 },
  };

  const pluginRegistry = new PluginRegistry({
    eventBus,
    capabilityBus,
    config,
    logger,
    fetchImpl: async (url, init) => {
      livingMemoryCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  pluginRegistry.registerManifest(livingMemoryManifest);

  // 群聊中主人发言
  await eventBus.publish(
    createEvent(EVENTS.MESSAGE_RECEIVED, {
      correlationId: 'c-group-1',
      sessionId: 'qq:group:999888',
      payload: {
        messageId: 'm-group-1',
        groupId: '999888',
        userId: OWNER_ID,
        messageType: MESSAGE_TYPES.GROUP,
        isPrivate: false,
        isOwner: true,
        text: '群里的大家晚上好',
        content: '群里的大家晚上好',
      },
    }),
  );

  // 群聊模型回复
  await eventBus.publish(
    createEvent(EVENTS.LLM_RESPONSE, {
      correlationId: 'c-group-1',
      sessionId: 'qq:group:999888',
      payload: {
        messageId: 'm-group-1',
        groupId: '999888',
        userId: OWNER_ID,
        messageType: MESSAGE_TYPES.GROUP,
        isPrivate: false,
        isOwner: true,
        userText: '群里的大家晚上好',
        completionText: '晚上好呀！',
        text: '晚上好呀！',
      },
    }),
  );

  await mem0Ingestor.stop();

  assert.equal(mem0Calls.length, 0, '群聊消息绝不进入 Mem0');
  assert.equal(livingMemoryCalls.length, 2, '群聊消息（即使是主人）必须正常投递 LivingMemory 供群记忆摄取与反思');
});

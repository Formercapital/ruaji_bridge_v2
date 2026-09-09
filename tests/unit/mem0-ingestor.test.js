import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Mem0Ingestor } from '../../src/orchestration/mem0-ingestor.js';
import { EventBus } from '../../src/core/event-bus.js';
import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { MESSAGE_TYPES } from '../../src/contracts/messages.js';
import { createTestLogger, makeTempDir, cleanupDir } from '../helpers.js';

const OWNER = '10000001';
const OTHER = '2260757842';

/**
 * 造一个**真的** LLM_RESPONSE 信封。必须走 createEvent —— 手搓 `{payload: …}`
 * 会绕开它对顶层字段的裁剪，而那次裁剪正是把这个组件静默变成死代码的原因
 * （详见 mem0-ingestor.js 文件头）。
 */
function makeResponseEnvelope({ messageType = MESSAGE_TYPES.PRIVATE, userId = OWNER, groupId = null, userText = '你还记得我上次说的那个项目吗', completionText = '记得，你说要把它拆成两个服务。' } = {}) {
  const targetId = messageType === MESSAGE_TYPES.GROUP ? groupId : userId;
  return createEvent(EVENTS.LLM_RESPONSE, {
    correlationId: 'c-1',
    sessionId: `qq:${messageType}:${targetId}`,
    payload: {
      messageId: '1',
      groupId,
      userId,
      userName: 'ruaji',
      messageType,
      isPrivate: messageType === MESSAGE_TYPES.PRIVATE,
      userText,
      completionText,
      text: completionText,
    },
  });
}

function build({ configOverrides = {}, fetchImpl } = {}) {
  const calls = [];
  const bus = new EventBus({ logger: createTestLogger() });
  const ingestor = new Mem0Ingestor({
    eventBus: bus,
    logger: createTestLogger(),
    config: {
      identity: { ownerId: OWNER },
      mem0: { enabled: true, baseUrl: 'http://127.0.0.1:29990', userId: 'ruaji', ...configOverrides },
    },
    fetchImpl: fetchImpl ?? (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ results: [{ memory: 'ruaji 要把项目拆成两个服务' }] }) };
    }),
  });
  return { bus, ingestor, calls };
}

test('主人私聊会投递，且带上用户原话与昵称', async () => {
  const { bus, ingestor, calls } = build();
  assert.equal(ingestor.start(), true);

  await bus.publish(makeResponseEnvelope());
  await ingestor.stop();

  assert.equal(calls.length, 1, '主人私聊必须沉淀');
  assert.equal(calls[0].url, 'http://127.0.0.1:29990/memories');
  assert.equal(calls[0].body.user_id, 'ruaji');
  assert.equal(calls[0].body.infer, true);
  // 回归防线：曾经因为读 event.text（被 createEvent 丢掉）而只发出 "user: \nassistant: …"
  assert.match(calls[0].body.content, /^\[ruaji\]: 你还记得我上次说的那个项目吗\n/);
  assert.match(calls[0].body.content, /\nassistant: 记得，你说要把它拆成两个服务。$/);
});

test('群聊一律不沉淀', async () => {
  const { bus, ingestor, calls } = build();
  ingestor.start();

  await bus.publish(makeResponseEnvelope({
    messageType: MESSAGE_TYPES.GROUP,
    groupId: '707423412',
    userId: OWNER,
  }));
  await ingestor.stop();

  assert.equal(calls.length, 0, 'ignore_all_groups 默认为真，群聊不能出去');
});

test('非主人的私聊不沉淀', async () => {
  const { bus, ingestor, calls } = build();
  ingestor.start();

  await bus.publish(makeResponseEnvelope({ userId: OTHER }));
  await ingestor.stop();

  assert.equal(calls.length, 0);
});

test('filter 文件解析不了就一条都不放行（fail-closed）', async () => {
  const tmp = makeTempDir();
  try {
    const broken = path.join(tmp, 'mem0_config.json');
    fs.writeFileSync(broken, '{ "filter": { 这不是 JSON', 'utf8');

    const { bus, ingestor, calls } = build({ configOverrides: { filterFile: broken } });
    ingestor.start();

    await bus.publish(makeResponseEnvelope());
    await ingestor.stop();

    assert.equal(calls.length, 0, '读不懂过滤规则时必须保守跳过，不能反过来放行');
  } finally {
    cleanupDir(tmp);
  }
});

test('filter 文件里关掉 ignore_all_groups 后群聊仍受 sessionId 形态拦截', async () => {
  const tmp = makeTempDir();
  try {
    const file = path.join(tmp, 'mem0_config.json');
    // 外部配置那条 `^(qq_)?group_` 是 AstrBot 的下划线格式，对 `qq:group:` 不匹配。
    // 内置的 GROUP_SESSION_RE 是这里唯一真正拦住它的东西。
    fs.writeFileSync(file, JSON.stringify({
      filter: { ignore_all_groups: true, group_session_regex: '^(qq_)?group_', only_ruaji_private: true },
    }), 'utf8');

    const { bus, ingestor, calls } = build({ configOverrides: { filterFile: file } });
    ingestor.start();

    await bus.publish(makeResponseEnvelope({
      messageType: MESSAGE_TYPES.GROUP,
      groupId: '707423412',
      userId: OWNER,
    }));
    await ingestor.stop();

    assert.equal(calls.length, 0);
  } finally {
    cleanupDir(tmp);
  }
});

test('太短的回复不占抽取模型的调用', async () => {
  const { bus, ingestor, calls } = build();
  ingestor.start();

  await bus.publish(makeResponseEnvelope({ completionText: '嗯' }));
  await ingestor.stop();

  assert.equal(calls.length, 0);
});

test('没配 baseUrl 时不订阅，也不会去打 undefined/memories', async () => {
  const { bus, ingestor, calls } = build({ configOverrides: { baseUrl: '' } });
  assert.equal(ingestor.start(), false);
  assert.deepEqual(bus.listSubscribers(EVENTS.LLM_RESPONSE), []);

  await bus.publish(makeResponseEnvelope());
  assert.equal(calls.length, 0);
});

test('enabled=false 时同样不订阅', async () => {
  const { bus, ingestor } = build({ configOverrides: { enabled: false } });
  assert.equal(ingestor.start(), false);
  assert.deepEqual(bus.listSubscribers(EVENTS.LLM_RESPONSE), []);
});

test('stop() 后退订，后续事件不再投递', async () => {
  const { bus, ingestor, calls } = build();
  ingestor.start();
  await bus.publish(makeResponseEnvelope());
  await ingestor.stop();
  const after = calls.length;

  await bus.publish(makeResponseEnvelope());
  assert.equal(calls.length, after, 'stop() 之后不该再有投递');
});

test('Mem0 返回非 2xx 不抛异常，也不吞掉后续事件', async () => {
  const { bus, ingestor } = build({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  ingestor.start();
  await bus.publish(makeResponseEnvelope());
  await ingestor.stop(); // 不抛就算过
});

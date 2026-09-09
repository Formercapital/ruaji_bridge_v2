import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createEvent, EVENTS, EVENT_VERSION, deepFreeze, newCorrelationId } from '../../src/contracts/events.js';
import {
  validateEventEnvelope,
  validateManifest,
  validateModelRequest,
  validateModelResponse,
  validateNapcatEvent,
  validateDecisionResponse,
  validateContextResponse,
  validateRoute,
} from '../../src/contracts/schemas/index.js';
import { createModelRequest, createModelResponse } from '../../src/contracts/messages.js';
import { loadFixture } from '../helpers.js';

// ===== 事件信封（验收标准 12）=====

test('每个核心事件都带版本与 correlationId', () => {
  for (const event of Object.values(EVENTS)) {
    const envelope = createEvent(event, {
      correlationId: newCorrelationId(),
      sessionId: 'qq:group:1',
      payload: { messageId: 'm1' },
    });
    assert.equal(validateEventEnvelope(envelope).valid, true, `${event} 信封应合法`);
    assert.equal(envelope.eventVersion, EVENT_VERSION);
    assert.ok(envelope.correlationId);
    assert.ok(envelope.eventId);
    assert.notEqual(envelope.eventId, envelope.correlationId, 'eventId 与 correlationId 是两个东西');
  }
});

test('缺 correlationId 或 sessionId 直接抛错', () => {
  assert.throws(() => createEvent(EVENTS.MESSAGE_RECEIVED, { sessionId: 's' }));
  assert.throws(() => createEvent(EVENTS.MESSAGE_RECEIVED, { correlationId: 'c' }));
  assert.throws(() => createEvent('unknown.event', { correlationId: 'c', sessionId: 's' }));
});

test('事件 payload 深冻结，订阅者改不动', () => {
  const envelope = createEvent(EVENTS.MESSAGE_RECEIVED, {
    correlationId: 'c',
    sessionId: 's',
    payload: { nested: { value: 1 } },
  });
  assert.throws(() => { envelope.payload.nested.value = 2; }, TypeError);
  assert.ok(Object.isFrozen(envelope.payload.nested));
});

test('deepFreeze 处理数组与循环边界', () => {
  const frozen = deepFreeze({ list: [{ a: 1 }] });
  assert.ok(Object.isFrozen(frozen.list[0]));
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze('str'), 'str');
});

test('信封校验能挑出各种缺陷', () => {
  assert.deepEqual(validateEventEnvelope(null).valid, false);
  assert.equal(validateEventEnvelope({ event: 'message.received' }).valid, false);
  const bad = validateEventEnvelope({
    event: EVENTS.MESSAGE_SENT,
    eventVersion: '999',
    eventId: 'e',
    correlationId: 'c',
    sessionId: 's',
    timestamp: 1,
    payload: {},
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('eventVersion')));
});

// ===== Plugin manifest =====

test('配置样例里的每个插件 manifest 都合法', () => {
  const example = JSON.parse(
    fs.readFileSync(new URL('../../bridge.config.example.json', import.meta.url), 'utf8'),
  );
  for (const manifest of example.plugins) {
    const result = validateManifest(manifest);
    assert.equal(result.valid, true, `${manifest.id}: ${result.errors.join('; ')}`);
  }
});

test('manifest 缺字段会被拒绝', () => {
  assert.equal(validateManifest({}).valid, false);
  assert.equal(validateManifest({ id: 'a', version: '1', enabled: true, transport: 'ftp' }).valid, false);
  assert.equal(
    validateManifest({ id: 'a', version: '1', enabled: true, transport: 'http' }).valid,
    false,
    'http 插件必须有 baseUrl',
  );
});

test('订阅了未知事件会被拒绝', () => {
  const result = validateManifest({
    id: 'a',
    version: '1',
    enabled: true,
    transport: 'http',
    baseUrl: 'http://127.0.0.1:1',
    subscriptions: [{ event: 'not.a.real.event', path: '/x' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('未知事件')));
});

test('http 插件的能力必须声明 path', () => {
  const result = validateManifest({
    id: 'a',
    version: '1',
    enabled: true,
    transport: 'http',
    baseUrl: 'http://127.0.0.1:1',
    capabilities: [{ name: 'context.enrich' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('缺少 path')));
});

// ===== Capability 响应 =====

test('裁决响应校验宽松但有底线', () => {
  assert.equal(validateDecisionResponse({ route: 'direct' }).valid, true);
  assert.equal(validateDecisionResponse({}).valid, true, 'route 缺失由归一化兜底');
  assert.equal(validateDecisionResponse({ route: 123 }).valid, false);
  assert.equal(validateDecisionResponse('not an object').valid, false);
});

test('归一化后的 route 必须在三值之内', () => {
  assert.equal(validateRoute('direct').valid, true);
  assert.equal(validateRoute('auto').valid, true);
  assert.equal(validateRoute('ignore').valid, true);
  assert.equal(validateRoute('duplicate').valid, false, '归一化之后不该再出现 duplicate');
});

test('上下文响应接受多种形态', () => {
  assert.equal(validateContextResponse('纯文本').valid, true);
  assert.equal(validateContextResponse(['a']).valid, true);
  assert.equal(validateContextResponse({ context: 'x' }).valid, true);
  assert.equal(validateContextResponse({ blocks: [] }).valid, true);
  assert.equal(validateContextResponse({ blocks: 'not-array' }).valid, false);
  assert.equal(validateContextResponse(null).valid, true, 'Provider 返回空是允许的');
});

// ===== Model 契约 =====

test('ModelRequest 校验', () => {
  const valid = createModelRequest({
    correlationId: 'c',
    model: 'm',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  });
  assert.equal(validateModelRequest(valid).valid, true);

  assert.equal(validateModelRequest({ correlationId: 'c', model: 'm', messages: [] }).valid, false);
  assert.equal(
    validateModelRequest({ correlationId: 'c', model: 'm', messages: [{ role: 'bad', content: 'x' }] }).valid,
    false,
  );
});

test('ModelRequest 支持多模态 content 数组', () => {
  const request = createModelRequest({
    correlationId: 'c',
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ],
  });
  assert.equal(validateModelRequest(request).valid, true);
});

test('ModelResponse 校验与默认值', () => {
  const response = createModelResponse({ correlationId: 'c', rawText: 'hi' });
  assert.equal(validateModelResponse(response).valid, true);
  assert.ok(response.responseId, '必须有 responseId —— 好感度按它幂等');
  assert.equal(response.role, 'assistant');
  assert.equal(validateModelResponse({ correlationId: 'c' }).valid, false);
});

// ===== NapCat 事件 =====

test('所有 fixture 的 NapCat 事件都通过校验', () => {
  for (const name of [
    'group-at-bot',
    'group-name-call',
    'group-normal',
    'group-at-with-image',
    'group-reply-quote',
    'private-message',
    'private-image',
    'file-message',
    'notice-event',
    'self-message',
  ]) {
    const fixture = loadFixture(name);
    assert.equal(
      validateNapcatEvent(fixture.event).valid,
      true,
      `${name}: ${validateNapcatEvent(fixture.event).errors.join('; ')}`,
    );
  }
});

test('残缺的 message 事件被挑出来', () => {
  assert.equal(validateNapcatEvent({ post_type: 'message', message_type: 'group' }).valid, false);
  assert.equal(
    validateNapcatEvent({ post_type: 'message', message_type: 'group', user_id: 1 }).valid,
    false,
    '群消息缺 group_id',
  );
  assert.equal(validateNapcatEvent({ post_type: 'meta_event' }).valid, true, '非 message 事件不深究');
});

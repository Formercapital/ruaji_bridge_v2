/**
 * tests/integration/rate-limit-panel.test.js — 面板保存频控配置的端到端
 *
 * 起真 HTTP 服务、真发 PUT。这一层最容易出的问题恰恰是"函数都对、热更新没接上"：
 * 面板写文件成功了，但运行中的实例还拿着构造期的快照。这里逐项验：
 *
 *   1. 名单文本（id / id:条数 / id:条数:窗口 / id:block / id:0）落盘成什么形状
 *   2. 落盘后的 config 是否**立即**驱动运行中的 DecisionFlow / InboundFlow
 *   3. 单独窗口与全局窗口改动是否热生效到 SessionStore
 *   4. 非法条目是否被 400 挡在门外（不再静默写进配置里当摆设）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildTestContainer } from '../helpers.js';

async function withPanel(opts, fn) {
  const container = buildTestContainer(opts);
  const server = await container.webServer.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const put = async (payload) => {
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await fn({ container, base, get, put });
  } finally {
    await container.webServer.close();
    container.cleanup();
  }
}

const readDisk = (container) => JSON.parse(fs.readFileSync(container.config.paths.configFile, 'utf8'));

test('频控名单：文本写法保存后按 字符串/对象 两种形状落盘，并立刻驱动运行态裁决', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    assert.deepEqual(initial.config.identity.rateLimitUsers, ['10000002'], '测试基线：只有一条纯 QQ 号');

    const identity = {
      ...initial.config.identity,
      rateLimitUsers: ['10000002', '2416406494:2', '3768463847:block', '1489263434:3:600000'],
    };
    const res = await put({ identity });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const expected = [
      '10000002',                                        // 纯默认额度 → 保持字符串
      { userId: '2416406494', maxReplies: 2 },            // 单独额度 → 对象
      { userId: '3768463847', block: true },              // 严格拦截 → 对象
      { userId: '1489263434', maxReplies: 3, windowMs: 600000 },
    ];
    assert.deepEqual(container.config.identity.rateLimitUsers, expected, '运行态必须是新名单');
    assert.deepEqual(readDisk(container).identity.rateLimitUsers, expected, '磁盘必须是同一形状');
    assert.deepEqual((await get('/api/config')).body.config.identity.rateLimitUsers, expected, 'GET 必须能原样回读');

    // 关键：热更新是否真的接上了裁决层（旧实现这里是构造期 Set，永远是旧名单）
    const group = (userId) => ({ userId, messageType: 'group' });
    assert.deepEqual(container.decisionFlow.rateLimitPolicyFor(group('2416406494')), {
      userId: '2416406494', maxReplies: 2, windowMs: 300000, block: false,
    });
    assert.equal(container.decisionFlow.rateLimitPolicyFor(group('3768463847')).block, true);
    assert.equal(container.decisionFlow.rateLimitPolicyFor(group('10000002')).maxReplies, 5);
    assert.equal(container.decisionFlow.rateLimitPolicyFor(group('999999999')), null, '名单外不受限');
  });
});

test('频控名单：id:0 与 id:block 等价保存，两者都表现为严格拦截', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const res = await put({
      identity: { ...initial.config.identity, rateLimitUsers: ['2416406494:0'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(container.config.identity.rateLimitUsers, [{ userId: '2416406494', block: true }]);
    assert.equal(
      container.decisionFlow.checkRateLimit({ userId: '2416406494', messageType: 'group' }).blocked,
      true,
    );
  });
});

test('频控名单：非法条目被 400 拒绝，且不污染已有配置', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const identity = { ...initial.config.identity, rateLimitUsers: ['10000002'] };
    assert.equal((await put({ identity })).status, 200);

    for (const bad of [['abc'], ['123'], [''], ['2416406494:2000'], ['2416406494:2:10'], [{}], [{ userId: '' }]]) {
      const res = await put({ identity: { ...identity, rateLimitUsers: bad } });
      assert.equal(res.status, 400, `非法名单 ${JSON.stringify(bad)} 必须被拒绝`);
      assert.ok(res.body?.error, '错误响应要带可读原因');
      assert.deepEqual(container.config.identity.rateLimitUsers, ['10000002'], '被拒的配置不得写入运行态');
    }
  });
});

test('频控窗口：面板改 windowMs 会热推到 SessionStore（旧实现是构造期快照，改了不生效）', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const previous = container.sessionStore.rateLimitWindowMs;

    const res = await put({
      decision: {
        ...initial.config.decision,
        rateLimit: { ...initial.config.decision.rateLimit, maxReplies: 2, windowMs: 90000 },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(container.config.decision.rateLimit.windowMs, 90000, '运行态 config 要更新');
    assert.equal(container.sessionStore.rateLimitWindowMs, 90000, 'SessionStore 的窗口必须跟着热更新');
    assert.notEqual(container.sessionStore.rateLimitWindowMs, previous);
    assert.equal(container.config.decision.rateLimit.maxReplies, 2);
    assert.equal(readDisk(container).decision.rateLimit.windowMs, 90000);
  });
});

test('频控窗口：非法阈值/窗口被 400 拒绝', async () => {
  await withPanel({}, async ({ get, put }) => {
    const initial = (await get('/api/config')).body;
    const withRateLimit = (rateLimit) => put({
      decision: { ...initial.config.decision, rateLimit },
    });

    assert.equal((await withRateLimit({ maxReplies: 0, windowMs: 300000 })).status, 400);
    assert.equal((await withRateLimit({ maxReplies: 5, windowMs: 10 })).status, 400);
    assert.equal((await withRateLimit({ maxReplies: 1001, windowMs: 300000 })).status, 400);
    assert.equal((await withRateLimit({ maxReplies: 2, windowMs: 300000 })).status, 200);
  });
});

test('频控作用域：applyToPrivate 默认关闭，开启后私聊裁决也被限速', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    assert.equal(initial.config.decision.rateLimit.applyToPrivate, false, '默认不把频控压到私聊上');

    const identity = { ...initial.config.identity, rateLimitUsers: ['1216245687'] };
    assert.equal((await put({ identity })).status, 200);

    const decision = await container.decisionFlow.decide({
      correlationId: 'c-private',
      messageId: 'm-private',
      userId: '1216245687',
      groupId: null,
      sessionId: 'qq:private:1216245687',
      executionKey: 'private_1216245687',
      messageType: 'private',
      text: '在吗',
      content: '在吗',
      sender: { nickname: '主人预约', displayName: '主人预约' },
      flags: { isAtBot: true, isNameCall: false, isOwner: false },
      media: [],
      extensions: {},
    });
    assert.equal(decision.route, 'direct', '默认私聊不受频控');

    assert.equal((await put({
      decision: { ...initial.config.decision, rateLimit: { ...initial.config.decision.rateLimit, applyToPrivate: true } },
    })).status, 200);

    for (let i = 0; i < 5; i++) container.sessionStore.recordReply('1216245687', 300000);
    const gated = await container.decisionFlow.decide({
      correlationId: 'c-private-2',
      messageId: 'm-private-2',
      userId: '1216245687',
      groupId: null,
      sessionId: 'qq:private:1216245687',
      executionKey: 'private_1216245687',
      messageType: 'private',
      text: '在吗',
      content: '在吗',
      sender: { nickname: '主人预约', displayName: '主人预约' },
      flags: { isAtBot: true, isNameCall: false, isOwner: false },
      media: [],
      extensions: {},
    });
    assert.equal(gated.route, 'ignore', '开启后私聊不再绕过频控');
    assert.equal(gated.reason, 'rate_limited');
  });
});

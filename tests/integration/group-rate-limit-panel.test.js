/**
 * tests/integration/group-rate-limit-panel.test.js — 群白名单频控的面板保存端到端
 *
 * 起真 HTTP 服务、真发 PUT，逐项验：
 *   1. 群白名单条目的三种写法（纯群号 / 群号:条数 / 群号:条数:窗口）落盘成什么形状
 *   2. 落盘后的活配置是否**立即**驱动运行中的 InboundFlow 判定（热更新）
 *   3. 群冷却提示文案落盘 + 热生效
 *   4. 非法条目是否被 400 挡在门外（不静默写进配置当摆设）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildTestContainer } from '../helpers.js';
import { resolveGroupRateLimitPolicy } from '../../src/core/rate-limit-policy.js';

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

test('群白名单频控：文本写法保存后按 字符串/对象 两种形状落盘，并立即驱动运行态判定', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    assert.deepEqual(initial.config.identity.groupWhitelist, [], '测试基线：空名单＝全部放行');

    const identity = {
      ...initial.config.identity,
      groupWhitelist: ['1076958977', '888888888:2', '123123123:5:60000'],
    };
    const res = await put({ identity });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const expected = [
      '1076958977',                                  // 纯群号 → 保持字符串，不限速
      { groupId: '888888888', maxReplies: 2 },       // 单独额度 → 对象
      { groupId: '123123123', maxReplies: 5, windowMs: 60000 },
    ];
    assert.deepEqual(container.config.identity.groupWhitelist, expected, '运行态必须是新名单');
    assert.deepEqual(readDisk(container).identity.groupWhitelist, expected, '磁盘必须是同一形状');
    assert.deepEqual((await get('/api/config')).body.config.identity.groupWhitelist, expected, 'GET 必须能原样回读');

    // 关键：热更新接上了运行态判定（不是构造期快照）
    assert.equal(resolveGroupRateLimitPolicy('1076958977', container.config), null, '纯群号不限速');
    assert.deepEqual(resolveGroupRateLimitPolicy('888888888', container.config), {
      groupId: '888888888', maxReplies: 2, windowMs: 300000, block: false,
    }, '只写条数时窗口回落全局默认');
    assert.deepEqual(resolveGroupRateLimitPolicy('123123123', container.config), {
      groupId: '123123123', maxReplies: 5, windowMs: 60000, block: false,
    });
  });
});

test('群白名单频控：运行中的 InboundFlow 立刻按新额度拦截并算出冷却剩余', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const res = await put({
      identity: { ...initial.config.identity, groupWhitelist: ['1076958977:1:300000'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // 运行态实例当场按新额度判定：额度还没用，放行
    const inbound = { groupId: '1076958977', messageType: 'group' };
    assert.equal(container.inboundFlow._checkGroupRateLimit(inbound).limited, false);

    // 模拟本群已经回过一条（生成成功后 recordGroupReply 会做这件事）
    container.sessionStore.recordGroupReply('1076958977', 300000);
    const hit = container.inboundFlow._checkGroupRateLimit(inbound);
    assert.equal(hit.limited, true, '新额度保存后立即生效，不需要重启');
    assert.ok(hit.retryAfterMs > 0 && hit.retryAfterMs <= 300000, '要算出合理的冷却剩余毫秒');
  });
});

test('群白名单频控：block 条目落盘为对象，运行态第一条就严格拦截', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const res = await put({
      identity: { ...initial.config.identity, groupWhitelist: ['1076958977:block'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(container.config.identity.groupWhitelist, [{ groupId: '1076958977', block: true }]);

    const hit = container.inboundFlow._checkGroupRateLimit({ groupId: '1076958977', messageType: 'group' });
    assert.equal(hit.limited, true);
    assert.equal(hit.blocked, true);
  });
});

test('群白名单频控：非法条目被 400 拒绝，且不污染已有配置', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    const identity = { ...initial.config.identity, groupWhitelist: ['1076958977'] };
    assert.equal((await put({ identity })).status, 200);

    for (const bad of [['not-a-group'], ['1076958977:2000'], ['1076958977:2:10'], [{}], [{ groupId: '' }]]) {
      const res = await put({ identity: { ...identity, groupWhitelist: bad } });
      assert.equal(res.status, 400, `非法群名单 ${JSON.stringify(bad)} 必须被拒绝`);
      assert.ok(res.body?.error, '错误响应要带可读原因');
      assert.deepEqual(container.config.identity.groupWhitelist, ['1076958977'], '被拒的配置不得写入运行态');
    }
  });
});

test('群频控提示文案：面板保存后落盘并热生效', async () => {
  await withPanel({}, async ({ container, get, put }) => {
    const initial = (await get('/api/config')).body;
    assert.equal(
      initial.config.decision.groupRateLimit.notice,
      '瑞姬去休息啦，{minutes}分钟再来找她吧',
      '默认文案',
    );

    const res = await put({
      decision: {
        ...initial.config.decision,
        groupRateLimit: { notice: '别催啦，{minutes} 分钟后再来~' },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(container.config.decision.groupRateLimit.notice, '别催啦，{minutes} 分钟后再来~', '运行态热生效');
    assert.equal(
      readDisk(container).decision.groupRateLimit.notice,
      '别催啦，{minutes} 分钟后再来~',
      '磁盘持久化',
    );
  });
});

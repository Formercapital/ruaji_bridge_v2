/**
 * /stop 急停：redirect 让主人普通消息不再打断在途轮后的唯一手动刹车。
 *
 *   - 在途生成：preempt 掐桥侧 + Hermes 侧 stop + 清排队缓冲
 *   - 防抖窗口内已调度的一轮：取消 timer + 清缓冲
 *   - 空闲：回"没有在途生成"，不动任何状态
 *   - 非主人：静默拒绝（_deny 语义）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

const CONFIG = {
  identity: { ownerId: '10000001', robotId: '398276230', botName: '瑞姬', ownerTitle: '主人' },
  decision: { debounceMs: 800 },
};

function makeInbound(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c-stop',
    messageId: 'm-stop',
    userId: '10000001',
    groupId: '793019665',
    messageType: 'group',
    text: '/stop',
    content: '/stop',
    rawMessage: '/stop',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji(阵亡)' },
    ...overrides,
    flags: { isAtBot: false, isNameCall: false, isOwner: true, ...(overrides.flags ?? {}) },
  });
}

function makeFlow({ stopResult } = {}) {
  const logger = createTestLogger();
  const sessions = new SessionStore();
  const replies = [];
  const stops = [];
  const sender = { enqueue: (m) => replies.push(m) };
  const modelRouter = {
    stop: async (key, opts) => {
      stops.push({ key, opts });
      return stopResult ?? { ok: true, stopped: true };
    },
  };
  const flow = new CommandFlow({
    modelRouter,
    sessionStore: sessions,
    sender,
    config: CONFIG,
    logger,
  });
  return { flow, sessions, replies, stops };
}

test('/stop 在途生成：preempt + 清空排队 + 服务端 stop', async () => {
  const { flow, sessions, replies, stops } = makeFlow();
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    correlationId: 'busy-1',
    sessionKey: 'group_793019665',
  });
  // 模拟排队中的群友消息（bot 互聊触发源）
  sessions.getBuffer('group_793019665').pending.push({ inbound: {}, decision: {} }, { inbound: {}, decision: {} });

  const result = await flow.handle(makeInbound({ executionKey: 'group_793019665' }));

  assert.equal(result.handled, true);
  assert.equal(controller.signal.aborted, true, '必须掐掉在途生成');
  assert.ok(controller.signal.reason?.preempted, '打断原因带 preempted 标记');
  assert.equal(sessions.getBuffer('group_793019665').pending.length, 0, '排队缓冲必须清空');
  assert.equal(stops.length, 1, '必须通知 Hermes 侧 stop');
  assert.equal(stops[0].key, 'group_793019665', 'stop 用在途轮的 sessionKey');
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('已停止'), `回执内容: ${replies[0].text}`);
  assert.ok(replies[0].text.includes('2'), '回执要提到丢弃的排队条数');
});

test('/stop 服务端 stop 失败也照常掐：本地 preempt 已保底', async () => {
  const { flow, sessions, replies, stops } = makeFlow({ stopResult: { ok: false, code: 'http_404' } });
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    correlationId: 'busy-2',
  });

  await flow.handle(makeInbound({ executionKey: 'group_793019665' }));

  assert.equal(controller.signal.aborted, true, '服务端失败不影响本地打断');
  assert.equal(stops.length, 1);
  assert.ok(replies[0].text.includes('连接断开自动停止'), '失败时回执要说明兜底方式');
});

test('/stop 防抖窗口内：取消 timer + 清缓冲，不 preempt', async () => {
  const { flow, sessions, replies, stops } = makeFlow();
  const buf = sessions.getBuffer('group_793019665');
  buf.pending.push({ inbound: {}, decision: {} });
  buf.timer = setTimeout(() => {}, 60000);

  await flow.handle(makeInbound({ executionKey: 'group_793019665' }));

  assert.equal(buf.timer, null, '已调度的 timer 必须取消');
  assert.equal(buf.pending.length, 0, '缓冲必须清空');
  assert.equal(stops.length, 0, '没有在途轮时不该调服务端 stop');
  assert.ok(replies[0].text.includes('已停止'), '回执仍算急停成功');
});

test('/stop 空闲时：只回"没有在途生成"，不动状态', async () => {
  const { flow, sessions, replies, stops } = makeFlow();

  await flow.handle(makeInbound({ executionKey: 'group_793019665' }));

  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('没有在途生成'));
  assert.equal(stops.length, 0);
});

test('/stop 非主人：静默拒绝，不动任何状态', async () => {
  const { flow, sessions, replies, stops } = makeFlow();
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', {
    controller,
    source: 'direct',
    correlationId: 'busy-3',
  });

  const result = await flow.handle(
    makeInbound({
      userId: '2260757842',
      executionKey: 'group_793019665',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
      flags: { isOwner: false },
    }),
  );

  assert.equal(result.handled, true, '命令被拦截，不进模型');
  assert.equal(controller.signal.aborted, false, '群友不能急停');
  assert.equal(replies.length, 0, '_deny 静默，无回执');
  assert.equal(stops.length, 0);
});

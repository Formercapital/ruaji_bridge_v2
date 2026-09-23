/**
 * tests/unit/reply-anchor.test.js — 异步完成通知的引用锚点
 *
 * 覆盖两件事：
 *   1. WakeCursorStore.anchors 的持久化语义（与 cursors/handled 同一套落盘纪律）
 *   2. ReplyAnchorTracker 的选段策略：auto（派发段优先 / 首段兜底 / 不越轮顶掉
 *      派发锚点）、first、last、TTL、消费、通知自身不记录
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { EventBus } from '../../src/core/event-bus.js';
import { loadConfig } from '../../src/core/config.js';
import { WakeCursorStore } from '../../src/storage/wake-cursor-store.js';
import { ReplyAnchorTracker } from '../../src/orchestration/reply-anchor-tracker.js';
import { createTestLogger, makeTempDir, cleanupDir, TEST_ROOT } from '../helpers.js';

const GROUP = 'qq:group:777';
const PRIVATE = 'qq:private:888';

function makeStore(opts = {}) {
  const tmpDir = opts.tmpDir ?? makeTempDir();
  const now = opts.now ?? Date.now;
  const store = new WakeCursorStore({
    cacheDir: tmpDir,
    persistEnabled: opts.persistEnabled !== false,
    now,
    logger: createTestLogger(),
  });
  store.tmpDir = tmpDir;
  return store;
}

/** 造一条 message.sent 事件（payload 形状与 sender._publishSent 一致） */
function sentEnvelope({
  sessionId = GROUP,
  correlationId = 'T1',
  status = 'success',
  replyId = '100',
  text = '',
  origin = null,
  turnId,
} = {}) {
  return createEvent(EVENTS.MESSAGE_SENT, {
    correlationId,
    sessionId,
    payload: {
      messageId: `tx-${replyId}`,
      txId: `tx-${replyId}`,
      target: { type: 'group', id: '777' },
      text,
      status,
      replyId,
      origin,
      turnId: turnId ?? correlationId,
    },
  });
}

function makeTracker(store, anchorCfg = {}, now = Date.now) {
  const config = { wakeDelivery: { enabled: true, anchor: { enabled: true, ...anchorCfg } } };
  return new ReplyAnchorTracker({ config, cursorStore: store, now, logger: createTestLogger() });
}

// ===== 存储 =====

test('anchors：写入/读取/清除并落盘，重载后还在', () => {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore({ tmpDir });
    store.setAnchor(GROUP, { messageId: '90001', turnId: 'T1', matched: 'dispatch' });

    const anchor = store.getAnchor(GROUP);
    assert.equal(anchor.messageId, '90001');
    assert.equal(anchor.matched, 'dispatch');
    assert.equal(anchor.turnId, 'T1');
    assert.ok(anchor.createdAt > 0 && anchor.updatedAt > 0);

    const persisted = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.equal(persisted.anchors[GROUP].messageId, '90001');
    assert.equal(persisted.anchors[GROUP].matched, 'dispatch');

    // 模拟重启
    const reloaded = new WakeCursorStore({ cacheDir: tmpDir, logger: createTestLogger() });
    assert.equal(reloaded.getAnchor(GROUP).messageId, '90001');
    assert.equal(reloaded.stats().anchors, 1);

    reloaded.clearAnchor(GROUP);
    assert.equal(reloaded.getAnchor(GROUP), null);
    const after = JSON.parse(fs.readFileSync(reloaded.file, 'utf8'));
    assert.deepEqual(after.anchors, {});
  } finally {
    cleanupDir(tmpDir);
  }
});

test('anchors：同轮升级（first→dispatch）不刷新 createdAt，跨轮覆盖会刷新', () => {
  let clock = 1_000_000;
  const store = makeStore({ now: () => clock });
  try {
    store.setAnchor(GROUP, { messageId: 'a', turnId: 'T1', matched: 'first' });
    const firstCreated = store.getAnchor(GROUP).createdAt;

    clock += 500;
    store.setAnchor(GROUP, { messageId: 'b', turnId: 'T1', matched: 'dispatch' });
    assert.equal(store.getAnchor(GROUP).createdAt, firstCreated, '同轮升级不该重置首次记录时间');
    assert.equal(store.getAnchor(GROUP).updatedAt, clock);

    clock += 500;
    store.setAnchor(GROUP, { messageId: 'c', turnId: 'T2', matched: 'first' });
    assert.equal(store.getAnchor(GROUP).createdAt, clock, '跨轮是新锚点');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('anchors：setAnchor 空 messageId 不写入；损坏的落盘条目加载时被丢弃', () => {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore({ tmpDir });
    store.setAnchor(GROUP, { messageId: '' });
    store.setAnchor(GROUP, { messageId: null });
    assert.equal(store.getAnchor(GROUP), null);

    // 手工写一份含坏条目的文件：没有 messageId 的锚点必须被忽略
    fs.writeFileSync(
      store.file,
      JSON.stringify({
        version: 1,
        cursors: {},
        handled: {},
        anchors: { [GROUP]: { messageId: '' }, [PRIVATE]: { messageId: 'ok', matched: 'first', updatedAt: 42 } },
      }),
      'utf8',
    );
    const reloaded = new WakeCursorStore({ cacheDir: tmpDir, logger: createTestLogger() });
    assert.equal(reloaded.getAnchor(GROUP), null);
    assert.equal(reloaded.getAnchor(PRIVATE).messageId, 'ok');
  } finally {
    cleanupDir(tmpDir);
  }
});

// ===== 策略 =====

test('auto：无派发标记时记本轮首条发送成功的分段', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '好的呢~' }));
    assert.deepEqual(
      { messageId: store.getAnchor(GROUP).messageId, matched: store.getAnchor(GROUP).matched },
      { messageId: '100', matched: 'first' },
    );

    // 同轮后续普通分段不覆盖首段
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '还有别的事吗' }));
    assert.equal(store.getAnchor(GROUP).messageId, '100');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('auto：首段失败时用第一条真正送达的分段兜底', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ replyId: '100', status: 'failed', text: '第一段' }));
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '第二段' }));
    assert.equal(store.getAnchor(GROUP).messageId, '101');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('auto：同轮内的派发标记段会升级锚点', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '让我看看' }));
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '已经派给 Pi 了，弄好叫你~' }));
    assert.equal(store.getAnchor(GROUP).messageId, '101');
    assert.equal(store.getAnchor(GROUP).matched, 'dispatch');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('auto：别的轮次的普通回复不会顶掉派发锚点', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ correlationId: 'T1', replyId: '100', text: '收到，已派给编程/画师，弄好叫你~' }));
    assert.equal(store.getAnchor(GROUP).matched, 'dispatch');

    // 用户又闲聊，桥接回了一句无关的话 —— 不能把派发承诺顶掉
    tracker.handleSent(sentEnvelope({ correlationId: 'T2', replyId: '200', text: '今天天气不错呀~' }));
    assert.equal(store.getAnchor(GROUP).messageId, '100', '普通轮次不得覆盖派发锚点');
    assert.equal(store.getAnchor(GROUP).matched, 'dispatch');

    // 但新的派发轮次可以覆盖
    tracker.handleSent(sentEnvelope({ correlationId: 'T3', replyId: '300', text: '已经交给 grok 去跑了' }));
    assert.equal(store.getAnchor(GROUP).messageId, '300');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('auto：没有派发锚点时，普通轮次之间正常刷新', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ correlationId: 'T1', replyId: '100', text: '在的' }));
    tracker.handleSent(sentEnvelope({ correlationId: 'T2', replyId: '200', text: '嗯嗯' }));
    assert.equal(store.getAnchor(GROUP).messageId, '200');
    assert.equal(store.getAnchor(GROUP).matched, 'first');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('strategy=first：认首段，不认派发标记', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store, { strategy: 'first' });
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '第一段' }));
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '已经派给 Pi 了' }));
    assert.equal(store.getAnchor(GROUP).messageId, '100');
    assert.equal(store.getAnchor(GROUP).matched, 'first');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('strategy=last：同轮内逐段覆盖，收敛到末段', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store, { strategy: 'last' });
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '第一段' }));
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '第二段' }));
    tracker.handleSent(sentEnvelope({ replyId: '102', text: '最后一段' }));
    assert.equal(store.getAnchor(GROUP).messageId, '102');
    assert.equal(store.getAnchor(GROUP).matched, 'last');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('markers 显式给空数组 = 不认标记，一律首段', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store, { markers: [] });
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '第一段' }));
    tracker.handleSent(sentEnvelope({ replyId: '101', text: '已经派给 Pi 了，弄好叫你~' }));
    assert.equal(store.getAnchor(GROUP).messageId, '100');
    assert.equal(store.getAnchor(GROUP).matched, 'first');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('非成功 / 无 replyId / 通知自身 都不记锚点', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    assert.equal(tracker.handleSent(sentEnvelope({ status: 'dry_run', replyId: 'x' })), null);
    assert.equal(tracker.handleSent(sentEnvelope({ status: 'failed', replyId: 'x' })), null);
    assert.equal(tracker.handleSent(sentEnvelope({ status: 'success', replyId: null })), null);
    assert.equal(tracker.handleSent(sentEnvelope({ origin: 'hermes-wake', replyId: '900' })), null);
    assert.equal(store.getAnchor(GROUP), null);

    // 私聊也照样记（键是契约会话 id）
    tracker.handleSent(sentEnvelope({ sessionId: PRIVATE, replyId: '500', text: '好' }));
    assert.equal(store.getAnchor(PRIVATE).messageId, '500');
  } finally {
    cleanupDir(store.tmpDir);
  }
});

// ===== 生命周期 =====

test('peek：超过 maxAgeMs 的锚点不再返回，并被清掉', () => {
  let clock = 1_000_000;
  const store = makeStore({ now: () => clock });
  try {
    const tracker = makeTracker(store, { maxAgeMs: 1000 }, () => clock);
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '已派给 Pi' }));

    assert.equal(tracker.peek(GROUP).messageId, '100');
    clock += 1001;
    assert.equal(tracker.peek(GROUP), null, '过期锚点不得使用');
    assert.equal(store.getAnchor(GROUP), null, '过期即清');
    assert.equal(tracker.stats.expired, 1);
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('consume：消费后锚点清空，后续通知不会重复引用', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store);
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '已派给 Pi' }));

    assert.equal(tracker.consume(GROUP), true);
    assert.equal(tracker.peek(GROUP), null);
    assert.equal(tracker.consume(GROUP), false, '已消费再消费返回 false');
    assert.equal(tracker.stats.consumed, 1);
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('enabled=false 时既不记录也不返回锚点', () => {
  const store = makeStore();
  try {
    const tracker = makeTracker(store, { enabled: false });
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '已派给 Pi' }));
    assert.equal(store.getAnchor(GROUP), null);

    // 即便存储里有旧锚点（历史数据），关闭后也不得被引用
    store.setAnchor(GROUP, { messageId: 'old', turnId: 'T0', matched: 'dispatch' });
    assert.equal(tracker.peek(GROUP), null);
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('wakeDelivery.enabled=false 时锚点功能整体不启用（不为关闭的功能写盘）', () => {
  const store = makeStore();
  try {
    const tracker = new ReplyAnchorTracker({
      config: { wakeDelivery: { enabled: false, anchor: { enabled: true } } },
      cursorStore: store,
      logger: createTestLogger(),
    });
    assert.equal(tracker.enabled, false);
    tracker.handleSent(sentEnvelope({ replyId: '100', text: '已派给 Pi' }));
    assert.equal(store.getAnchor(GROUP), null);
  } finally {
    cleanupDir(store.tmpDir);
  }
});

test('attach：订阅 message.sent 后发布事件即写入锚点', async () => {
  const store = makeStore();
  try {
    const eventBus = new EventBus({ logger: createTestLogger() });
    const tracker = makeTracker(store).attach(eventBus);
    await eventBus.publish(sentEnvelope({ replyId: '777', text: '已经派给 Pi 了' }));
    assert.equal(store.getAnchor(GROUP).messageId, '777');
    assert.equal(tracker.stats.recorded, 1);
  } finally {
    cleanupDir(store.tmpDir);
  }
});

// ===== 配置校验 =====

function loadWith(anchor) {
  return loadConfig({
    rootDir: TEST_ROOT,
    file: 'bridge.config.example.json',
    env: { NAPCAT_ACCESS_TOKEN: 'test-token', HERMES_API_KEY: 'test-key' },
    cliOverrides: { wakeDelivery: { anchor } },
  });
}

test('config 校验：anchor 的 strategy / maxAgeMs / markers 非法会被拒绝', () => {
  assert.throws(() => loadWith({ strategy: 'nope' }), /anchor\.strategy 非法/);
  assert.throws(() => loadWith({ maxAgeMs: -1 }), /anchor\.maxAgeMs 非法/);
  assert.throws(() => loadWith({ markers: 'not-an-array' }), /anchor\.markers 非法/);

  // 合法边界：first / 空标记 / 0（不限制）都接受
  const ok = loadWith({ strategy: 'first', markers: [], maxAgeMs: 0 });
  assert.equal(ok.wakeDelivery.anchor.strategy, 'first');
  assert.deepEqual(ok.wakeDelivery.anchor.markers, []);
  assert.equal(ok.wakeDelivery.anchor.maxAgeMs, 0);
});

/**
 * tests/integration/send-idempotency.test.js
 *
 * 验收标准 11：发送动作具备幂等保护。
 * 覆盖旧 Bridge 的两个复读根因：
 *   1. "Timeout: NTEvent" 被当成失败重试
 *   2. 重启后无差别补发几小时前的积压消息
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Sender, retryDelayMs } from '../../src/adapters/napcat/sender.js';
import { NapcatApi } from '../../src/adapters/napcat/napcat-api.js';
import { SendQueueStore } from '../../src/storage/send-queue-store.js';
import { EventBus } from '../../src/core/event-bus.js';
import { IdempotencyStore } from '../../src/core/idempotency-store.js';
import { createOutboundMessage } from '../../src/contracts/messages.js';
import { EVENTS } from '../../src/contracts/events.js';
import { makeTempDir, cleanupDir, createTestLogger, createFetchStub } from '../helpers.js';

const CONFIG = {
  mode: 'live',
  reply: { sendEnabled: true, sideEffectsEnabled: true, maxSendAgeMs: 600000, maxSendRetries: 10 },
};

function makeSender(tmp, opts = {}) {
  // 防呆：早先有一半调用点把路由表直接当第二个参数传进来，routes 变成 undefined，
  // 于是 sender 拿到空 stub、所有发送都 ECONNREFUSED，而"期望零调用"的用例反而
  // 蒙对了。这里把写错的形状直接拍死在调用点上。
  const unknown = Object.keys(opts).filter(
    (k) => k !== 'routes' && k !== 'config' && k !== 'senderOpts',
  );
  if (unknown.length) throw new Error(`makeSender 只接受 { routes, config, senderOpts }，多余的键: ${unknown.join(', ')}`);
  const { routes, config = CONFIG, senderOpts = {} } = opts;
  const logger = createTestLogger();
  const fetchImpl = createFetchStub(routes);
  const napcatApi = new NapcatApi({
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: 'tok',
    sendTimeoutMs: 500,
    logger,
    fetchImpl,
  });
  const store = new SendQueueStore({ cacheDir: tmp, maxAgeMs: config.reply.maxSendAgeMs, logger });
  const idempotency = new IdempotencyStore();
  const eventBus = new EventBus({ logger });

  const sender = new Sender({
    napcatApi,
    store,
    eventBus,
    idempotency,
    config,
    logger,
    minGapMs: 0,
    ...senderOpts,
  });
  return { sender, logger, fetchImpl, store, eventBus, idempotency };
}

function makeMessage(overrides = {}) {
  return createOutboundMessage({
    correlationId: 'c1',
    sessionId: 'qq:group:793019665',
    target: { type: 'group', id: '793019665' },
    replyToUserId: '2260757842',
    text: '内容',
    metadata: { isFirst: true },
    ...overrides,
  });
}

async function drain(sender, ms = 300) {
  sender.pump();
  await new Promise((r) => setTimeout(r, ms));
}

test('重试退避分档', () => {
  assert.equal(retryDelayMs(1), 2000);
  assert.equal(retryDelayMs(3), 2000);
  assert.equal(retryDelayMs(4), 5000);
  assert.equal(retryDelayMs(7), 10000);
  assert.equal(retryDelayMs(11), 30000);
});

test('Timeout: NTEvent 视为送达，绝不重发', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let sendCount = 0;
  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        sendCount++;
        return { body: { status: 'failed', retcode: 1200, message: 'Timeout: NTEvent' } };
      },
    },
  });

  sender.enqueue(makeMessage());
  await drain(sender);

  assert.equal(sendCount, 1, 'NTEvent 超时不得重发——这是群里复读的根因');
  assert.equal(sender.pending, 0);
});

test('同一个 txId 只投递一次', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let sendCount = 0;
  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        sendCount++;
        return { body: { status: 'ok', retcode: 0, data: { message_id: 1 } } };
      },
    },
  });

  const message = makeMessage({ txId: 'fixed-tx' });
  sender.enqueue(message);
  sender.enqueue({ ...makeMessage({ txId: 'fixed-tx' }), metadata: { ...message.metadata, createdAt: Date.now() } });
  await drain(sender);

  assert.equal(sendCount, 1, '相同发送事务只能真正打出去一次');
});

test('失败时释放幂等占用，允许重试', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let attempts = 0;
  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        attempts++;
        if (attempts === 1) return { status: 500, body: { status: 'failed' } };
        return { body: { status: 'ok', retcode: 0 } };
      },
    },
  });

  sender.enqueue(makeMessage());
  await drain(sender, 5000);

  assert.equal(attempts, 2, '第一次失败后应当能重试成功');
  assert.equal(sender.pending, 0);
});

test('超过重试上限后归档，不再无限重试', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const config = { ...CONFIG, reply: { ...CONFIG.reply, maxSendRetries: 2 } };
  let attempts = 0;
  const { sender, store } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        attempts++;
        return { status: 500, body: { status: 'failed' } };
      },
    },
    config,
  });

  sender.enqueue(makeMessage());
  await drain(sender, 8000);

  assert.ok(attempts <= 3, `不应无限重试，实际 ${attempts} 次`);
  assert.equal(sender.pending, 0, '毒丸消息必须离开队列');
  const archives = fs.readdirSync(path.join(tmp, 'send_queue_archive'));
  assert.ok(archives.length >= 1, '失败消息应被归档而非删除');
});

test('过旧消息被归档而不是补发', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let sendCount = 0;
  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => { sendCount++; return { body: { status: 'ok', retcode: 0 } }; },
    },
  });

  sender.enqueue(makeMessage({ metadata: { isFirst: true, createdAt: Date.now() - 20 * 60 * 1000 } }));
  await drain(sender);

  assert.equal(sendCount, 0, '20 分钟前的消息不得补发');
  assert.equal(sender.pending, 0);
});

test('队列恢复时过滤过期项；无 createdAt 的旧格式一律当过期', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const logger = createTestLogger();
  const store = new SendQueueStore({ cacheDir: tmp, maxAgeMs: 600000, logger });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'send_queue.json'),
    JSON.stringify([
      { txId: 'fresh', metadata: { createdAt: Date.now() } },
      { txId: 'stale', metadata: { createdAt: Date.now() - 3600000 } },
      { txId: 'legacy-no-timestamp' },
    ]),
  );

  const { fresh, stale } = store.load();
  assert.deepEqual(fresh.map((t2) => t2.txId), ['fresh']);
  assert.deepEqual(stale.map((t2) => t2.txId).sort(), ['legacy-no-timestamp', 'stale']);
  assert.ok(!fs.existsSync(path.join(tmp, 'send_queue.json')), '恢复后必须删掉备份，防止二次补发');
});

test('sendEnabled=false 时走 dry-run，一个字节都不打给 NapCat（影子模式前提）', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const config = { mode: 'shadow', reply: { ...CONFIG.reply, sendEnabled: false } };
  const { sender, fetchImpl } = makeSender(tmp, {
    routes: { '*': () => { throw new Error('影子模式不该发出任何请求'); } },
    config,
  });

  sender.enqueue(makeMessage());
  await drain(sender);

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(sender.dryRunLog.length, 1);
  assert.equal(sender.dryRunLog[0].message, '[CQ:at,qq=2260757842] 内容');
  assert.equal(sender.pending, 0);
});

test('发送完成后发布 message.sent，成功与 dry-run 都发', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { sender, eventBus } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => ({ body: { status: 'ok', retcode: 0, data: { message_id: 42 } } }),
    },
  });

  const seen = [];
  eventBus.subscribe(EVENTS.MESSAGE_SENT, 'test', async (envelope) => { seen.push(envelope.payload); });

  sender.enqueue(makeMessage());
  await drain(sender, 500);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'success');
  assert.equal(seen[0].replyId, 42);
  assert.ok(seen[0].txId);
});

test('内容为空的消息直接跳过，不打给 NapCat', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { sender, fetchImpl } = makeSender(tmp, {
    routes: { '*': () => ({ body: { status: 'ok', retcode: 0 } }) },
  });

  sender.enqueue(makeMessage({ text: '   ' }));
  await drain(sender);

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(sender.pending, 0);
});

test('hasPendingFor 支撑强一致性时序保障', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => ({ body: { status: 'ok', retcode: 0 } }),
    },
  });

  sender.enqueue(makeMessage());
  assert.equal(sender.hasPendingFor('qq:group:793019665', '2260757842'), true);
  await drain(sender, 500);
  assert.equal(sender.hasPendingFor('qq:group:793019665', '2260757842'), false);
});

test('hasPendingFor 对数字/字符串混合的 replyToUserId 也成立', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { sender } = makeSender(tmp, { routes: {} });
  // 模拟从磁盘 JSON 恢复的任务：replyToUserId 被还原成数字
  sender.queue.push({ sessionId: 'qq:group:1', replyToUserId: 12345 });
  assert.equal(sender.hasPendingFor('qq:group:1', '12345'), true);
  assert.equal(sender.hasPendingFor('qq:group:1', 12345), true);
  assert.equal(sender.hasPendingFor('qq:group:1', '99999'), false);
});

test('毒丸消息被归档，不阻塞也不热循环后续消息', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let sendCount = 0;
  const { sender, logger } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        sendCount++;
        return { body: { status: 'ok', retcode: 0 } };
      },
    },
  });

  // 畸形消息：缺 target，buildNapcatPayload 访问 target.type 时抛 TypeError。
  // 修复前这会让 _drain 抛 unhandledRejection 并触发 setImmediate 重泵热循环。
  const poison = {
    txId: 'poison-1',
    correlationId: 'c-poison',
    sessionId: 'qq:group:793019665',
    text: '畸形消息',
    metadata: { createdAt: Date.now(), retry: 0 },
  };
  sender.enqueue(poison);
  sender.enqueue(makeMessage({ txId: 'good-1' }));
  await drain(sender, 500);

  assert.equal(sendCount, 1, '毒丸之后的正常消息必须照常发出');
  assert.equal(sender.pending, 0, '毒丸必须离开队列');
  const archives = fs.readdirSync(path.join(tmp, 'send_queue_archive'));
  assert.ok(archives.length >= 1, '毒丸消息应被归档而非无声消失');
  assert.ok(logger.find('处理消息时发生意外异常').length >= 1, '应留下错误日志供排查');
});

test('发送成功后立即落盘：在途崩溃不会让重启补发已发消息', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let sendCount = 0;
  const { sender } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': async () => {
        sendCount++;
        // 第 2 条在途时制造崩溃窗口：此刻 m1 已发出
        if (sendCount === 2) await new Promise((r) => setTimeout(r, 400));
        return { body: { status: 'ok', retcode: 0 } };
      },
    },
  });

  sender.enqueue(makeMessage({ txId: 'm1' }));
  sender.enqueue(makeMessage({ txId: 'm2' }));
  sender.pump();
  // m1 已送达并落盘，m2 仍在途 —— 旧实现此刻盘上还留着 m1
  await new Promise((r) => setTimeout(r, 150));

  const queueFile = path.join(tmp, 'send_queue.json');
  assert.ok(fs.existsSync(queueFile), '消费后应立即落盘');
  const persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.deepEqual(
    persisted.map((x) => x.txId),
    ['m2'],
    '已发出的 m1 不得再留在盘上队列里（否则重启即复读）',
  );

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sendCount, 2);
  assert.equal(sender.pending, 0);
});

test('过旧消息也发布 message.sent，下游才能清理状态', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { sender, eventBus } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => ({ body: { status: 'ok', retcode: 0 } }),
    },
  });

  const seen = [];
  eventBus.subscribe(EVENTS.MESSAGE_SENT, 'test', async (envelope) => seen.push(envelope.payload));

  sender.enqueue(makeMessage({ metadata: { isFirst: true, createdAt: Date.now() - 20 * 60 * 1000 } }));
  await drain(sender, 300);

  assert.equal(seen.length, 1, '过期丢弃也要通知下游，不能静默消失');
  assert.equal(seen[0].status, 'failed');
});

test('断路器打开后等到冷却结束再探测，消息最终送达且只送一次', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  let attempts = 0;
  const { sender, logger } = makeSender(tmp, {
    routes: {
      'POST http://127.0.0.1:3000/send_group_msg': () => {
        attempts++;
        if (attempts <= 2) return { status: 500, body: { status: 'failed' } };
        return { body: { status: 'ok', retcode: 0 } };
      },
    },
    senderOpts: { breakerThreshold: 2, breakerCooldownMs: 6000 },
  });

  sender.enqueue(makeMessage());
  // 时间线：t0 失败① → t4 失败②（断路器打开，冷却到 t10）→ t8 第 3 次尝试
  // 撞上打开的断路器（CircuitOpenError，等到 t10）→ t12 探测成功
  await drain(sender, 15000);

  assert.equal(attempts, 3, '2 次失败打开断路器，冷却后第 3 次探测成功');
  assert.equal(sender.pending, 0);
  assert.equal(sender.breaker.state, 'closed', '探测成功后断路器应闭合');
  // 打开期间只暂缓一次（等待冷却），不是每 2s 刷一条警告
  assert.equal(logger.find('断路器打开').length, 1);
});

test('dry-run 记录环形截断，长跑不无限增长', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const config = { mode: 'shadow', reply: { ...CONFIG.reply, sendEnabled: false } };
  const { sender } = makeSender(tmp, {
    routes: { '*': () => { throw new Error('影子模式不该发出任何请求'); } },
    config,
    senderOpts: { maxDryRunEntries: 3 },
  });

  for (let i = 0; i < 5; i++) sender.enqueue(makeMessage({ txId: `dry-${i}` }));
  await drain(sender, 500);

  assert.equal(sender.dryRunLog.length, 3);
  assert.equal(sender.dryRunLog[0].txId, 'dry-2', '最早的记录应被挤掉');
  assert.equal(sender.dryRunLog[2].txId, 'dry-4');
});

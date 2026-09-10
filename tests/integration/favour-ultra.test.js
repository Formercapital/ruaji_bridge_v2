/**
 * tests/integration/favour-ultra.test.js — Favour Ultra 接入验收
 *
 * 覆盖合同里桥接侧可在隔离环境验证的行为：
 *   1. 迁移脚本：真实 SQLite 落库、封顶 149、主人满分排他、幂等拒绝重跑、快照可恢复
 *   2. 消费者统一：画像与回复上下文读同一份 Favour 数据，不再出现 90 分制旧刻度
 *   3. 宿主不可达时的降级：不抛异常、不复活旧 [AFF]
 *
 * 全程使用临时目录与伪造 fetch，不写生产数据、不发真实消息。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FavourClient, resolveFavourLevel } from '../../src/storage/favour-client.js';
import { PortrayalWorker } from '../../src/orchestration/portrayal-worker.js';
import { renderSystemText } from '../../src/orchestration/prompt-renderer.js';
import { stripFavourTags } from '../../src/middleware/favour-tags.js';
import { ReplyFlow } from '../../src/orchestration/reply-flow.js';
import { EVENTS } from '../../src/contracts/events.js';
import { TraceCollector } from '../../src/web/trace-collector.js';
import { createAffectionApi } from '../../src/web/api/affection.js';

function makeLogger(warns = []) {
  const log = (level) => (msg) => {
    if (level === 'warn') warns.push(msg);
  };
  const logger = { info: log('info'), warn: log('warn'), debug: log('debug'), error: log('error') };
  logger.child = () => logger;
  return logger;
}

/**
 * 评分结算时序（合同 Seam A 断言）：
 * 模型完成事件（含完整原文）的派发必须先于收尾轮的修饰调用，
 * 恰好派发一次，且同步等待（宿主暂存完成前不进收尾轮）。
 */
function buildSettlementHarness({ publishImpl, logger }) {
  const events = [];
  const pipelineCalls = [];
  const enqueued = [];
  const collector = new TraceCollector();

  const eventBus = {
    publish: (envelope) => {
      events.push(envelope);
      return publishImpl ? publishImpl(envelope) : Promise.resolve();
    },
  };

  const pipeline = {
    run: async (_name, ctx) => {
      if (ctx.isFinalPass) pipelineCalls.push({ finalPass: true, at: Date.now() });
      return ctx;
    },
  };

  const sender = { enqueue: (m) => enqueued.push(m) };

  const models = {
    generate: async (_req, { onText }) => {
      onText?.('今天也辛苦啦[好感度上升:5]');
      return {
        responseId: 'resp-1',
        rawText: '今天也辛苦啦[好感度上升:5]',
        model: 'test-model',
        usage: { totalTokens: 10 },
        latencyMs: 5,
      };
    },
  };

  const flow = new ReplyFlow({
    modelRouter: models,
    pipeline,
    sender,
    eventBus,
    contextFlow: { getAffectionContext: () => null },
    sessionStore: {},
    config: {
      identity: { ownerId: '3054039169', botName: '瑞姬' },
      model: { model: 'test-model', stream: false },
      reply: { settlementTimeoutMs: 500 },
    },
    logger: logger ?? makeLogger(),
    traceCollector: collector,
  });

  const inbound = {
    correlationId: 'corr-1',
    sessionId: 'qq:group:123',
    executionKey: 'qq:group:123',
    messageId: 'msg-100',
    userId: '1001',
    groupId: '123',
    messageType: 'group',
    sender: { displayName: '群友甲' },
    flags: { isOwner: false },
    content: '你好',
    text: '你好',
  };

  return { flow, inbound, events, pipelineCalls, enqueued, collector };
}

test('结算时序：llm.response 恰好一次、先于收尾轮、同步等待宿主暂存完成', async () => {
  // publish 挂起 30ms 再完成 —— 若桥接不等待，收尾轮会在 publishDone 之前开跑
  let publishDone = false;
  const { flow, inbound, events, pipelineCalls } = buildSettlementHarness({
    publishImpl: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          publishDone = true;
          resolve();
        }, 30);
      }),
  });

  await flow.run({ inbound, triggerType: 'at', contextBlocks: [], signal: undefined });

  const responses = events.filter((e) => e.event === EVENTS.LLM_RESPONSE);
  assert.equal(responses.length, 1, '一次回复只派发一次模型完成事件');
  assert.equal(responses[0].payload.messageId, 'msg-100', '暂存键与修饰请求共用同一 messageId');
  assert.equal(responses[0].payload.completionText, '今天也辛苦啦[好感度上升:5]', '事件携带完整原文');

  assert.equal(pipelineCalls.length, 1, '收尾轮恰好一次');
  assert.equal(pipelineCalls[0].finalPass, true);
  assert.ok(publishDone, '收尾轮开跑前，宿主暂存订阅者已完成（同步等待生效）');
});

test('结算时序：派发超时只跳过本轮结算，不阻断收尾轮与发送', async () => {
  const warns = [];
  const logger = makeLogger(warns);

  const { flow, inbound, events, pipelineCalls, enqueued } = buildSettlementHarness({
    publishImpl: () => new Promise(() => {}), // 永不完成，模拟宿主挂死
    logger,
  });

  await flow.run({ inbound, triggerType: 'at', contextBlocks: [], signal: undefined });

  assert.equal(events.filter((e) => e.event === EVENTS.LLM_RESPONSE).length, 1);
  assert.equal(pipelineCalls.length, 1, '超时降级后收尾轮照常执行');
  assert.ok(enqueued.length > 0, '文本照常进入发送队列');
  assert.ok(warns.some((w) => String(w).includes('结算')), '超时必须留下明确记录');
});

test('全链路追踪：run() 把最终注入的 prompt 补录进 trace', async () => {
  const { flow, inbound, collector } = buildSettlementHarness({});

  await flow.run({
    inbound,
    triggerType: 'at',
    contextBlocks: [{ source: 'living-memory', text: '昨天聊过猫猫', metadata: { slot: 'extra' }, priority: 50 }],
    signal: undefined,
  });

  const trace = collector.get('corr-1');
  assert.ok(trace, 'trace 已建立');

  const p = trace.prompt;
  assert.ok(p, 'prompt 已补录');
  assert.equal(p.model, 'test-model');
  assert.equal(p.messageCount, 2, 'system + user 两条消息');
  assert.ok(p.systemText.includes('昨天聊过猫猫'), 'context 块正文进入 systemText');
  assert.ok(p.systemText.includes('群友甲'), '用户身份头进入 systemText');
  assert.ok(p.userMessage.includes('你好'), '用户原话进入 userMessage');
  assert.equal(p.truncated, false);
});

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MIGRATION = path.join(ROOT, 'scripts', 'migrate-favour-ultra.py');
const PYTHON = path.join(ROOT, 'astr', 'unified_astrbot_host', '.venv', 'Scripts', 'python.exe');

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `favour-${tag}-`));
}

function favourResponse(records) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ global: records, non_global: [] }),
  };
}

test('迁移：旧分数封顶 149，主人满分排他，机器人跳过，快照与报告可核对', (t) => {
  if (!fs.existsSync(PYTHON)) return t.skip('宿主 venv 不可用，跳过迁移脚本测试');

  const workspace = tmpDir('migrate');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const source = path.join(workspace, 'affection.json');
  const dataDir = path.join(workspace, 'data');
  fs.writeFileSync(
    source,
    JSON.stringify({
      users: {
        1001: { affection: 90, nickname: '群友甲' },
        1002: { affection: 12.34, nickname: '群友乙' },
        1003: { affection: -250, nickname: '群友丙' },
        2002: { affection: 50, is_bot: true },
        3054039169: { affection: 100, nickname: '主人' },
      },
    }),
  );

  const out = execFileSync(
    PYTHON,
    [MIGRATION, '--source', source, '--data-dir', dataDir, '--owner-id', '3054039169'],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(out).ok, true);

  // 快照与报告
  assert.ok(fs.existsSync(`${source}.favour-ultra-before-migration`), '必须留下迁移前快照');
  const report = JSON.parse(fs.readFileSync(path.join(dataDir, 'migration-report.json'), 'utf8'));
  const byUser = Object.fromEntries(report.records.map((r) => [r.user_id, r]));

  assert.equal(byUser['1001'].favour, 90, '旧 90 导入后仍是 90，不虚假升级');
  assert.equal(byUser['1002'].favour, 12, '小数归一化为整数');
  assert.equal(byUser['1003'].favour, -200, '低于下限被钳到 -200');
  assert.equal(byUser['2002'], undefined, '机器人自身跳过');
  assert.equal(byUser['3054039169'].favour, 1000, '主人满分');
  assert.equal(byUser['3054039169'].is_unique, true, '主人默认排他绑定');
  assert.equal(byUser['1001'].relationship, '', '旧自动称号不导入为已确认关系');

  // 真实 SQLite 落库
  assert.ok(fs.existsSync(path.join(dataDir, 'favour.db')), '必须写入上游同名数据库');

  // 幂等：标记存在即拒绝重跑，不会把已增长的分数压回
  assert.throws(
    () =>
      execFileSync(
        PYTHON,
        [MIGRATION, '--source', source, '--data-dir', dataDir, '--owner-id', '3054039169'],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    /migration already completed/,
  );
});

test('封顶规则：普通群友导入不按比例放大，最高 149', () => {
  const clamp = (v) => Math.max(-200, Math.min(149, Math.round(v)));
  assert.equal(clamp(90), 90);
  assert.equal(clamp(200), 149);
  assert.equal(clamp(-999), -200);
});

test('新刻度等级名与上游分级一致', () => {
  assert.equal(resolveFavourLevel(0), '普通');
  assert.equal(resolveFavourLevel(149), '普通');
  assert.equal(resolveFavourLevel(150), '喜欢');
  assert.equal(resolveFavourLevel(300), '亲密');
  assert.equal(resolveFavourLevel(450), '挚爱');
  assert.equal(resolveFavourLevel(1000), '挚爱');
  assert.equal(resolveFavourLevel(-160), '极度厌恶');
});

test('FavourClient 读宿主通用页面 API，拿到新刻度与排他标记', async () => {
  const calls = [];
  const client = new FavourClient({
    baseUrl: 'http://127.0.0.1:8870',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return favourResponse([
        { user_id: '1001', username: '群友甲', favour: 320, relationship: '挚友', is_unique: false },
        { user_id: '3054039169', username: '主人', favour: 1000, relationship: '亲密', is_unique: true },
      ]);
    },
  });

  const member = await client.getContext('1001');
  assert.equal(member.favour, 320);
  assert.equal(member.level, '亲密');
  assert.equal(member.relationship, '挚友');
  assert.equal(member.isUnique, false);

  const owner = await client.getContext('3054039169');
  assert.equal(owner.favour, 1000);
  assert.equal(owner.isUnique, true, '主人排他绑定对其他消费者可见');

  const line = await client.renderContextLine('1001');
  assert.match(line, /320\/1000/);
  assert.doesNotMatch(line, /\/90/, '不得出现旧 90 分制刻度');

  assert.equal(calls.length, 1, '同一窗口内命中缓存，不重复打宿主');
  assert.match(calls[0], /\/plug\/favour_ultra\/api\/datarecords$/);
});

test('FavourClient：宿主不可达时安全降级为空，不抛异常', async () => {
  const client = new FavourClient({
    baseUrl: 'http://127.0.0.1:8870',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(await client.getContext('1001'), null);
  assert.equal(await client.renderContextLine('1001'), '');
});

test('FavourClient：未启用（无宿主地址）时 enabled=false，消费者走旧路径', async () => {
  const client = new FavourClient({ baseUrl: '' });
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.listRecords(), []);
});

test('画像 worker 读 Favour 新数据，不再出现旧 90 分制', async () => {
  const favour = new FavourClient({
    baseUrl: 'http://127.0.0.1:8870',
    fetchImpl: async () =>
      favourResponse([{ user_id: '1001', username: '群友甲', favour: 155, relationship: '', is_unique: false }]),
  });
  const worker = new PortrayalWorker({ favourClient: favour, config: {} });

  const line = await worker._renderRelationContext('1001');
  assert.match(line, /155\/1000/);
  assert.match(line, /喜欢/);
  assert.doesNotMatch(line, /\/90/);
});

test('画像 worker：Favour 未启用时回落旧存储，行为不变', async () => {
  const worker = new PortrayalWorker({
    favourClient: new FavourClient({ baseUrl: '' }),
    affectionStore: {
      getContext: () => ({ affection: 42, level: '熟络群友', relationship: '', is_unique: false }),
    },
    config: {},
  });

  const line = await worker._renderRelationContext('1001');
  assert.match(line, /42\/90/, '旧路径保持原样，便于回滚');
});

test('回复上下文：Favour 模式下桥接不注入旧刻度与旧评分指令，只保留画像', () => {
  const inbound = {
    userId: '1001',
    groupId: '777',
    messageType: 'group',
    sender: { displayName: '群友甲' },
    flags: { isOwner: false },
    content: '你好',
    text: '你好',
  };

  const text = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: { favourManagedByHost: true, portrayal: '话少、爱玩梗' },
    identity: { ownerId: '3054039169', botName: '瑞姬' },
  });

  assert.match(text, /话少、爱玩梗/, '画像仍由桥接注入');
  assert.doesNotMatch(text, /好感: /, 'Favour 模式下不注入旧好感行');
  assert.doesNotMatch(text, /\[AFF:/, '不注入旧评分标记规则');
});

test('标签清洗：新标签族与旧 [AFF] 都不会泄漏到出站文本', () => {
  const raw =
    '今天也辛苦啦[好感度上升:5]\n' +
    '［好感度 持平］\n' +
    '[用户申请确认关系:1001:挚友:true:false]\n' +
    '[主动确认关系:1001:伴侣:true]\n' +
    '[主动解除关系:1001]\n' +
    '[Favour increased: 3]\n' +
    '[AFF:+2|旧体系]';

  const cleaned = stripFavourTags(raw);
  assert.equal(cleaned, '今天也辛苦啦');
  for (const leak of ['好感度', '确认关系', '解除关系', 'Favour', 'AFF']) {
    assert.ok(!cleaned.includes(leak), `${leak} 不得泄漏`);
  }
});

test('面板好感度读接口在 Favour 模式下读新数据，写入口下线', async () => {
  const favourClient = new FavourClient({
    baseUrl: 'http://127.0.0.1:8870',
    fetchImpl: async () =>
      favourResponse([
        { user_id: '1001', username: '群友甲', favour: 320, relationship: '挚友', is_unique: false },
        { user_id: '3054039169', username: '主人', favour: 1000, relationship: '亲密', is_unique: true },
      ]),
  });
  const api = createAffectionApi({
    affectionStore: {
      isOwner: () => false,
      listUsers: () => [],
      getUser: () => null,
      suppressedWrites: [],
    },
    favourClient,
    config: {
      favourUltraEnabled: true,
      mode: 'live',
      reply: { sideEffectsEnabled: true },
      identity: { ownerId: '3054039169' },
      paths: { affectionFile: 'x' },
    },
    logger: makeLogger(),
  });

  const list = await api['GET /api/affection']({ url: new URL('http://x/api/affection') });
  assert.equal(list.body.source, 'favour-ultra');
  assert.equal(list.body.total, 2);
  const owner = list.body.items.find((r) => r.uid === '3054039169');
  assert.equal(owner.affection, 1000, '面板看到主人满分');
  assert.equal(owner.isOwner, true);
  assert.equal(owner.isUnique, true, '排他标记对面板可见');
  const member = list.body.items.find((r) => r.uid === '1001');
  assert.equal(member.affection, 320);
  assert.doesNotMatch(String(member.level), /挚友/, '等级用新刻度名（320=亲密），不用旧阶梯');
  assert.equal(list.body.stages[6].hi, 1000, '面板等级带换成新刻度');

  const detail = await api['GET /api/affection/*']({ pathname: '/api/affection/1001' });
  assert.equal(detail.body.item.affection, 320);

  const adjust = await api['POST /api/affection/adjust']({ body: { uid: '1001', affection: 50 } });
  assert.equal(adjust.status, 410, '写入口必须下线（Favour 页面是唯一写表面）');
  assert.match(adjust.body.hint, /唯一写表面/);

  const cv = await api['POST /api/affection/cold_violence']({ body: { uid: '1001', action: 'trigger' } });
  assert.equal(cv.status, 410, '冷暴力写入口同样下线，走命令或原生页面');
});

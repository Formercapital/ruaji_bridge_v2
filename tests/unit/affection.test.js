import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AffectionStore,
  getRelationStage,
  formatBar,
  MAX_AFFECTION,
  NON_OWNER_MAX_AFFECTION,
  INITIAL_AFFECTION,
} from '../../src/storage/affection-store.js';
import {
  stripAffTags,
  extractAffection,
  createAffectionMiddleware,
  FALLBACK_DELTA,
} from '../../src/middleware/affection.js';
import { IdempotencyStore } from '../../src/core/idempotency-store.js';
import { makeTempDir, cleanupDir, createTestLogger, seedAffection, loadTextFixture } from '../helpers.js';

const OWNER = '10000001';
const ROBOT = '398276230';
const OTHER = '2260757842';

function makeStore(tmp, { persistEnabled = false, users = {}, now } = {}) {
  const file = seedAffection(tmp, users);
  return new AffectionStore({
    file,
    ownerId: OWNER,
    robotId: ROBOT,
    persistEnabled,
    logger: createTestLogger(),
    now,
  });
}

test('10阶关系阶梯边界（含负好感与上限）', () => {
  assert.equal(getRelationStage(-100).title, '死敌');
  assert.equal(getRelationStage(-85).title, '死敌');
  assert.equal(getRelationStage(-80).title, '厌恶');
  assert.equal(getRelationStage(-55).title, '厌恶');
  assert.equal(getRelationStage(-50).title, '嫌弃');
  assert.equal(getRelationStage(-25).title, '嫌弃');
  assert.equal(getRelationStage(-20).title, '警惕');
  assert.equal(getRelationStage(-1).title, '警惕');
  assert.equal(getRelationStage(0).title, '陌生人');
  assert.equal(getRelationStage(20).title, '陌生人');
  assert.equal(getRelationStage(21).title, '点头之交');
  assert.equal(getRelationStage(60).title, '熟络群友');
  assert.equal(getRelationStage(81).title, '挚友');
  assert.equal(getRelationStage(90).title, '挚友');
  assert.equal(getRelationStage(100).title, '灵魂之友');
});

test('排他性独占关系绑定与冲突防护，好感跌破 -20 自动决裂', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  const UID_A = '11111';
  const UID_B = '22222';

  store.onUserMessage({ uid: UID_A, nickname: '用户A' });
  store.onUserMessage({ uid: UID_B, nickname: '用户B' });

  // 1. 成功绑定排他关系
  const resA = store.setRelation(UID_A, '专属顾问', true);
  assert.equal(resA.ok, true);
  assert.equal(store.getUniqueRelationHolder('专属顾问'), UID_A);

  // 2. 他人尝试绑定已被占用的排他关系 -> 拒绝
  const resB = store.setRelation(UID_B, '专属顾问', true);
  assert.equal(resB.ok, false);
  assert.equal(resB.holder, UID_A);

  // 3. 用户 A 好感度跌破 -20，排他关系自动破裂解除
  store.adminSet(UID_A, -25, '严重冒犯');
  store.applyDelta(UID_A, -1, '继续作死');
  assert.equal(store.getUser(UID_A).is_unique, false);
  assert.equal(store.getUser(UID_A).relationship, '嫌弃');
  assert.equal(store.getUniqueRelationHolder('专属顾问'), null, '锁已自动释放');
});

test('进度条长度恒为 10', () => {
  for (const v of [0, 20, 55, 90, 100]) assert.equal(formatBar(v).length, 10);
});

test('主人恒 100，applyDelta 对主人无效，冷暴力对主人免疫（附录 1）', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  store.onUserMessage({ uid: OWNER, nickname: 'ruaji(阵亡)' });
  assert.equal(store.getUser(OWNER).affection, MAX_AFFECTION);

  assert.equal(store.applyDelta(OWNER, -5, '测试'), null, '主人不参与好感度评估');
  assert.equal(store.getUser(OWNER).affection, MAX_AFFECTION);
  assert.equal(store.getUser(OWNER).relationship, '另一个自己 (唯一绑定者)');

  // 冷暴力对主人免疫
  assert.equal(store.isColdViolent(OWNER), false);
  assert.equal(store.getColdRemainingMinutes(OWNER), 0);
  assert.equal(store.triggerColdViolence(OWNER), false);
  assert.equal(store.getContext(OWNER).atMax, false, '主人不计入非主人90上限');
});

test('非主人初始 20、上限 90', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  store.onUserMessage({ uid: OTHER, nickname: '御娘狼三千' });
  // 首条消息同时触发"每日首条 +0.01"，所以是 20.01 而非 20 —— 旧 affection.js 同样行为
  assert.ok(
    Math.abs(store.getUser(OTHER).affection - INITIAL_AFFECTION) < 0.02,
    `初始好感应当接近 ${INITIAL_AFFECTION}，实际 ${store.getUser(OTHER).affection}`,
  );

  for (let i = 0; i < 30; i++) store.applyDelta(OTHER, 5, '刷分');
  assert.equal(store.getUser(OTHER).affection, NON_OWNER_MAX_AFFECTION, '非主人封顶 90');
});

test('delta 钳制在 [-5, +5]', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  store.onUserMessage({ uid: OTHER, nickname: 'x' });

  const up = store.applyDelta(OTHER, 999, '爆表');
  assert.equal(up.appliedDelta, 5);
  const down = store.applyDelta(OTHER, -999, '暴跌');
  assert.equal(down.appliedDelta, -5);
});

test('好感度不会跌破 -100', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  for (let i = 0; i < 30; i++) store.applyDelta(OTHER, -5, '掉');
  assert.equal(store.getUser(OTHER).affection, -100);
});

test('超过 7 天未互动按天衰减，单次最多扣 10', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const base = Date.parse('2026-08-01T00:00:00Z');
  let now = base;
  const store = makeStore(tmp, { now: () => now });

  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  store.applyDelta(OTHER, 5, '起步');
  const before = store.getUser(OTHER).affection;

  now = base + 20 * 86400000; // 20 天后
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  // 20-7=13 天，但单次上限 10
  assert.equal(Math.round(store.getUser(OTHER).affection * 100) / 100, Math.round((before - 10 + 0.01) * 100) / 100);
});

test('每日首条微增 0.01，同一天不重复加', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const now = Date.parse('2026-08-20T10:00:00Z');
  const store = makeStore(tmp, { now: () => now });

  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const first = store.getUser(OTHER).affection;
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  assert.equal(store.getUser(OTHER).affection, first, '同一天只加一次');
});

test('recentDeltas 只留最近 5 条', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  for (let i = 0; i < 8; i++) store.applyDelta(OTHER, 1, `理由${i}`);

  const deltas = store.getUser(OTHER).recentDeltas;
  assert.equal(deltas.length, 5);
  assert.equal(deltas[0].reason, '理由7', '最新的在最前面');
});

test('连续 3 次扣分触发冷暴力，加分重置计数，可手动解除（Favour_Ultra 特性）', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const base = Date.parse('2026-08-25T10:00:00Z');
  let now = base;
  const store = makeStore(tmp, { now: () => now });

  store.onUserMessage({ uid: OTHER, nickname: '御娘狼三千' });
  assert.equal(store.isColdViolent(OTHER), false);

  // 第 1 次扣分
  store.applyDelta(OTHER, -1, '踩线');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 1);
  assert.equal(store.isColdViolent(OTHER), false);

  // 第 2 次扣分
  store.applyDelta(OTHER, -2, '恶作剧');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 2);
  assert.equal(store.isColdViolent(OTHER), false);

  // 第 3 次扣分 → 触发冷暴力，且 consecutiveDecreases 归零
  store.applyDelta(OTHER, -1, '屡教不改');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 0, '触发惩罚后计数应当归零');
  assert.equal(store.isColdViolent(OTHER), true);
  assert.equal(store.getUser(OTHER).emotional_state, 'cold_violence');
  assert.equal(store.getColdRemainingMinutes(OTHER), 60);

  // 30分钟后仍处于冷暴力中
  now = base + 30 * 60 * 1000;
  assert.equal(store.isColdViolent(OTHER), true);
  assert.equal(store.getColdRemainingMinutes(OTHER), 30);

  // 61分钟后自动到期
  now = base + 61 * 60 * 1000;
  assert.equal(store.isColdViolent(OTHER), false);
  assert.equal(store.getColdRemainingMinutes(OTHER), 0);

  // 到期后再扣 1 次分，不会直接触发冷暴力，而是从 1 开始计
  store.applyDelta(OTHER, -1, '到期后再犯1次');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 1);
  assert.equal(store.isColdViolent(OTHER), false);

  // 重置时间，手动触发并手动解除
  now = base;
  store.triggerColdViolence(OTHER, 45 * 60 * 1000);
  assert.equal(store.isColdViolent(OTHER), true);
  assert.equal(store.getColdRemainingMinutes(OTHER), 45);

  assert.equal(store.liftColdViolence(OTHER), true);
  assert.equal(store.isColdViolent(OTHER), false);
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 0);
  assert.equal(store.liftColdViolence(OTHER), false, '已经解除后再解除返回 false');

  // 对从未有记录的全新 uid 施加冷暴力（P0 验证）
  const NEW_USER = '123456789';
  assert.equal(store.getUser(NEW_USER), null);
  assert.equal(store.triggerColdViolence(NEW_USER, 30 * 60 * 1000), true);
  assert.ok(store.getUser(NEW_USER));
  assert.equal(store.isColdViolent(NEW_USER), true);
  assert.equal(store.getColdRemainingMinutes(NEW_USER), 30);

  // 正向互动重置连续扣分
  store.applyDelta(OTHER, -1, '扣分1');
  store.applyDelta(OTHER, -1, '扣分2');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 2);
  store.applyDelta(OTHER, 1, '表现良好');
  assert.equal(store.getUser(OTHER).consecutiveDecreases, 0);
});

test('读旧格式 affection.json 不改结构', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, {
    users: {
      [OTHER]: {
        nickname: '御娘狼三千',
        affection: 55.5,
        relationship: '熟络群友',
        emotional_state: 'calm',
        interactions: 42,
        firstSeen: '2026-08-01T00:00:00.000Z',
        lastSeen: '2026-08-20T00:00:00.000Z',
        lastDay: '2026-08-20',
        lastDecay: 1787000000000,
        recentDeltas: [],
      },
    },
  });

  const ctx = store.getContext(OTHER);
  assert.equal(ctx.affection, 56);
  assert.equal(ctx.level, '熟络群友');
  assert.equal(ctx.interactions, 42);
});

test('persistEnabled=false 时绝不写盘（验收标准 14）', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const file = seedAffection(tmp, {});
  const before = fs.readFileSync(file, 'utf8');

  const store = new AffectionStore({
    file,
    ownerId: OWNER,
    robotId: ROBOT,
    persistEnabled: false,
    logger: createTestLogger(),
  });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  store.applyDelta(OTHER, 3, '测试');
  store.flush();

  assert.equal(fs.readFileSync(file, 'utf8'), before, '影子模式下文件内容必须一字不变');
  assert.ok(store.suppressedWrites.length >= 2, '被抑制的写入应当被记录下来');
  assert.ok(!fs.existsSync(`${file}.v2.tmp`));
});

test('persistEnabled=true 时用 tmp+rename 原子落盘', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const file = seedAffection(tmp, {});
  const store = new AffectionStore({
    file,
    ownerId: OWNER,
    robotId: ROBOT,
    persistEnabled: true,
    logger: createTestLogger(),
  });

  store.onUserMessage({ uid: OTHER, nickname: '御娘狼三千' });
  store.flush();

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.users[OTHER].nickname, '御娘狼三千');
  assert.ok(!fs.existsSync(`${file}.v2.tmp`), 'tmp 文件应当已被 rename 掉');
  // 临时文件名带 .v2 前缀，不与旧 Bridge 的 affection.json.tmp 撞车
  assert.ok(!fs.existsSync(path.join(tmp, 'affection.json.tmp')));
});

// ===== 标记解析 =====

test('stripAffTags 覆盖三种编码变体', () => {
  assert.equal(stripAffTags('回复内容 [AFF:+2|理由]'), '回复内容');
  assert.equal(stripAffTags('回复内容 &#91;AFF:-1|理由&#93;'), '回复内容');
  assert.equal(stripAffTags('回复内容 [AFF:+3|理由&#93;'), '回复内容');
  assert.equal(stripAffTags('没有标记'), '没有标记');
});

test('extractAffection 只认末尾锚定的标记', () => {
  const got = extractAffection('前面正文\n\n[AFF:+2|帮忙排查问题]');
  assert.equal(got.delta, 2);
  assert.equal(got.reason, '帮忙排查问题');
  assert.equal(got.stripped, '前面正文');

  assert.equal(extractAffection('[AFF:+2|开头] 后面还有正文'), null, '不在末尾的不算');
  assert.equal(extractAffection('没有标记'), null);
});

test('真实模型回复样本能正确解析出好感度并剥离', () => {
  const raw = loadTextFixture('model-response-affection.txt');
  const got = extractAffection(raw.trim());
  assert.equal(got.delta, 2);
  assert.equal(got.reason, '帮忙排查了半天配置问题，还挺耐心');
  assert.ok(!got.stripped.includes('[AFF:'));
  assert.ok(got.stripped.includes('改完重启一下就行'));
});

// ===== Middleware =====

function runMiddleware(mw, ctx) {
  return mw.process(ctx, async (c) => c);
}

function baseCtx(overrides = {}) {
  return {
    correlationId: 'c1',
    inbound: { userId: OTHER, messageType: 'group' },
    text: '正文',
    rawText: '正文',
    responseId: 'resp-1',
    triggerType: 'at',
    isFinalPass: true,
    suppressedSideEffects: [],
    ...overrides,
  };
}

test('middleware：主人不写好感度，但标记照样剥掉', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: true });
  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency: new IdempotencyStore(),
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: true } },
  });

  const out = await runMiddleware(
    mw,
    baseCtx({
      inbound: { userId: OWNER, messageType: 'group' },
      text: '好的 [AFF:+3|理由]',
      rawText: '好的 [AFF:+3|理由]',
    }),
  );

  assert.equal(out.text, '好的');
  assert.equal(store.getUser(OWNER), null, '主人不应产生好感度记录');
});

test('middleware：群聊无标记时走兜底 0.01', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: true });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const before = store.getUser(OTHER).affection;

  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency: new IdempotencyStore(),
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: true } },
  });
  await runMiddleware(mw, baseCtx());

  assert.equal(
    Math.round((store.getUser(OTHER).affection - before) * 100) / 100,
    FALLBACK_DELTA,
  );
});

test('middleware：主动接话不评估好感度', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: true });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const before = store.getUser(OTHER).affection;

  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency: new IdempotencyStore(),
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: true } },
  });
  await runMiddleware(mw, baseCtx({ triggerType: 'ai_decision' }));

  assert.equal(store.getUser(OTHER).affection, before);
});

test('middleware：同一个 responseId 只写一次（幂等）', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: true });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const before = store.getUser(OTHER).affection;

  const idempotency = new IdempotencyStore();
  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency,
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: true } },
  });

  const ctx = () => baseCtx({ text: '正文 [AFF:+3|理由]', rawText: '正文 [AFF:+3|理由]' });
  await runMiddleware(mw, ctx());
  await runMiddleware(mw, ctx());
  await runMiddleware(mw, ctx());

  assert.equal(store.getUser(OTHER).affection - before, 3, '重复处理只应生效一次');
});

test('middleware：非收尾轮只剥标记不写入', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: true });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const before = store.getUser(OTHER).affection;

  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency: new IdempotencyStore(),
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: true } },
  });

  const out = await runMiddleware(
    mw,
    baseCtx({ isFinalPass: false, text: '分段 [AFF:+3|理由]' }),
  );
  assert.equal(out.text, '分段');
  assert.equal(store.getUser(OTHER).affection, before);
});

test('middleware：sideEffectsEnabled=false 时记录抑制，不写入', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp, { persistEnabled: false });
  store.onUserMessage({ uid: OTHER, nickname: 'x' });
  const before = store.getUser(OTHER).affection;

  const mw = createAffectionMiddleware({
    store,
    identity: { ownerId: OWNER },
    idempotency: new IdempotencyStore(),
    logger: createTestLogger(),
    config: { reply: { sideEffectsEnabled: false } },
  });

  const out = await runMiddleware(
    mw,
    baseCtx({ text: '正文 [AFF:+3|理由]', rawText: '正文 [AFF:+3|理由]' }),
  );

  assert.equal(store.getUser(OTHER).affection, before);
  assert.equal(out.suppressedSideEffects.length, 1);
  assert.equal(out.suppressedSideEffects[0].kind, 'affection');
  assert.equal(out.suppressedSideEffects[0].delta, 3);
});

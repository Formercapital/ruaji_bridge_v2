import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeBatch, splitBySpeaker } from '../../src/orchestration/inbound-flow.js';
import { createInboundMessage } from '../../src/contracts/messages.js';

const DECISION = { route: 'direct', triggerType: 'at', reason: 'stub', providerId: null };

function makeItem(overrides = {}) {
  const inbound = createInboundMessage({
    correlationId: 'c1',
    messageId: 'm1',
    timestamp: 1787435231,
    userId: '10000001',
    groupId: '707423412',
    messageType: 'group',
    content: 'hello',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    ...overrides,
  });
  return { inbound, decision: DECISION };
}

test('P1 复现：两个不同用户的批次保留逐条身份，合并主体仍取最后一条', () => {
  const first = makeItem({
    messageId: 'm1',
    timestamp: 1787435200,
    userId: '2260757842',
    content: '瑞姬看看这个',
    sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' },
  });
  const last = makeItem({
    messageId: 'm2',
    timestamp: 1787435231,
    userId: '3382710099',
    content: '对，就是这个',
    sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
  });

  const { inbound, decision } = mergeBatch([first, last]);

  // 逐条身份：每条的 messageId/timestamp/userId/displayName/content 一一对应
  assert.ok(Array.isArray(inbound.extensions.batch), '合并消息应带 extensions.batch');
  assert.equal(inbound.extensions.batch.length, 2);
  assert.deepEqual(inbound.extensions.batch[0], {
    messageId: 'm1',
    timestamp: 1787435200,
    userId: '2260757842',
    displayName: 'qqqq819_01',
    content: '瑞姬看看这个',
  });
  assert.deepEqual(inbound.extensions.batch[1], {
    messageId: 'm2',
    timestamp: 1787435231,
    userId: '3382710099',
    displayName: '三²哒锅酱',
    content: '对，就是这个',
  });

  // 显式锁定既有合并语义：身份字段取最后一条，content 换行拼接
  assert.equal(inbound.userId, '3382710099');
  assert.equal(inbound.sender.displayName, '三²哒锅酱');
  assert.equal(inbound.messageId, 'm2');
  assert.equal(inbound.content, '瑞姬看看这个\n对，就是这个');
  assert.equal(decision, last.decision, '同强度（都是 direct）时裁决取较新的那条');
});

test('单条批次原样返回，不加 batch 字段', () => {
  const single = makeItem({ messageId: 'only' });
  const merged = mergeBatch([single]);
  assert.equal(merged, single, '单条批次必须原样返回（同一对象）');
  assert.equal(merged.inbound.extensions.batch, undefined, '单条不该有 batch 字段');
});

test('同一用户拆条两条：batch 长度 2、userId 相同', () => {
  const a = makeItem({ messageId: 'a', timestamp: 1787435200, content: '第一句' });
  const b = makeItem({ messageId: 'b', timestamp: 1787435210, content: '第二句' });
  const { inbound } = mergeBatch([a, b]);

  assert.equal(inbound.extensions.batch.length, 2);
  assert.equal(inbound.extensions.batch[0].userId, inbound.extensions.batch[1].userId);
  assert.equal(inbound.extensions.batch[0].content, '第一句');
  assert.equal(inbound.extensions.batch[1].content, '第二句');
  assert.equal(inbound.content, '第一句\n第二句');
});

// ===== 裁决取批次最强（direct > auto）=====

const AUTO_DECISION = { route: 'auto', triggerType: 'ai_decision', reason: 'stub_auto', providerId: null };

test('direct 与 auto 混批：裁决取 direct，不被末条的 auto 通吃', () => {
  // 末条通吃会把被 @ 的人当"主动插话"回复：不 @ 回、不评好感、systemText 走主人同款分支
  const atMe = { ...makeItem({ messageId: 'm1', content: '@瑞姬 帮我看看' }), decision: DECISION };
  const chatter = { ...makeItem({ messageId: 'm2', content: '群友随口一句' }), decision: AUTO_DECISION };

  const { decision } = mergeBatch([atMe, chatter]);
  assert.equal(decision, DECISION, '批次里有 direct 就必须按 direct 回复');
  assert.equal(decision.triggerType, 'at');
});

test('全 auto 批次：裁决取最后一条', () => {
  const first = { ...makeItem({ messageId: 'm1' }), decision: { ...AUTO_DECISION, reason: 'older' } };
  const last = { ...makeItem({ messageId: 'm2' }), decision: AUTO_DECISION };

  assert.equal(mergeBatch([first, last]).decision, AUTO_DECISION);
});

test('多条 direct：取较新的那条 direct（auto 夹在中间不影响）', () => {
  const older = { ...makeItem({ messageId: 'm1' }), decision: { ...DECISION, reason: 'older_direct' } };
  const middle = { ...makeItem({ messageId: 'm2' }), decision: AUTO_DECISION };
  const newer = { ...makeItem({ messageId: 'm3' }), decision: { ...DECISION, reason: 'newer_direct' } };

  assert.equal(mergeBatch([older, middle, newer]).decision.reason, 'newer_direct');
});

// ===== 只合并同一个人：跨用户一律拆轮（P1 的正解）=====

const A = { userId: '2260757842', sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' } };
const B = { userId: '3382710099', sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' } };

test('同一个人的连续多条：整组合并，队列清空', () => {
  const items = [
    makeItem({ ...A, messageId: 'a1', content: '第一句' }),
    makeItem({ ...A, messageId: 'a2', content: '第二句' }),
  ];
  const { batch, rest } = splitBySpeaker(items);

  assert.equal(batch.length, 2);
  assert.equal(rest.length, 0);
  assert.equal(mergeBatch(batch).inbound.content, '第一句\n第二句');
});

test('P1 正解：两个人排在一起时只答先到的那个，另一个原序留队列', () => {
  const first = makeItem({ ...A, messageId: 'a1', content: '早晚吃撑圆球大肥鼠' });
  const second = makeItem({ ...B, messageId: 'b1', content: '喂你松果巧克力恰巴塔' });

  const { batch, rest } = splitBySpeaker([first, second]);

  assert.deepEqual(batch, [first], '只合并先到那人的消息');
  assert.deepEqual(rest, [second], '另一个人原序留在队列里等下一轮');
  // 合并结果的身份必须还是先到的那个人，不能被后到的顶掉
  const { inbound } = mergeBatch(batch);
  assert.equal(inbound.userId, '2260757842');
  assert.equal(inbound.content, '早晚吃撑圆球大肥鼠');
});

test('交错排队 A,B,A：取锚定用户的全部消息，不是只取连续的一段', () => {
  const a1 = makeItem({ ...A, messageId: 'a1', content: 'A 第一句' });
  const b1 = makeItem({ ...B, messageId: 'b1', content: 'B 插一句' });
  const a2 = makeItem({ ...A, messageId: 'a2', content: 'A 第二句' });

  const { batch, rest } = splitBySpeaker([a1, b1, a2]);

  assert.deepEqual(batch, [a1, a2], 'A 的两条一次答完，少一次模型调用');
  assert.deepEqual(rest, [b1]);
  assert.equal(mergeBatch(batch).inbound.content, 'A 第一句\nA 第二句');
});

test('队列里有主人：先答主人，打断特权不被先到的群友挤掉', () => {
  const groupmate = makeItem({ ...A, messageId: 'a1', content: '群友先排上了' });
  const owner = makeItem({
    userId: '10000001',
    messageId: 'o1',
    content: '等等，先回我',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    flags: { isOwner: true, isAtBot: true },
  });

  const { batch, rest } = splitBySpeaker([groupmate, owner]);

  assert.deepEqual(batch, [owner], '主人 abort 掉在途生成之后，这一轮必须回主人');
  assert.deepEqual(rest, [groupmate]);
});

test('单条排队：原样成批，不进 requeue', () => {
  const only = makeItem({ ...A, messageId: 'a1' });
  const { batch, rest } = splitBySpeaker([only]);
  assert.deepEqual(batch, [only]);
  assert.equal(rest.length, 0);
});

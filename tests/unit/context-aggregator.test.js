import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextAggregator, mergeContextLines } from '../../src/core/context-aggregator.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { createContextBlock, coerceContextBlocks, CONTEXT_SCOPES } from '../../src/contracts/context-block.js';
import { createTestLogger } from '../helpers.js';

function makeAggregator(opts = {}) {
  const logger = createTestLogger();
  const capabilityBus = opts.capabilityBus ?? new CapabilityBus({ logger });
  return new ContextAggregator({
    capabilityBus,
    logger,
    totalCharacterBudget: opts.total ?? 12000,
    perSourceCharacterBudget: opts.perSource ?? 4000,
  });
}

test('coerceContextBlocks 接受字符串、数组与 { blocks | context }', () => {
  assert.equal(coerceContextBlocks('文本').length, 1);
  assert.equal(coerceContextBlocks(['a', 'b']).length, 2);
  assert.equal(coerceContextBlocks({ context: '内容' }).length, 1);
  assert.equal(coerceContextBlocks({ blocks: [{ text: 'x' }] }).length, 1);
  assert.equal(coerceContextBlocks(null).length, 0);
  assert.equal(coerceContextBlocks('   ').length, 0, '空白丢弃');
  assert.equal(coerceContextBlocks({ context: '' }).length, 0);
});

test('空块被丢弃', () => {
  const agg = makeAggregator();
  const { blocks } = agg._reduce(
    [
      createContextBlock({ source: 'a', text: '有内容' }),
      createContextBlock({ source: 'b', text: '   ' }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'a');
});

test('按作用域过滤', () => {
  const agg = makeAggregator();
  const { blocks } = agg._reduce(
    [
      createContextBlock({ source: 'g', text: '群专用', scope: CONTEXT_SCOPES.GROUP }),
      createContextBlock({ source: 'p', text: '私聊专用', scope: CONTEXT_SCOPES.PRIVATE }),
      createContextBlock({ source: 'a', text: '通用' }),
    ],
    CONTEXT_SCOPES.GROUP,
  );
  assert.deepEqual(blocks.map((b) => b.source).sort(), ['a', 'g']);
});

test('同 dedupeKey 只留优先级最高的（GCP 上下文 vs 本地滑窗）', () => {
  const agg = makeAggregator();
  const { blocks, dropped } = agg._reduce(
    [
      createContextBlock({ source: 'local-window', priority: 60, text: '本地滑窗', dedupeKey: 'recent' }),
      createContextBlock({ source: 'group-chat-plus', priority: 90, text: 'GCP 上下文', dedupeKey: 'recent' }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'group-chat-plus');
  assert.ok(dropped.some((d) => d.reason === 'deduped'));
});

test('同来源多块不去重：Favour Ultra 规则块 + 动态数据块都要活下来', () => {
  // 复现线上故障：统一宿主 favour_ultra 插件的 on_llm_request 产出两块
  // （system_prompt 静态规则 + extra_parts 动态数据），都不带 dedupeKey。
  // 旧逻辑按 source 兜底去重，<FavourContext> 每轮都被吞，模型只看到
  // 评分规则却不知道当前好感度与等级。
  const agg = makeAggregator();
  const { blocks, dropped } = agg._reduce(
    [
      createContextBlock({ source: 'favour_ultra', priority: 90, text: '<FavorabilityPlugin>静态规则</FavorabilityPlugin>' }),
      createContextBlock({ source: 'favour_ultra', priority: 90, text: '<FavourContext>动态数据</FavourContext>' }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks.length, 2, '同来源的两块都得保留');
  assert.ok(blocks.some((b) => b.text.includes('静态规则')));
  assert.ok(blocks.some((b) => b.text.includes('动态数据')));
  assert.equal(dropped.filter((d) => d.reason === 'deduped').length, 0);
});

test('显式 dedupeKey 高优先级替换后仍占首个出现位置', () => {
  const agg = makeAggregator();
  const { blocks } = agg._reduce(
    [
      createContextBlock({ source: 'local-window', priority: 60, text: '滑窗', dedupeKey: 'recent' }),
      createContextBlock({ source: 'gcp', priority: 90, text: '远程', dedupeKey: 'recent' }),
      createContextBlock({ source: 'other', priority: 80, text: '其他' }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.deepEqual(blocks.map((b) => b.source), ['gcp', 'other']);
});

test('按 priority 降序排列', () => {
  const agg = makeAggregator();
  const { blocks } = agg._reduce(
    [
      createContextBlock({ source: 'low', priority: 10, text: 'L' }),
      createContextBlock({ source: 'high', priority: 90, text: 'H' }),
      createContextBlock({ source: 'mid', priority: 50, text: 'M' }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.deepEqual(blocks.map((b) => b.source), ['high', 'mid', 'low']);
});

test('每来源预算：超长块被截断并记录原因', () => {
  const agg = makeAggregator({ perSource: 100 });
  const { blocks, dropped } = agg._reduce(
    [createContextBlock({ source: 'big', text: 'x'.repeat(500) })],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks[0].text.length, 100);
  assert.ok(blocks[0].truncatedReason.includes('per-source budget'));
  assert.ok(dropped.some((d) => d.reason.startsWith('per-source-truncated')));
});

test('budgetHint 小于全局每来源预算时以 hint 为准', () => {
  const agg = makeAggregator({ perSource: 1000 });
  const { blocks } = agg._reduce(
    [createContextBlock({ source: 'a', text: 'x'.repeat(500), budgetHint: 50 })],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks[0].text.length, 50);
});

test('全局预算：从低优先级开始丢，高优先级块保持完整', () => {
  const agg = makeAggregator({ total: 250, perSource: 1000 });
  const { blocks, dropped } = agg._reduce(
    [
      createContextBlock({ source: 'high', priority: 90, text: 'H'.repeat(200) }),
      createContextBlock({ source: 'low', priority: 10, text: 'L'.repeat(200) }),
    ],
    CONTEXT_SCOPES.ANY,
  );

  const high = blocks.find((b) => b.source === 'high');
  assert.equal(high.text.length, 200, '高优先级块必须完整');
  assert.ok(dropped.some((d) => d.source === 'low'));
});

test('剩余预算太小时整块丢弃而不是留个零头', () => {
  const agg = makeAggregator({ total: 210, perSource: 1000 });
  const { blocks } = agg._reduce(
    [
      createContextBlock({ source: 'high', priority: 90, text: 'H'.repeat(200) }),
      createContextBlock({ source: 'low', priority: 10, text: 'L'.repeat(200) }),
    ],
    CONTEXT_SCOPES.ANY,
  );
  assert.equal(blocks.length, 1);
});

test('渲染结果按顺序换行拼接', () => {
  const agg = makeAggregator();
  assert.equal(
    agg.render([
      createContextBlock({ source: 'a', text: '第一' }),
      createContextBlock({ source: 'b', text: '第二' }),
    ]),
    '第一\n第二',
  );
});

test('远程 Provider 失败时其结果被丢弃，其余照常聚合', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });

  capabilityBus.register({
    id: 'good',
    capability: 'context.enrich',
    priority: 90,
    timeoutMs: 100,
    invoke: async () => ({ context: 'GCP 给的上下文' }),
  });
  capabilityBus.register({
    id: 'bad',
    capability: 'context.enrich',
    priority: 80,
    timeoutMs: 100,
    invoke: async () => { throw new Error('挂了'); },
  });

  const agg = makeAggregator({ capabilityBus });
  const { blocks, stats } = await agg.aggregate({}, {});

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'good');
  assert.equal(stats.blocksRaw, 1);
});

test('本地 Provider 与远程 Provider 一起参与聚合', async () => {
  const logger = createTestLogger();
  const capabilityBus = new CapabilityBus({ logger });
  capabilityBus.register({
    id: 'remote',
    capability: 'context.enrich',
    priority: 90,
    timeoutMs: 100,
    invoke: async () => 'REMOTE',
  });

  const agg = makeAggregator({ capabilityBus });
  agg.registerLocal({ id: 'local', priority: 60, collect: () => 'LOCAL' });

  const { text } = await agg.aggregate({}, {});
  assert.equal(text, 'REMOTE\nLOCAL');
});

test('本地 Provider 抛异常不影响其他来源', async () => {
  const agg = makeAggregator();
  agg.registerLocal({ id: 'boom', priority: 90, collect: () => { throw new Error('炸了'); } });
  agg.registerLocal({ id: 'fine', priority: 50, collect: () => '正常内容' });

  const { text } = await agg.aggregate({}, {});
  assert.equal(text, '正常内容');
});

test('mergeContextLines 按行去重', () => {
  assert.equal(
    mergeContextLines('a\nb\n', 'b\nc'),
    'a\nb\nc',
  );
  assert.equal(mergeContextLines('', null, undefined), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { CAPABILITIES } from '../../src/contracts/capabilities.js';
import { renderSystemText, renderUserContent } from '../../src/orchestration/prompt-renderer.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { createTestLogger } from '../helpers.js';

test('LivingMemory 动态记忆与 GCP 群滑窗端到端注入验证', async () => {
  const capabilityBus = new CapabilityBus({ logger: createTestLogger() });
  const aggregator = new ContextAggregator({
    capabilityBus,
    logger: createTestLogger(),
  });

  // 模拟本地滑窗 local-window（priority: 60, dedupeKey: 'recent-group-context'）
  aggregator.registerLocal({
    id: 'local-window',
    priority: 60,
    collect: () => [
      {
        source: 'local-window',
        priority: 60,
        text: '[12:50:12] changlusss: 晚上吃啥\n[12:51:05] 小九: 随便',
        dedupeKey: 'recent-group-context',
        metadata: { slot: 'recent' },
      },
    ],
  });

  // 模拟统一宿主 /api/v1/context/enrich 返回的复合 blocks（GCP priority: 90）
  capabilityBus.register({
    id: 'unified-host',
    capability: CAPABILITIES.CONTEXT_ENRICH,
    priority: 90,
    invoke: async (input) => ({
      blocks: [
        {
          source: 'living_memory',
          kind: 'extra_parts',
          content: '<RAG-Faiss-Memory>\n记忆 #1: ruaji 喜欢喝凤凰单丛乌龙茶\n</RAG-Faiss-Memory>',
          detail: { slot: 'extra' },
        },
        {
          source: 'self_learning',
          kind: 'extra_parts',
          content: '[黑话解释] 鼠蛋: 指1-3岁的鼠族幼崽',
          detail: { slot: 'slang' },
        },
        {
          source: 'group_chat_plus',
          kind: 'contexts',
          content: '[时间:2026-08-24 周一 12:50:12] changlusss(ID:123): 晚上吃啥\n[时间:2026-08-24 周一 12:51:05] 小九(ID:456): 随便',
          detail: { slot: 'recent', dedupeKey: 'recent-group-context' },
        },
      ],
    }),
  });

  const normalizer = new InboundNormalizer({
    identity: { ownerId: '10000001', robotId: '398276230', botName: '瑞姬' },
    logger: createTestLogger(),
  });

  const { message: inbound } = await normalizer.normalize({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1001,
    group_id: 1076958977,
    user_id: 10000001,
    sender: { user_id: 10000001, nickname: 'ruaji', card: '' },
    message: [{ type: 'text', data: { text: '你还记得我喜欢喝什么吗' } }],
    raw_message: '你还记得我喜欢喝什么吗',
    time: 1787530000,
    self_id: 398276230,
  });

  const { blocks } = await aggregator.aggregate(
    {
      correlationId: 'test-c1',
      sessionId: inbound.sessionId,
      messageId: inbound.messageId,
      groupId: inbound.groupId,
      userId: inbound.userId,
      text: inbound.text,
      messageType: inbound.messageType,
    },
    { correlationId: 'test-c1', sessionId: inbound.sessionId, scope: 'group' },
  );

  // 1. 验证 3 个块全部保留，未被误杀
  assert.equal(blocks.length, 3, '应聚合出 3 个独立块');
  const sources = blocks.map((b) => b.source);
  assert.ok(sources.includes('living_memory'), '必须包含 living_memory 记忆块');
  assert.ok(sources.includes('self_learning'), '必须包含 self_learning 块');
  assert.ok(sources.includes('group_chat_plus'), '必须包含 group_chat_plus 块');

  // 2. 验证 renderSystemText 包含 LivingMemory 记忆和黑话（普通群友视角）
  const systemText = renderSystemText({
    inbound,
    contextBlocks: blocks,
    triggerType: 'at',
    affectionContext: { affection: 50, level: '熟识' },
    identity: { ownerId: '1000000000' },
  });
  assert.ok(systemText.includes('凤凰单丛乌龙茶'), 'systemText 必须包含 LivingMemory 动态召回的记忆');
  assert.ok(systemText.includes('鼠蛋: 指1-3岁的鼠族幼崽'), 'systemText 必须包含黑话');
  assert.ok(systemText.includes('[用户: ruaji(10000001) | 群1076958977]'), 'systemText 包含用户身份头');

  // 3. 验证 renderUserContent 包含 GCP 群聊滑窗上下文
  const userContent = renderUserContent({
    inbound,
    contextBlocks: blocks,
    identity: { ownerId: '10000001' },
  });
  assert.ok(userContent.includes('[最近群聊消息]'), 'userContent 必须包含群聊历史上下文标记');
  assert.ok(userContent.includes('changlusss(ID:123): 晚上吃啥'), 'userContent 必须包含 GCP 滑窗消息');
});

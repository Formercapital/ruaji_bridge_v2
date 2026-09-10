import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { CAPABILITIES } from '../../src/contracts/capabilities.js';
import { createResultDecorateMiddleware } from '../../src/middleware/result-decorate.js';
import { createTransformContext } from '../../src/middleware/index.js';

test('result-decorate 中间件：正确解包 CapabilityBus 信封并更新文本', async () => {
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'test-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async (input) => ({ text: `${input.text}【已修饰】` }),
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({ text: '原始文本', correlationId: 'c1', sessionId: 's1' });

  let nextCalled = false;
  await mw.process(ctx, (c) => {
    nextCalled = true;
    return c;
  });

  assert.equal(nextCalled, true);
  assert.equal(ctx.text, '原始文本【已修饰】');
  assert.equal(ctx.cancelled, false);
});

test('result-decorate 中间件：支持裸字符串返回', async () => {
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'str-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async () => '纯字符串修饰结果',
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({ text: '原始', correlationId: 'c2', sessionId: 's2' });

  await mw.process(ctx, (c) => c);
  assert.equal(ctx.text, '纯字符串修饰结果');
});

test('result-decorate 中间件：支持 blocked: true 显式拦截', async () => {
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'block-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async () => ({ blocked: true, reason: 'sensitive_word' }),
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({ text: '含敏感词的文本', correlationId: 'c3', sessionId: 's3' });

  await mw.process(ctx, (c) => c);
  assert.equal(ctx.cancelled, true);
  assert.equal(ctx.text, '');
});

test('result-decorate 中间件：Provider 报错平滑降级，不抛出异常打断流水线', async () => {
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'error-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async () => {
      throw new Error('remote timeout');
    },
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({ text: '原始保底文本', correlationId: 'c4', sessionId: 's4' });

  let nextCalled = false;
  await mw.process(ctx, (c) => {
    nextCalled = true;
    return c;
  });

  assert.equal(nextCalled, true);
  assert.equal(ctx.text, '原始保底文本');
  assert.equal(ctx.cancelled, false);
});

test('result-decorate 中间件：收尾轮空文本也必须调用宿主（Favour 暂存消费合同）', async () => {
  const calls = [];
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'settle-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async (input) => {
      calls.push(input);
      return { text: '已消费暂存' };
    },
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const inbound = { messageId: 'msg-100', userId: '1001', groupId: '123', sessionId: 'qq:group:123', messageType: 'group', text: '你好' };
  const ctx = createTransformContext({
    text: '',
    rawText: '今天也辛苦啦[好感度上升:5]',
    isFinalPass: true,
    correlationId: 'c5',
    sessionId: 'qq:group:123',
    inbound,
  });

  let nextCalled = false;
  await mw.process(ctx, (c) => {
    nextCalled = true;
    return c;
  });

  assert.equal(calls.length, 1, '收尾轮必须恰好调用一次宿主 decorate');
  assert.equal(calls[0].rawText, '今天也辛苦啦[好感度上升:5]', '收尾轮要带完整原文，宿主侧用它构造 OnDecoratingResultEvent');
  assert.equal(calls[0].inbound.messageId, 'msg-100', '收尾轮消息键必须与 llm.response 暂存键一致');
  assert.equal(nextCalled, true);
  assert.equal(ctx.cancelled, false);
});

test('result-decorate 中间件：非收尾轮空文本仍然跳过（不打无意义的空请求）', async () => {
  let invokeCount = 0;
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'skip-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async () => {
      invokeCount += 1;
      return { text: '不该出现' };
    },
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({ text: '', isFinalPass: false, correlationId: 'c6', sessionId: 's6' });

  let nextCalled = false;
  await mw.process(ctx, (c) => {
    nextCalled = true;
    return c;
  });

  assert.equal(invokeCount, 0, '非收尾轮空文本不应调用宿主');
  assert.equal(nextCalled, true);
});

test('result-decorate 中间件：收尾轮宿主报错平滑降级，不影响后续', async () => {
  const capabilityBus = new CapabilityBus();
  capabilityBus.register({
    id: 'final-error-provider',
    capability: CAPABILITIES.RESULT_DECORATE,
    invoke: async () => {
      throw new Error('host down');
    },
  });

  const mw = createResultDecorateMiddleware({ capabilityBus });
  const ctx = createTransformContext({
    text: '',
    rawText: '完整原文',
    isFinalPass: true,
    correlationId: 'c7',
    sessionId: 's7',
  });

  let nextCalled = false;
  await mw.process(ctx, (c) => {
    nextCalled = true;
    return c;
  });

  assert.equal(nextCalled, true, '收尾轮宿主失败必须降级放行');
  assert.equal(ctx.cancelled, false);
});

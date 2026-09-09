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

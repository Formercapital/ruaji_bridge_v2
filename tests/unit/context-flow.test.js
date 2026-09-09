import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { MESSAGE_TYPES } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

/**
 * 只捕获 registerLocal：_registerLocalProviders 在构造期只碰 this.aggregator，
 * 所以不必造 sessionStore / affectionStore 那一整套依赖。
 */
function collectProviders() {
  const providers = new Map();
  const aggregator = { registerLocal: (p) => providers.set(p.id, p) };
  new ContextFlow({ aggregator, config: {}, logger: createTestLogger() });
  return providers;
}

test('本地 provider 注册：meme-rules 已随 agent 侧表情链路移除', () => {
  const providers = collectProviders();
  assert.equal(providers.has('meme-rules'), false, 'meme-rules provider 不应再注册');
  for (const id of ['local-window', 'local-media', 'shadow-fewshot']) {
    assert.ok(providers.has(id), `${id} provider 应保留`);
  }
});

test('shadow-fewshot 以 priority 76 注册，enabled 且有语料时产出 slot=extra 块', async () => {
  const providers = new Map();
  const aggregator = { registerLocal: (p) => providers.set(p.id, p) };
  const shadowStore = {
    renderFewShotBlock: ({ groupId, targets, count }) => `[影子] ${groupId} ${targets.join(',')} x${count}`,
  };
  new ContextFlow({
    aggregator,
    shadowStore,
    config: { shadowLearn: { enabled: true, targets: ['111'], injectCount: 8 } },
    logger: createTestLogger(),
  });

  const provider = providers.get('shadow-fewshot');
  assert.ok(provider, 'shadow-fewshot provider 未注册');
  assert.equal(provider.priority, 76);

  const blocks = await provider.collect({ messageType: MESSAGE_TYPES.GROUP, groupId: '666' }, {});
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'shadow-fewshot');
  assert.equal(blocks[0].metadata.slot, 'extra');
  assert.ok(blocks[0].text.includes('666'));
});

test('shadow-fewshot：未启用/无 targets/无语料/私聊都安全降级为空', async () => {
  const build = (config, store) => {
    const providers = new Map();
    const aggregator = { registerLocal: (p) => providers.set(p.id, p) };
    new ContextFlow({ aggregator, shadowStore: store, config, logger: createTestLogger() });
    return providers.get('shadow-fewshot');
  };
  const store = { renderFewShotBlock: () => '[影子] 有语料' };
  const groupInput = { messageType: MESSAGE_TYPES.GROUP, groupId: '666' };

  assert.deepEqual(await build({ shadowLearn: { enabled: false, targets: ['111'] } }, store).collect(groupInput, {}), []);
  assert.deepEqual(await build({ shadowLearn: { enabled: true, targets: [] } }, store).collect(groupInput, {}), []);
  assert.deepEqual(await build({ shadowLearn: { enabled: true, targets: ['111'] } }, null).collect(groupInput, {}), []);
  assert.deepEqual(
    await build({ shadowLearn: { enabled: true, targets: ['111'] } }, store).collect(
      { messageType: MESSAGE_TYPES.PRIVATE, groupId: null }, {},
    ),
    [],
  );
  // 语料为空时 renderFewShotBlock 返回空串，也不产出块
  assert.deepEqual(
    await build({ shadowLearn: { enabled: true, targets: ['111'] } }, { renderFewShotBlock: () => '' }).collect(groupInput, {}),
    [],
  );
});

test('recordToWindow：targets 命中的群友发言记入语料，未命中不记（enabled 不影响采集）', () => {
  const providers = new Map();
  const aggregator = { registerLocal: (p) => providers.set(p.id, p) };
  const recorded = [];
  const flow = new ContextFlow({
    aggregator,
    sessionStore: { recordContext() {} },
    shadowStore: { recordMessage: (...args) => recorded.push(args) },
    config: { identity: { robotId: '999' }, shadowLearn: { enabled: false, targets: ['111'] } },
    logger: createTestLogger(),
  });
  const base = {
    messageType: MESSAGE_TYPES.GROUP,
    sessionId: 'qq:group:666',
    messageId: 'm1',
    groupId: '666',
    sender: { displayName: 'Alice' },
    flags: {},
    extensions: {},
  };

  flow.recordToWindow({ ...base, userId: '111', text: '今天好热啊' });
  flow.recordToWindow({ ...base, userId: '222', text: '别记我' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][0], '111');
  assert.equal(recorded[0][3], '今天好热啊');
});

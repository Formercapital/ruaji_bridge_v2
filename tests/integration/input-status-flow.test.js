import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelResponse } from '../../src/contracts/messages.js';
import { Lifecycle } from '../../src/app/lifecycle.js';
import { buildTestContainer, loadFixture, flush } from '../helpers.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t, routes = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const container = buildTestContainer({
    replies: ['处理好了。'],
    configOverrides: {
      mode: 'live',
      reply: { sendEnabled: true, sideEffectsEnabled: false },
      fastAck: { enabled: false },
      typingDelay: { enabled: false },
      meme: { matcherEnabled: false },
      web: { enabled: false },
    },
    routes: {
      'POST /set_input_status': () => ({ body: { status: 'ok', retcode: 0, data: null } }),
      'POST /send_private_msg': () => ({ body: { status: 'ok', retcode: 0, data: { message_id: 1 } } }),
      'POST /send_group_msg': () => ({ body: { status: 'ok', retcode: 0, data: { message_id: 2 } } }),
      ...routes,
    },
  });
  t.after(() => {
    container.inputStatus.stop();
    container.sessionStore.clearAllTimers();
    container.sender.stop();
    container.cleanup();
  });
  return container;
}

// 真实入站门禁、裁决和合并流程，只把防抖的等待改为显式推进。
async function receive(container, fixtureName = 'private-message') {
  const fixture = loadFixture(fixtureName);
  await container.inboundFlow.handleEvent(fixture.event);
  container.sessionStore.clearAllTimers();
  return { run: container.inboundFlow._runGeneration(fixture.expect.executionKey) };
}

test('私聊提示覆盖上下文、模型和实际投递，最后一条发完后停止', async (t) => {
  const context = deferred();
  const model = deferred();
  const delivery = deferred();
  const stages = [];
  const c = setup(t, {
    'POST /send_private_msg': async () => {
      stages.push('send');
      await delivery.promise;
      return { body: { status: 'ok', retcode: 0, data: { message_id: 1 } } };
    },
  });
  c.contextFlow.collect = async () => {
    stages.push('context');
    await context.promise;
    return { blocks: [] };
  };
  c.modelAdapter.generate = async () => {
    stages.push('model');
    await model.promise;
    return createModelResponse({ rawText: '处理好了。' });
  };

  const { run } = await receive(c);
  await flush();
  assert.deepEqual(stages, ['context']);
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 1);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 2);

  context.resolve();
  await flush();
  assert.deepEqual(stages, ['context', 'model']);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 3);

  model.resolve();
  await flush();
  assert.deepEqual(stages, ['context', 'model', 'send']);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 4, '生成结束但投递未完成时仍应刷新');

  delivery.resolve();
  await flush();
  t.mock.timers.tick(300);
  await run;
  const lastCount = c.fetchStub.callsTo('/set_input_status').length;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, lastCount);
  assert.equal(c.fetchStub.callsTo('/send_private_msg').length, 1);
});

for (const failure of ['context', 'model', 'intercept']) {
  test(`私聊 ${failure} 提前结束也会清理输入提示`, async (t) => {
    const c = setup(t);
    if (failure === 'context') {
      c.contextFlow.collect = async () => { throw new Error('context failed'); };
    } else if (failure === 'model') {
      c.modelAdapter.generate = async () => { throw new Error('model failed'); };
    } else {
      c.contextFlow.collect = async () => ({ blocks: [], intercepted: true });
    }
    const { run } = await receive(c);
    await run;
    await flush();
    assert.equal(c.fetchStub.callsTo('/set_input_status').length, 1);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(c.fetchStub.callsTo('/set_input_status').length, 1);
  });
}

test('输入状态接口不支持或卡住都不妨碍私聊正文投递', async (t) => {
  for (const slow of [false, true]) {
    await t.test(slow ? '接口卡住' : '业务失败', async (sub) => {
      const statusRequest = deferred();
      const c = setup(sub, {
        'POST /set_input_status': async () => {
          if (slow) await statusRequest.promise;
          return { body: { status: 'failed', retcode: 1200, message: 'unsupported' } };
        },
      });
      const { run } = await receive(c);
      await flush();
      sub.mock.timers.tick(300);
      await run;
      assert.equal(c.fetchStub.callsTo('/send_private_msg').length, 1);
      statusRequest.resolve();
      await flush();
      sub.mock.timers.tick(5000);
      await flush();
      assert.equal(c.fetchStub.callsTo('/set_input_status').length, 1);
    });
  }
});

test('私聊白名单门禁在输入提示之前，群聊回复也不显示私聊状态', async (t) => {
  const c = setup(t);
  await c.inboundFlow.handleEvent({ ...loadFixture('private-message').event, user_id: 99999999 });
  assert.equal(c.fetchStub.calls.length, 0);
  const { run } = await receive(c, 'group-at-bot');
  await flush();
  t.mock.timers.tick(300);
  await run;
  assert.equal(c.fetchStub.callsTo('/send_group_msg').length, 1);
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 0);
});

test('桥接停机同时关闭输入提示，不再产生定时请求', async (t) => {
  const c = setup(t);
  c.inputStatus.start({ messageType: 'private', userId: '10000001' });
  await flush();
  const lifecycle = new Lifecycle(c);
  lifecycle.started = true;
  await lifecycle.shutdown();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(c.fetchStub.callsTo('/set_input_status').length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { InputStatus } from '../../src/adapters/napcat/input-status.js';
import { createTestLogger, flush } from '../helpers.js';

const privateMessage = (userId = '10000001') => ({ messageType: 'private', userId });

function setup(t, request = async () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const config = { mode: 'live', reply: { sendEnabled: true }, napcat: { inputStatusEnabled: true } };
  const logger = createTestLogger();
  const indicator = new InputStatus({
    config,
    logger,
    napcatApi: { setInputStatus(userId) { calls.push(userId); return request(userId); } },
  });
  t.after(() => indicator.stop());
  return { indicator, calls, config, logger };
}

test('开始立即上报，长任务超过 120 秒仍刷新，完成后停止', async (t) => {
  const { indicator, calls } = setup(t);
  const finish = indicator.start(privateMessage());
  assert.deepEqual(calls, ['10000001']);
  await flush();
  t.mock.timers.tick(120500);
  await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 3);
  finish();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls.length, 3);
});

test('同一用户共用一个刷新循环，各轮独立清理，重复清理不影响后来者', async (t) => {
  const { indicator, calls } = setup(t);
  const finishFirst = indicator.start(privateMessage());
  const finishSecond = indicator.start(privateMessage());
  await flush();
  assert.equal(calls.length, 1);
  finishFirst();
  finishFirst();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 2);
  finishSecond();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 2);
});

test('打断立即停止，旧轮收尾不能停掉刚开始的新轮', async (t) => {
  const { indicator, calls } = setup(t);
  const controller = new AbortController();
  const finishOld = indicator.start(privateMessage(), { signal: controller.signal });
  await flush();
  controller.abort();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 1);
  const finishNew = indicator.start(privateMessage());
  finishOld();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 3);
  finishNew();
});

test('慢接口不产生并发请求，完成后的迟到响应不会重启刷新', async (t) => {
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const { indicator, calls } = setup(t, () => pending);
  const finish = indicator.start(privateMessage());
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(calls.length, 1);
  finish();
  resolveRequest();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls.length, 1);
});

test('旧轮的迟到失败不会清掉新轮的刷新循环', async (t) => {
  let rejectRequest;
  const pending = new Promise((_, reject) => { rejectRequest = reject; });
  let count = 0;
  const { indicator, calls } = setup(t, () => ++count === 1 ? pending : Promise.resolve());
  const finishOld = indicator.start(privateMessage());
  finishOld();
  const finishNew = indicator.start(privateMessage());
  rejectRequest(new Error('late failure'));
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 3);
  finishNew();
});

test('接口失败只记录一次并停止本轮刷新，不向调用者抛错', async (t) => {
  const { indicator, calls, logger } = setup(t, () => { throw new Error('unsupported'); });
  const finish = indicator.start(privateMessage());
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(logger.find('输入状态上报失败').length, 1);
  finish();
});

test('群聊、测试/影子模式、禁止发送、关闭开关和已打断任务不调用接口', async (t) => {
  const { indicator, calls, config } = setup(t);
  indicator.start({ messageType: 'group', userId: '10000001' })();
  indicator.start(privateMessage(''))();
  const controller = new AbortController();
  controller.abort();
  indicator.start(privateMessage(), { signal: controller.signal })();
  for (const mode of ['shadow', 'test']) {
    config.mode = mode;
    indicator.start(privateMessage())();
  }
  config.mode = 'live';
  config.reply.sendEnabled = false;
  indicator.start(privateMessage())();
  config.reply.sendEnabled = true;
  config.napcat.inputStatusEnabled = false;
  indicator.start(privateMessage())();
  await flush();
  assert.deepEqual(calls, []);
});

test('热关闭开关会停止当前刷新，重新开启后下一轮恢复', async (t) => {
  const { indicator, calls, config } = setup(t);
  const finishOld = indicator.start(privateMessage());
  await flush();
  config.napcat.inputStatusEnabled = false;
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 1);
  config.napcat.inputStatusEnabled = true;
  const finishNew = indicator.start(privateMessage());
  finishOld();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.length, 3);
  finishNew();
});

test('停机清理所有用户并阻止迟到任务再次开启提示', async (t) => {
  const { indicator, calls } = setup(t);
  indicator.start(privateMessage('10000001'));
  indicator.start(privateMessage('10000003'));
  await flush();
  indicator.stop();
  indicator.start(privateMessage('10000004'))();
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(calls, ['10000001', '10000003']);
});

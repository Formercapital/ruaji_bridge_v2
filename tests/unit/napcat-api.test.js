/**
 * tests/unit/napcat-api.test.js — OneBot 业务失败的可见性
 *
 * 守的是一条换协议端时才会咬人的边界：NapCat 与 LLBot 支持的 action 不是同一套，
 * 而缺失的动作走的是「HTTP 200 + retcode != 0」这条路。各 wrapper 都是
 * `data?.data ?? null`，不看 retcode 的话，不支持的动作会安静地退化成 null / []，
 * 现场只看得见"功能没生效"，看不见原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NapcatApi } from '../../src/adapters/napcat/napcat-api.js';
import { SendError } from '../../src/contracts/errors.js';
import { createTestLogger, createFetchStub } from '../helpers.js';

const HTTP_URL = 'http://127.0.0.1:3000';

function build(routes) {
  const logger = createTestLogger();
  const fetchImpl = createFetchStub(routes);
  const api = new NapcatApi({ httpUrl: HTTP_URL, accessToken: 'tok', sendTimeoutMs: 500, logger, fetchImpl });
  return { api, logger, fetchImpl };
}

const failures = (logger) => logger.find('业务失败');

test('协议端不支持该 action（retcode 非 0）时留下 warn，而不是安静地返回 null', async () => {
  const { api, logger } = build({
    '*': () => ({ status: 200, body: { status: 'failed', retcode: 1200, message: '不支持的动作' } }),
  });

  // 返回值语义保持不变：上层依赖 null，这里不能改成抛异常
  assert.equal(await api.voiceMsgToText('123'), null);

  const hits = failures(logger);
  assert.equal(hits.length, 1, 'retcode 非 0 必须留下痕迹');
  assert.equal(hits[0].retcode, 1200);
  assert.equal(hits[0].action, 'voice_msg_to_text');
  assert.equal(hits[0].message, '不支持的动作');
});

test('返回空数组的 wrapper 同样会报警（否则和"这个群真的没成员"分不开）', async () => {
  const { api, logger } = build({
    '*': () => ({ status: 200, body: { status: 'failed', retcode: 1200, wording: '接口不存在' } }),
  });

  assert.deepEqual(await api.getGroupMemberList('707423412'), []);
  const hits = failures(logger);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].message, '接口不存在', 'LLBot 用 wording 报错时也要带出来');
});

test('正常成功不产生噪音', async () => {
  const { api, logger } = build({
    '*': () => ({ status: 200, body: { status: 'ok', retcode: 0, data: { user_id: 398276230 } } }),
  });

  await api.getLoginInfo();
  assert.deepEqual(failures(logger), []);
});

test('status=async（OneBot v11 的"已受理"）不算失败', async () => {
  const { api, logger } = build({
    '*': () => ({ status: 200, body: { status: 'async', retcode: 1 } }),
  });

  await api.sendPoke({ groupId: '707423412', userId: '10000001' });
  assert.deepEqual(failures(logger), [], 'async 是受理成功，报警等于误报');
});

test('不带 OneBot 信封的扩展接口不被误判（download_file 等）', async () => {
  const { api, logger } = build({
    '*': () => ({ status: 200, body: { file: 'C:/cache/a.png' } }),
  });

  await api.downloadFile({ url: 'https://x/y.png', name: 'a.png' });
  assert.deepEqual(failures(logger), [], '没有 retcode/status 就无从判断，不能默认当失败');
});

test('sendMessage 的 "Timeout: NTEvent" 仍是成功，且不产生误导性 warn', async () => {
  const { api, logger } = build({
    'POST /send_group_msg': () => ({
      status: 200,
      body: { status: 'failed', retcode: 1200, message: 'Timeout: NTEvent' },
    }),
  });

  const res = await api.sendMessage({ isGroup: true, targetId: '707423412', message: '在' });
  assert.equal(res.status, 'nt_event_timeout', '消息其实已发出，只是回调确认超时');
  assert.deepEqual(failures(logger), [], '这条路径是显式建模的成功，报警会把人引到错方向');
});

test('sendMessage 真失败时照旧抛 SendError（warn 不替代抛异常）', async () => {
  const { api, logger } = build({
    'POST /send_group_msg': () => ({ status: 200, body: { status: 'failed', retcode: 1200, message: '群不存在' } }),
  });

  await assert.rejects(
    () => api.sendMessage({ isGroup: true, targetId: '1', message: '在' }),
    SendError,
  );
  assert.equal(failures(logger).length, 1, '抛异常之外仍然留一条带 retcode 的记录');
});

test('输入状态兼容 LLBot 的空 data 响应与 NapCat 响应，按共同协议发送输入事件', async () => {
  for (const data of [null, { result: 0, errMsg: '' }]) {
    const { api, fetchImpl, logger } = build({
      'POST /set_input_status': () => ({ body: { status: 'ok', retcode: 0, data } }),
    });
    await api.setInputStatus('10000001');
    assert.deepEqual(fetchImpl.calls[0].body, { user_id: 10000001, event_type: 1 });
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(failures(logger), []);
  }
});

test('输入状态的业务失败和 HTTP 失败必须反馈给刷新器，避免无效轮询', async () => {
  for (const response of [
    { body: { status: 'failed', retcode: 1200, message: '不支持的动作' } },
    { status: 404, body: { message: 'not found' } },
  ]) {
    const { api } = build({ 'POST /set_input_status': () => response });
    await assert.rejects(() => api.setInputStatus('10000001'), SendError);
  }
});

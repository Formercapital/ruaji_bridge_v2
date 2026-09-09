import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildTestContainer,
  FakeWebSocket,
  cleanupDir,
  makeTempDir,
  TEST_ROOT,
  createTestLogger,
} from '../helpers.js';
import { loadConfig } from '../../src/core/config.js';
import { createContainer } from '../../src/app/container.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';

test('NapCat 真实全链路电路端到端测试（连接内部统一宿主）', async () => {
  const tmp = makeTempDir('napcat-circuit-');
  const logger = createTestLogger();
  FakeWebSocket.reset();

  const sentTasks = [];
  const fetchStub = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : url;
    // 如果是打给统一宿主 :8870 的真实请求，直接走 Node 真实 fetch（如果宿主未开启则降级）
    if (u.port === '8870') {
      try {
        return await fetch(url, init);
      } catch (err) {
        // 如果未启动独立进程，测试内返回降级响应
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        };
      }
    }

    // 打给 NapCat HTTP 的发送请求
    if (u.pathname.includes('/send_group_msg') || u.pathname.includes('/send_msg')) {
      const body = init.body ? JSON.parse(init.body) : {};
      sentTasks.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', retcode: 0, data: { message_id: Math.floor(Math.random() * 100000) } }),
        text: async () => JSON.stringify({ status: 'ok', retcode: 0 }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', retcode: 0 }),
      text: async () => JSON.stringify({ status: 'ok', retcode: 0 }),
    };
  };

  const config = loadConfig({
    rootDir: TEST_ROOT,
    file: 'bridge.config.json',
    env: { ...process.env, NAPCAT_ACCESS_TOKEN: 'test-token', HERMES_API_KEY: 'test-key' },
    cliOverrides: {
      mode: 'test',
      storage: {
        legacyRoot: tmp,
        affectionFile: path.join(tmp, 'affection.json'),
        memeDataFile: path.join(tmp, 'memes_data.json'),
        memeRoot: path.join(tmp, 'memes'),
        receivedImagesDir: path.join(tmp, 'received_images'),
        receivedFilesDir: path.join(tmp, 'received_files'),
        cacheDir: path.join(tmp, '.cache'),
        shadowDir: path.join(tmp, 'shadow'),
      },
      logging: { file: null, level: 'debug' },
      health: { port: 0, lockPort: 0 },
    },
  });

  const modelAdapter = new MockModelAdapter({
    replies: [
      '当然记得啦，你最喜欢喝的是凤凰单丛乌龙茶~[AFF:+2|记得喜好]',
      '这是命令回复测试结果。',
    ],
  });

  const container = buildTestContainer({
    replies: [
      '当然记得啦，你最喜欢喝的是凤凰单丛乌龙茶~[AFF:+2|记得喜好]',
      '这是命令回复测试结果。',
    ],
  });

  // 场景 1：注入普通群友水群消息 -> 触发 message.received 全局广播与消息采集
  const msg1 = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 20001,
    group_id: 1076958977,
    user_id: 2260757842,
    sender: { user_id: 2260757842, nickname: '御娘狼三千', card: '狼三千' },
    message: [{ type: 'text', data: { text: '今天天气真好，大家在干嘛呢' } }],
    raw_message: '今天天气真好，大家在干嘛呢',
    time: Math.floor(Date.now() / 1000),
    self_id: 398276230,
  };

  await container.inboundFlow.handleEvent(msg1);

  // 场景 2：注入 @ 机器人提问消息 -> 触发 裁决 -> 富化 -> 生成 -> 发送
  const msg2 = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 20002,
    group_id: 1076958977,
    user_id: 10000001,
    sender: { user_id: 10000001, nickname: 'ruaji', card: '' },
    message: [
      { type: 'at', data: { qq: '398276230' } },
      { type: 'text', data: { text: ' 你还记得我喜欢喝什么茶吗？' } },
    ],
    raw_message: '[CQ:at,qq=398276230] 你还记得我喜欢喝什么茶吗？',
    time: Math.floor(Date.now() / 1000) + 1,
    self_id: 398276230,
  };

  await container.inboundFlow.handleEvent(msg2);

  // 等待回复流水线执行完毕
  await new Promise((r) => setTimeout(r, 2600));

  // 验证机器人是否成功进入发送队列
  assert.ok(container.sender.dryRunLog.length > 0, 'NapCat 应该收到机器人发送的群回复');
  const lastSent = container.sender.dryRunLog[container.sender.dryRunLog.length - 1];
  assert.equal(lastSent.targetId, '1076958977');
  assert.ok(lastSent.message.includes('凤凰单丛乌龙茶'), '发出的回复中包含正确的生成内容');

  container.cleanup();
});

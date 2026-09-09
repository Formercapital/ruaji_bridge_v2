import test from 'node:test';
import assert from 'node:assert/strict';
import { OneBotToolsExecutor, ONEBOT_TOOLS_MANIFEST } from '../../src/tools/onebot-tools.js';

test('OneBotToolsExecutor: 包含全部 21 个 OneBot 工具', () => {
  assert.equal(ONEBOT_TOOLS_MANIFEST.length, 21);
  const executor = new OneBotToolsExecutor();
  for (const item of ONEBOT_TOOLS_MANIFEST) {
    assert.equal(executor.isSupported(item.name), true);
    assert.ok(item.name);
    assert.ok(item.description);
    assert.ok(item.parameters);
  }
});

test('OneBotToolsExecutor: 缺少必填参数时如实报错', async () => {
  const executor = new OneBotToolsExecutor({ httpUrl: 'http://127.0.0.1:39999' });
  
  // list_group_files 缺 group_id
  const res1 = await executor.execute('list_group_files', {});
  assert.equal(res1.ok, false);
  assert.equal(res1.error, 'missing_group_id');

  // send_poke 缺 user_id
  const res2 = await executor.execute('send_poke', {});
  assert.equal(res2.ok, false);
  assert.equal(res2.error, 'missing_user_id');

  // get_message_detail 缺 message_id
  const res3 = await executor.execute('get_message_detail', {});
  assert.equal(res3.ok, false);
  assert.equal(res3.error, 'missing_message_id');
});

test('OneBotToolsExecutor: 支持网络断开/服务未就绪时友好返回', async () => {
  const executor = new OneBotToolsExecutor({ httpUrl: 'http://127.0.0.1:39999' });
  const res = await executor.execute('list_joined_groups', {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'onebot_unreachable');
});

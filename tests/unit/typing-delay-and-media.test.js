import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDelayMs,
  computeLogDelayMs,
  computeLinearDelayMs,
  createTypingDelayMiddleware,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
} from '../../src/middleware/typing-delay.js';
import { extractMediaFromResponse } from '../../src/middleware/media-extract.js';
import { makeTempDir, cleanupDir, createTestLogger } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';

// ===== 打字延迟 =====

test('第一条不等待', () => {
  assert.equal(computeDelayMs(0), 0);
});

test('延迟按上一条长度计算，钳制在 [800, 2500]', () => {
  // 逐字复刻 bridge.js:639 —— min(2500, max(800, 800 + floor(len/15*1000)))
  assert.equal(computeDelayMs(1), 866, '基础 800ms 之上再按字数累加');
  assert.ok(computeDelayMs(1) >= MIN_DELAY_MS, '再短的上一条也不低于 800ms');
  assert.equal(computeDelayMs(15), MIN_DELAY_MS + 1000);
  assert.equal(computeDelayMs(25), MIN_DELAY_MS + 1666);
  assert.equal(computeDelayMs(1000), MAX_DELAY_MS, '超长回复也不超过 2500ms');
  assert.ok(computeDelayMs(30) <= MAX_DELAY_MS);
});

test('对数拟人延时算法平滑增长并钳制在 [800, 2500]', () => {
  const d0 = computeDelayMs(0, 'log');
  assert.equal(d0, 0);

  const d5 = computeLogDelayMs(5);
  const d50 = computeLogDelayMs(50);
  const d500 = computeLogDelayMs(500);

  assert.ok(d5 >= MIN_DELAY_MS && d5 <= MAX_DELAY_MS);
  assert.ok(d50 >= d5, '字数多时延迟递增');
  assert.ok(d500 <= MAX_DELAY_MS, '超长字数不超过上限');
});

test('测试模式跳过延迟', async () => {
  const mw = createTypingDelayMiddleware({
    config: { mode: 'test' },
    logger: createTestLogger(),
    sleep: () => { throw new Error('测试模式不该真的等待'); },
  });
  const out = await mw.process({ sessionId: 's', text: '内容' }, async (c) => c);
  assert.equal(out.text, '内容');
});

test('按会话隔离：一个会话的长回复不拖慢另一个会话', async () => {
  const waits = [];
  const mw = createTypingDelayMiddleware({
    config: { mode: 'live' },
    logger: createTestLogger(),
    sleep: async (ms) => { waits.push(ms); },
  });

  // 会话 A 发一条长文本
  await mw.process({ sessionId: 'A', text: 'x'.repeat(300) }, async (c) => c);
  // 会话 B 的第一条：不应因为 A 的长文本而等待
  await mw.process({ sessionId: 'B', text: '短' }, async (c) => c);

  assert.deepEqual(waits, [], '两个会话的首条都不等待');

  // 会话 A 的第二条：按 A 上一条的 300 字算
  await mw.process({ sessionId: 'A', text: '第二条' }, async (c) => c);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= MAX_DELAY_MS);
});

test('延迟期间被打断则不再发送该段', async () => {
  const controller = new AbortController();
  const mw = createTypingDelayMiddleware({
    config: { mode: 'live' },
    logger: createTestLogger(),
    sleep: async () => { controller.abort(); },
  });

  await mw.process({ sessionId: 'S', text: '第一条' }, async (c) => c);
  const out = await mw.process(
    { sessionId: 'S', text: '第二条', signal: controller.signal },
    async () => { throw new Error('被打断后不该继续走 next'); },
  );
  assert.equal(out.cancelled, true);
});

test('延迟按最终可见文本长度算，所以必须排在 strip-markdown 之后', async () => {
  const waits = [];
  const mw = createTypingDelayMiddleware({
    config: { mode: 'live' },
    logger: createTestLogger(),
    sleep: async (ms) => { waits.push(ms); },
  });

  await mw.process({ sessionId: 'S', text: '一二三四五六七八九十一二三四五' }, async (c) => c); // 15 字
  await mw.process({ sessionId: 'S', text: '下一条' }, async (c) => c);

  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= computeDelayMs(15), '不应超过按 15 字算出的目标延迟');
});

// ===== 媒体提取 =====

test('MEDIA: 路径转成 CQ 图片段', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const { text, images } = extractMediaFromResponse(
    '画好了 MEDIA:F:/out/render.png 看看',
    { outputDir: tmp },
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].cq, '[CQ:image,file=file:///F:/out/render.png]');
  assert.ok(!text.includes('MEDIA:'));
});

test('重复的同一路径只产出一个图片段', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const { images } = extractMediaFromResponse(
    'MEDIA:F:/a.png MEDIA:F:/a.png',
    { outputDir: tmp },
  );
  assert.equal(images.length, 1);
});

test('内联 base64 落盘后转本地 file URI', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const payload = Buffer.from('x'.repeat(200)).toString('base64');
  const { text, images } = extractMediaFromResponse(
    `看图 data:image/png;base64,${payload} 结束`,
    { outputDir: tmp, writeEnabled: true },
  );

  assert.equal(images.length, 1);
  assert.ok(fs.existsSync(images[0].filePath));
  assert.equal(path.dirname(images[0].filePath), tmp);
  assert.ok(!text.includes('base64'));
});

test('writeEnabled=false 时不落盘，只记警告', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const payload = Buffer.from('x'.repeat(200)).toString('base64');
  const { images, warnings } = extractMediaFromResponse(
    `data:image/png;base64,${payload}`,
    { outputDir: tmp, writeEnabled: false },
  );
  assert.equal(images.length, 0);
  assert.ok(warnings.some((w) => w.includes('影子模式')));
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('超长裸 base64 被丢弃，不进切句循环', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const junk = 'A'.repeat(12000);
  const { text, warnings } = extractMediaFromResponse(`前${junk}后`, { outputDir: tmp });
  assert.equal(text, '前后');
  assert.ok(warnings.some((w) => w.includes('裸 base64')));
});

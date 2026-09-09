import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MemeStore } from '../../src/storage/meme-store.js';
import { processMemeMarkers, createMemeMiddleware } from '../../src/middleware/meme.js';
import { makeTempDir, cleanupDir, createTestLogger, seedMemes, loadTextFixture } from '../helpers.js';

function makeStore(tmp) {
  seedMemes(tmp, [
    { id: 'm_1787266663929_161', tag: '摸鱼', keywords: ['摸鱼', '划水'] },
    { id: 'm_1787266663930_162', tag: '无语', keywords: ['无语', '沉默'] },
    { id: 'm_rejected', tag: '待整理', status: 'needs_review' },
  ]);
  return new MemeStore({
    dataFile: path.join(tmp, 'memes_data.json'),
    memeRoot: path.join(tmp, 'memes'),
    logger: createTestLogger(),
  });
}

test('按 ID 精确解析 &&meme:ID&&', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  const { text, memeCqs, misses } = processMemeMarkers(
    '还真是。\n\n&&meme:m_1787266663929_161&&',
    store,
  );
  assert.equal(memeCqs.length, 1);
  assert.ok(memeCqs[0].startsWith('[CQ:image,file=file:///'));
  assert.ok(memeCqs[0].includes('m_1787266663929_161.png'));
  assert.equal(text, '还真是。');
  assert.deepEqual(misses, []);
});

test('真实模型回复样本：表情包 ID 与正文都正确分离', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  const { text, memeCqs } = processMemeMarkers(loadTextFixture('model-response-meme.txt'), store);
  assert.equal(memeCqs.length, 1);
  assert.ok(text.includes('冷萃出来会发涩'));
  assert.ok(!text.includes('&&meme:'));
});

test('未闭合的残缺标记被丢弃，不会以纯文本泄漏到 QQ', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  const { text, memeCqs, misses } = processMemeMarkers('正文\n\n&&meme:m_178726666', store);
  assert.equal(memeCqs.length, 0);
  assert.ok(!text.includes('&&meme:'));
  assert.ok(misses[0].startsWith('dangling:'));
});

test('ID 不存在时安全降级：文字照发，没有配图', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  const { text, memeCqs, misses } = processMemeMarkers('正文 &&meme:m_不存在&&', store);
  assert.equal(memeCqs.length, 0);
  assert.equal(text, '正文');
  assert.deepEqual(misses, ['id:m_不存在']);
});

test('status 非 accepted 的表情不可用', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  assert.equal(store.resolveById('m_rejected'), null);
});

test('文件缺失时安全降级', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  fs.unlinkSync(path.join(tmp, 'memes', '常用', 'm_1787266663929_161.png'));
  store.load(); // 强制刷新索引
  assert.equal(store.resolveById('m_1787266663929_161'), null);
});

test('[表情:标签] 与 [meme:标签] 按关键词模糊匹配', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);

  for (const marker of ['[表情:摸鱼]', '[meme:划水]', '[表情: 无语]']) {
    const { memeCqs } = processMemeMarkers(`正文 ${marker}`, store);
    assert.equal(memeCqs.length, 1, `${marker} 应命中`);
  }
});

test('路径穿越被拒绝（旧实现完全信任 JSON 里的绝对路径）', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  seedMemes(tmp, [{ id: 'm_ok', tag: 'ok' }]);

  // 污染索引：把 path 指到 memes/ 之外
  const dataFile = path.join(tmp, 'memes_data.json');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const outsideFile = path.join(tmp, 'secret.txt');
  fs.writeFileSync(outsideFile, 'SECRET');
  data.memes.push({
    id: 'm_evil',
    name: 'evil',
    category: '常用',
    tag: 'evil',
    keywords: ['evil'],
    path: outsideFile,
    status: 'accepted',
  });
  fs.writeFileSync(dataFile, JSON.stringify(data));

  const store = new MemeStore({
    dataFile,
    memeRoot: path.join(tmp, 'memes'),
    logger: createTestLogger(),
  });

  assert.equal(store.resolveById('m_evil'), null, '越界路径必须被拒绝');
  assert.ok(store.resolveById('m_ok'), '正常路径仍可用');

  const { memeCqs } = processMemeMarkers('正文 &&meme:m_evil&&', store);
  assert.equal(memeCqs.length, 0);
});

test('middleware 声明了顺序约束：必须排在 strip-markdown 之前', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const mw = createMemeMiddleware({ store: makeStore(tmp), logger: createTestLogger() });
  assert.deepEqual(mw.requiresBefore, ['strip-markdown']);
});

test('middleware 把 CQ 码放进 attachments 而不是正文', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const mw = createMemeMiddleware({ store: makeStore(tmp), logger: createTestLogger() });

  const ctx = { correlationId: 'c1', text: '还真是。\n\n&&meme:m_1787266663929_161&&', attachments: [] };
  const out = await mw.process(ctx, async (c) => c);

  assert.equal(out.text, '还真是。');
  assert.equal(out.attachments.length, 1);
});

test('search 按分数排序', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  const results = store.search('摸鱼', 5);
  assert.ok(results.length >= 1);
  assert.equal(results[0].tag, '摸鱼');
});

test('collectMeme：商城表情 label 优先当初始标签，无 label 退回会话标签', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const store = makeStore(tmp);
  // 关掉异步 AI 打标，避免测试里对视觉端点发起真实 fetch
  store.data.settings.auto_ai_tagging = false;

  store.startCollect('u1', '常用', '常用');
  const withLabel = store.collectMeme({
    uid: 'u1',
    filename: 'img_1.gif',
    buffer: Buffer.from('GIF89a'),
    label: '摸头',
  });
  const plain = store.collectMeme({ uid: 'u1', filename: 'img_2.png', buffer: Buffer.from('PNG') });
  const sess = store.getCollectSession('u1');

  assert.equal(withLabel.tag, '摸头', '商城表情 summary 应成为初始标签');
  assert.ok(withLabel.keywords.includes('摸头'));
  assert.ok(withLabel.keywords.includes('常用'));
  assert.ok(fs.existsSync(withLabel.path), '图片文件要落到分类目录');
  assert.equal(plain.tag, '常用', '无 label 用会话默认标签');
  assert.equal(sess.saved, 2);

  const done = store.stopCollect('u1');
  assert.ok(done.includes('写入【2】张'), `完成收集要报数: ${done}`);
  assert.equal(store.getCollectSession('u1'), null);
});

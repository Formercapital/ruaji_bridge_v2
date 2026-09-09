import test from 'node:test';
import assert from 'node:assert/strict';

import { stripMarkdown } from '../../src/middleware/strip-markdown.js';
import { loadTextFixture } from '../helpers.js';

test('标题转成【】', () => {
  assert.equal(stripMarkdown('### 排查步骤'), '【排查步骤】');
  assert.equal(stripMarkdown('# 大标题'), '【大标题】');
  assert.equal(stripMarkdown('## **加粗标题**'), '【加粗标题】');
});

test('加粗、斜体、删除线全部剥掉', () => {
  assert.equal(stripMarkdown('这是 **重点** 内容'), '这是 重点 内容');
  assert.equal(stripMarkdown('这是 *斜体* 内容'), '这是 斜体 内容');
  assert.equal(stripMarkdown('这是 ***三星*** 内容'), '这是 三星 内容');
  assert.equal(stripMarkdown('这是 ~~删掉~~ 内容'), '这是 删掉 内容');
  assert.equal(stripMarkdown('这是 __下划粗__ 内容'), '这是 下划粗 内容');
});

test('代码块与行内代码保留内容、去掉反引号', () => {
  assert.equal(stripMarkdown('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripMarkdown('改 `config.yaml` 就行'), '改 config.yaml 就行');
});

test('列表符号转成 ·，引用与分割线移除', () => {
  assert.equal(stripMarkdown('- 第一项\n- 第二项'), '· 第一项\n· 第二项');
  assert.equal(stripMarkdown('> 引用内容'), '引用内容');
  assert.equal(stripMarkdown('前\n\n---\n\n后'), '前\n\n后');
});

test('超链接保留文字与地址', () => {
  assert.equal(
    stripMarkdown('看[健康检查](http://127.0.0.1:29998/health)就知道'),
    '看健康检查 (http://127.0.0.1:29998/health)就知道',
  );
});

test('真实 CQ 码在整个处理过程中原样保留', () => {
  const input = '看这个 **图** [CQ:image,file=file:///F:/memes/a.png] 就懂了';
  const out = stripMarkdown(input);
  assert.ok(out.includes('[CQ:image,file=file:///F:/memes/a.png]'));
  assert.ok(!out.includes('**'));
});

test('表情包标记里的下划线不被斜体规则吃掉（关键回归）', () => {
  const input = '还真是。\n\n&&meme:m_1787266663929_161&&';
  const out = stripMarkdown(input);
  assert.ok(out.includes('&&meme:m_1787266663929_161&&'), `实际输出: ${out}`);
});

test('[表情:xxx] 标记同样受保护，全角冒号被归一', () => {
  assert.ok(stripMarkdown('*笑* [表情：摸鱼]').includes('[表情:摸鱼]'));
  assert.ok(stripMarkdown('[meme:无语] **强调**').includes('[meme:无语]'));
});

test('泄漏的占位符被拦截并清除', () => {
  const leaks = [];
  const out = stripMarkdown('正常文本 CQCODEHOLD3X 尾巴', { onLeak: (s) => leaks.push(s) });
  assert.equal(leaks.length, 1);
  assert.ok(!out.includes('CQCODEHOLD'));
});

test('连续换行最多保留两个', () => {
  assert.equal(stripMarkdown('A\n\n\n\n\nB'), 'A\n\nB');
});

test('真实 Markdown 回复样本：处理后不含任何 Markdown 符号', () => {
  const out = stripMarkdown(loadTextFixture('model-response-markdown.txt'));
  assert.ok(!/\*\*/.test(out), '不应残留 **');
  assert.ok(!/^#{1,6}\s/m.test(out), '不应残留 # 标题');
  assert.ok(!/^>/m.test(out), '不应残留 > 引用');
  assert.ok(!/`/.test(out), '不应残留反引号');
  assert.ok(out.includes('【排查步骤】'));
  assert.ok(out.includes('· 通了就是配置问题'));
});

test('纯分割线处理后为空，调用方据此跳过发送', () => {
  assert.equal(stripMarkdown('---'), '');
  assert.equal(stripMarkdown('***'), '');
});

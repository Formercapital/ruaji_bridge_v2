import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SentenceSplitter,
  findNextSplitBoundary,
  splitIntoSegments,
  removeEmptyBrackets,
  trimSegmentEdgeBlankLines,
} from '../../src/orchestration/sentence-splitter.js';

test('用户场景测试：4 句单换行文本正确切分为 4 段', () => {
  const text = `……啊？
你刚才00:36不是手滑发了个 /new 吗……
直接把当前会话刷空了，可不就上下文全断了嘛。
还是说统一宿主或者GCP那边的滑窗缓存又卡住了？`;

  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 4, `应当被切分为4段，实际为: ${segments.length}`);
  assert.equal(segments[0], '……啊？');
  assert.equal(segments[1], '你刚才00:36不是手滑发了个 /new 吗……');
  assert.equal(segments[2], '直接把当前会话刷空了，可不就上下文全断了嘛。');
  assert.equal(segments[3], '还是说统一宿主或者GCP那边的滑窗缓存又卡住了？');
});

test('连续贪婪标点吞并：不产生空段或孤立标点', () => {
  const text = '真的假的？？？！！！这也太离谱了吧……对吧？？？';
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 3);
  assert.equal(segments[0], '真的假的？？？！！！');
  assert.equal(segments[1], '这也太离谱了吧……');
  assert.equal(segments[2], '对吧？？？');
});

test('成对括号栈保护：括号内的句号和感叹号不切断', () => {
  const text = '这是第一段（括号里的内容。不应该被切开！）。然后这是第二段。';
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 2);
  assert.equal(segments[0], '这是第一段（括号里的内容。不应该被切开！）。');
  assert.equal(segments[1], '然后这是第二段。');
});

test('成对引号保护：引号内的句子不被劈开', () => {
  const text = '瑞姬说：“今天天气真好。我们去钓鱼吧！”说完就出门了。';
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 2);
  assert.equal(segments[0], '瑞姬说：“今天天气真好。我们去钓鱼吧！”');
  assert.equal(segments[1], '说完就出门了。');
});

test('ASCII / 小数 / URL 保护：不被误切', () => {
  const text = '请等待 1.5 秒，访问 https://github.com/abc?x=1.2&y=3 查看详情。下一句开始。';
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].includes('1.5 秒'));
  assert.ok(segments[0].includes('https://github.com/abc?x=1.2&y=3'));
  assert.equal(segments[1], '下一句开始。');
});

test('Markdown 代码块保护：代码块内部标点与换行不切分', () => {
  const text = `先看一段代码：
\`\`\`javascript
const a = 1;
console.log("hello. world!");
\`\`\`
代码解释如上。`;

  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 3);
  assert.equal(segments[0], '先看一段代码：');
  assert.ok(segments[1].includes('console.log("hello. world!");'));
  assert.equal(segments[2], '代码解释如上。');
});

test('Markdown 表格保护：连续表格行作为一个整体', () => {
  const text = `下面是表格：
| 编号 | 名称 | 状态 |
| :--- | :--- | :--- |
| 1 | 任务一 | 完成。 |
| 2 | 任务二 | 进行中！ |
以上就是全部表格数据。`;

  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 3);
  assert.equal(segments[0], '下面是表格：');
  assert.ok(segments[1].includes('| 1 | 任务一 | 完成。 |'));
  assert.equal(segments[2], '以上就是全部表格数据。');
});

test('空括号对自动清除：只清中文成对符号，半角 () [] 是正文内容', () => {
  const text = '这是《》测试『』内容。\n下一段【】在这里。';
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, 2);
  assert.equal(segments[0], '这是测试内容。');
  assert.equal(segments[1], '下一段在这里。');

  // 回归：半角括号是代码的一部分，清掉等于静默改写模型输出
  assert.equal(removeEmptyBrackets('const arr = [];\nfoo()'), 'const arr = [];\nfoo()');
  assert.deepEqual(splitIntoSegments('执行 init() 就行。'), ['执行 init() 就行。']);
});

test('流式推入逐步吐出与 flush 完整残留', () => {
  const splitter = new SentenceSplitter();
  const res1 = splitter.push('第一句搞定。第二句');
  assert.deepEqual(res1, ['第一句搞定。']);
  assert.equal(splitter.pending, '第二句');

  const res2 = splitter.push('也搞定了！第三句还在写');
  assert.deepEqual(res2, ['第二句也搞定了！']);
  assert.equal(splitter.pending, '第三句还在写');

  const res3 = splitter.flush();
  assert.deepEqual(res3, ['第三句还在写']);
});

test('最大段数合并控制：超出 maxSegments 自动合并尾部', () => {
  const text = '段1。\n段2。\n段3。\n段4。\n段5。\n段6。\n段7。\n段8。\n段9。';
  const segments = splitIntoSegments(text, { maxSegments: 5 });
  assert.equal(segments.length, 5);
  assert.equal(segments[0], '段1。');
  assert.equal(segments[1], '段2。');
  assert.equal(segments[2], '段3。');
  assert.equal(segments[3], '段4。');
  assert.equal(segments[4], '段5。\n段6。\n段7。\n段8。\n段9。');
});

test('逐字符喂入流式与一次性喂入结果一致', () => {
  const text = `……啊？
你刚才00:36不是手滑发了个 /new 吗……
直接把当前会话刷空了，可不就上下文全断了嘛。
还是说统一宿主或者GCP那边的滑窗缓存又卡住了？`;

  const whole = splitIntoSegments(text);

  const splitter = new SentenceSplitter();
  const streamed = [];
  for (const ch of text) {
    streamed.push(...splitter.push(ch));
  }
  streamed.push(...splitter.flush());

  assert.deepEqual(streamed, whole);
});

// ─────────────────────────────────────────────────────────────────────────────
// 以下为 2026-08 分段引擎缺陷修复的回归用例。每一条都对应一个线上观察到 /
// 复现出的错误分段，改动分段逻辑时不要放松这些断言。
// ─────────────────────────────────────────────────────────────────────────────

test('回归：引号闭合后紧跟的句号必须被吸收，不能单独成段', () => {
  // 线上观察：…吼一句“若！8！”。 被切成 [ …“若！8！” ] 和 [ 。 ]，句号单独发了一条消息
  const text = '这就是纯粹的大脑降级发癫空耳……最后还要扯着嗓子吼一句“若！8！”。';
  assert.deepEqual(splitIntoSegments(text), [
    '这就是纯粹的大脑降级发癫空耳……',
    '最后还要扯着嗓子吼一句“若！8！”。',
  ]);

  // 后面还有正文时，句号会被甩到下一段开头，同样错误
  assert.deepEqual(splitIntoSegments('他喊“若！8！”。下一句在这里。'), [
    '他喊“若！8！”。',
    '下一句在这里。',
  ]);
});

test('回归：任何一段都不能是纯标点或纯分隔线', () => {
  for (const text of [
    '他喊“若！8！”。',
    '第一句。\n---\n第二句在这里。',
    '第一句话。\n***\n第二句话在这。',
  ]) {
    for (const seg of splitIntoSegments(text)) {
      assert.ok(/[一-鿿a-zA-Z0-9]/.test(seg), `段落缺少实义内容: ${JSON.stringify(seg)}`);
    }
  }
});

test('回归：落单的成对符号不能让整条消息不再分段', () => {
  // < 不在 PAIR_MAP 里；撇号有缩写守卫；同字符引号要求后面存在配对
  assert.equal(splitIntoSegments('如果 a < b 就成立。第二句在这里。').length, 2);
  assert.equal(splitIntoSegments('当 x<10 时成立。所以是这样的。').length, 2);
  assert.equal(splitIntoSegments("I don't know。第二句在这里。").length, 2);
  assert.equal(splitIntoSegments('用 `foo 这个。第二句在这里。').length, 2);
  assert.equal(splitIntoSegments('看这个 (未闭合的括号。第二句在这里。').length, 2);
});

test('回归：正常配对的引号仍然受保护', () => {
  assert.deepEqual(splitIntoSegments('他说 "hello。这里。" 好的呀。第二句在这里。'), [
    '他说 "hello。这里。"',
    '好的呀。',
    '第二句在这里。',
  ]);
});

test('回归：maxSegments 在流式路径同样生效', () => {
  const text = '段1。\n段2。\n段3。\n段4。\n段5。\n段6。\n段7。\n段8。\n段9。';

  const splitter = new SentenceSplitter();
  const streamed = [];
  for (const ch of text) streamed.push(...splitter.push(ch));
  streamed.push(...splitter.flush());

  assert.equal(streamed.length, 7, '流式必须和非流式一样受 maxSegments 限制');
  assert.deepEqual(streamed, splitIntoSegments(text));
  // 超额部分并进最后一段，内容不能丢
  assert.equal(streamed.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('回归：过短的尾段被吸收进上一段', () => {
  assert.deepEqual(splitIntoSegments('这是一句比较长的话。好。'), ['这是一句比较长的话。\n好。']);
});

test('回归：英文语句可以正常断句（空白不算英文词内上下文）', () => {
  assert.deepEqual(splitIntoSegments('Hello world! Next sentence. Are you OK? Yes.'), [
    'Hello world!',
    'Next sentence. Are you OK?',
    'Yes.',
  ]);
  // URL 与词内仍然受保护
  assert.deepEqual(splitIntoSegments('访问 https://a.com/b?x=1&y=2 看看吧。下一句在这里。'), [
    '访问 https://a.com/b?x=1&y=2 看看吧。',
    '下一句在这里。',
  ]);
});

test('回归：非行首的代码块也整体穿透', () => {
  assert.deepEqual(splitIntoSegments('看代码：```js\nconst a=1;\n```\n以上就是全部代码。'), [
    '看代码：',
    '```js\nconst a=1;\n```',
    '以上就是全部代码。',
  ]);
});

test('maxSegmentLength：超长段在标点处折断（默认关闭）', () => {
  const long = '啊'.repeat(300);
  assert.equal(splitIntoSegments(long).length, 1, '默认不限制单段长度');

  const wrapped = splitIntoSegments(long, { maxSegmentLength: 100 });
  assert.equal(wrapped.length, 3);
  for (const seg of wrapped) assert.ok(seg.length <= 100, `超出上限: ${seg.length}`);
  assert.equal(wrapped.join(''), long, '折断不能丢内容');
});

test('自定义非全局正则不会静默失效', () => {
  assert.deepEqual(splitIntoSegments('第一句话在这；第二句话在这；第三句话在这', { splitRegex: /[；]+/ }), [
    '第一句话在这；',
    '第二句话在这；',
    '第三句话在这',
  ]);
});

test('回归：流式与非流式在各类边界文本上结果完全一致', () => {
  // 这条是性质测试，不是单点断言。它抓到过「引号闭合后的句号在流式里被甩成独立一段」，
  // 单靠上面那条 4 句文本的一致性用例是发现不了的 —— 新增分段规则时请往这个列表里加样本。
  const corpus = [
    '这就是纯粹的大脑降级发癫空耳……最后还要扯着嗓子吼一句“若！8！”。',
    '看这个 (未闭合的括号。第二句在这里。第三句也在这。',
    '用 `foo 这个。第二句在这里。',
    "I don't know。第二句在这里。第三句在这。",
    '瑞姬说：“今天天气真好。我们去钓鱼吧！”说完就出门了。',
    '先看代码：\n```js\nconst a=1;\nconsole.log("x. y!");\n```\n以上就是全部代码。',
    '段1。\n段2。\n段3。\n段4。\n段5。\n段6。\n段7。\n段8。\n段9。',
    'Hello world! Next sentence. Are you OK? Yes I am.',
    '真的假的？？？！！！这也太离谱了吧……对吧？？？',
    '下面是表格：\n| a | b |\n| :--- | :--- |\n| 1 | 完成。 |\n以上就是全部表格数据。',
  ];

  for (const text of corpus) {
    const splitter = new SentenceSplitter();
    const streamed = [];
    for (const ch of text) streamed.push(...splitter.push(ch));
    streamed.push(...splitter.flush());

    assert.deepEqual(streamed, splitIntoSegments(text), `流式与非流式不一致: ${JSON.stringify(text)}`);
  }
});

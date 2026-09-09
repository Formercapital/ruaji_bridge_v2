import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { MemeMatcher } from '../../src/orchestration/meme-matcher.js';
import { MemeStore } from '../../src/storage/meme-store.js';
import { makeTempDir, cleanupDir, seedMemes, createTestLogger } from '../helpers.js';

/** 可编程模型替身：按调用序返回预置回复，并记录收到的请求 */
function fakeModels(replies) {
  const calls = [];
  return {
    calls,
    generate: async (req, opts = {}) => {
      calls.push({ req, opts, messages: req.messages });
      if (opts.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const rawText = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { rawText, model: req.model, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 5 };
    },
  };
}

function makeStore(tmp) {
  seedMemes(tmp, [
    { id: 'm_aaa', tag: '摸鱼', keywords: ['摸鱼', '划水'], description: '想摸鱼的时候发' },
    { id: 'm_bbb', tag: '无语', keywords: ['无语', '沉默'], description: '无语的时候发' },
    { id: 'm_rejected', tag: '待整理', status: 'needs_review' },
  ]);
  return new MemeStore({
    dataFile: path.join(tmp, 'memes_data.json'),
    memeRoot: path.join(tmp, 'memes'),
    logger: createTestLogger(),
  });
}

function makeMatcher({ models, tmp, config } = {}) {
  return new MemeMatcher({
    models: models ?? fakeModels(['{"decision":"none"}']),
    memeStore: makeStore(tmp),
    config: {
      meme: {
        matcherEnabled: true,
        matcherBaseUrl: 'http://matcher.test/v1',
        matcherModel: 'test-mini',
        matcherMaxRetries: 2,
        matcherCandidateCount: 10,
        ...(config?.meme ?? {}),
      },
    },
    logger: createTestLogger(),
  });
}

const INBOUND = {
  correlationId: 'corr-1',
  sessionId: 'qq:group:666',
  messageId: 'm1',
  messageType: 'group',
  groupId: '666',
  userId: '2260757842',
  content: '@瑞姬 今天好累啊想摸鱼',
  text: '今天好累啊想摸鱼',
};

function attach(matcher, { replyText = '摸什么鱼，快去干活~', userText = '今天好累啊想摸鱼', signal, replies } = {}) {
  const enqueued = [];
  const promise = matcher.maybeAttach({
    inbound: INBOUND,
    replyText,
    userText,
    signal,
    enqueue: (m) => enqueued.push(m),
  });
  return { promise, enqueued };
}

test('合法 send：命中候选并 enqueue 一条独立图片消息', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"send","meme_id":"m_aaa"}']);
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, true);
  assert.equal(result.memeId, 'm_aaa');
  assert.equal(result.decision, 'send');

  // enqueue 回调收到正确 target 与 metadata
  assert.equal(enqueued.length, 1);
  const msg = enqueued[0];
  assert.equal(msg.correlationId, 'corr-1');
  assert.equal(msg.sessionId, 'qq:group:666');
  assert.equal(msg.target.type, 'group');
  assert.equal(msg.target.id, '666');
  assert.equal(msg.replyToUserId, '2260757842');
  assert.ok(msg.text.startsWith('[CQ:image,file=file:///'));
  assert.ok(msg.text.includes('m_aaa.png'));
  assert.equal(msg.metadata.isFirst, false);
  assert.equal(msg.metadata.disableAutoMention, true);

  // 模型请求：sessionKey 前缀、非流式、generation 参数
  const req = models.calls[0].req;
  assert.equal(req.sessionKey, 'memematch_util');
  assert.equal(req.stream, false);
  assert.equal(req.model, 'test-mini');
  assert.equal(req.generation.max_tokens, 5000, '思考型模型的推理 token 共享预算，必须给足');
  assert.match(req.correlationId, /^meme_match_corr-1$/);

  // user prompt 含触发消息、回复与候选
  const userPrompt = req.messages.find((m) => m.role === 'user').content;
  assert.ok(userPrompt.includes('[触发消息]'));
  assert.ok(userPrompt.includes('今天好累啊想摸鱼'));
  assert.ok(userPrompt.includes('[机器人回复]'));
  assert.ok(userPrompt.includes('m_aaa'));
});

test('decision=none 是合法终态：不重试、不 enqueue', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"none"}']);
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, false);
  assert.equal(result.memeId, null);
  assert.equal(result.decision, 'none');
  assert.equal(models.calls.length, 1, 'none 不应触发重试');
  assert.equal(enqueued.length, 0);
});

test('JSON 容错提取：markdown 代码块包裹的 JSON 也能解析', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['```json\n{"decision":"send","meme_id":"m_aaa"}\n```']);
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, true);
  assert.equal(result.memeId, 'm_aaa');
  assert.equal(enqueued.length, 1);
});

test('捏造 ID：带反馈重试，第二次成功', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels([
    '{"decision":"send","meme_id":"m_捏造的不存在"}',
    '{"decision":"send","meme_id":"m_aaa"}',
  ]);
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, true);
  assert.equal(result.memeId, 'm_aaa');
  assert.equal(enqueued.length, 1);
  assert.equal(models.calls.length, 2, '捏造 ID 应触发一次重试');

  // 重试时 messages 追加了 assistant 原文 + user 纠错反馈
  const retryMessages = models.calls[1].messages;
  assert.equal(retryMessages.length, 4);
  assert.equal(retryMessages[2].role, 'assistant');
  assert.ok(retryMessages[2].content.includes('m_捏造的不存在'));
  assert.equal(retryMessages[3].role, 'user');
  assert.ok(retryMessages[3].content.includes('不在候选列表'));
});

test('烂 JSON：重试耗尽后放弃，异常不外泄', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['这不是 JSON', '也不是 {JSON']);
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, false);
  assert.equal(result.decision, 'invalid');
  assert.equal(enqueued.length, 0);
  // 默认 maxRetries=2：共 3 次尝试
  assert.equal(models.calls.length, 3);
});

test('重试次数尊重 matcherMaxRetries 配置', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['垃圾输出']);
  const matcher = makeMatcher({ models, tmp, config: { meme: { matcherMaxRetries: 0 } } });
  const { promise } = attach(matcher);

  const result = await promise;
  assert.equal(result.decision, 'invalid');
  assert.equal(models.calls.length, 1, 'maxRetries=0 时只试一次');
});

test('候选数上限：matcherCandidateCount 截断候选列表', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"none"}']);
  const matcher = makeMatcher({ models, tmp, config: { meme: { matcherCandidateCount: 1 } } });
  await attach(matcher).promise;

  const userPrompt = models.calls[0].messages.find((m) => m.role === 'user').content;
  assert.ok(userPrompt.includes('m_aaa'), '按分数排序应保留第一个候选');
  assert.ok(!userPrompt.includes('m_bbb'), '超限候选应被截断');
});

test('空候选：跳过 API 调用，零成本返回 null', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"send","meme_id":"m_aaa"}']);
  const matcher = makeMatcher({ models, tmp });
  // 回复与触发消息都搜不到任何候选
  const { promise, enqueued } = attach(matcher, {
    replyText: 'zzz qqq 完全无关词汇',
    userText: 'xxx yyy',
  });

  const result = await promise;
  assert.equal(result, null);
  assert.equal(models.calls.length, 0, '空候选不应发起 API 调用');
  assert.equal(enqueued.length, 0);
});

test('matcherEnabled=false：短路返回 null', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"send","meme_id":"m_aaa"}']);
  const matcher = makeMatcher({ models, tmp, config: { meme: { matcherEnabled: false } } });
  const { promise } = attach(matcher);

  assert.equal(await promise, null);
  assert.equal(models.calls.length, 0);
});

test('回复为空：短路返回 null', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels([]);
  const matcher = makeMatcher({ models, tmp });
  const { promise } = attach(matcher, { replyText: '   ' });

  assert.equal(await promise, null);
  assert.equal(models.calls.length, 0);
});

test('端点未配置（matcher 与 vision 都为空）：短路返回 null', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"send","meme_id":"m_aaa"}']);
  const matcher = makeMatcher({
    models,
    tmp,
    config: { meme: { matcherBaseUrl: '', visionBaseUrl: '' } },
  });
  const { promise } = attach(matcher);

  assert.equal(await promise, null);
  assert.equal(models.calls.length, 0);
});

test('matcherBaseUrl 留空时回落 visionBaseUrl', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const matcher = makeMatcher({
    tmp,
    config: { meme: { matcherBaseUrl: '', visionBaseUrl: 'http://vision.test/v1', matcherModel: '' } },
  });
  assert.equal(matcher.effectiveBaseUrl, 'http://vision.test/v1');
  assert.equal(matcher.effectiveModel, 'gpt-4o-mini');
});

test('signal.aborted：中止且不发陈旧表情', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels(['{"decision":"send","meme_id":"m_aaa"}']);
  const matcher = makeMatcher({ models, tmp });
  const controller = new AbortController();
  controller.abort();
  const { promise, enqueued } = attach(matcher, { signal: controller.signal });

  assert.equal(await promise, null);
  assert.equal(models.calls.length, 0);
  assert.equal(enqueued.length, 0);
});

test('模型调用抛异常：吞掉异常，返回不配图，文本不受影响', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = {
    generate: async () => {
      throw new Error('matcher endpoint down');
    },
  };
  const matcher = makeMatcher({ models, tmp });
  const { promise, enqueued } = attach(matcher);

  const result = await promise;
  assert.equal(result.attached, false);
  assert.equal(result.decision, 'error');
  assert.equal(enqueued.length, 0);
});

test('resolveById 失败（文件缺失竞态）：视为无效输出并重试', async (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));
  const models = fakeModels([
    '{"decision":"send","meme_id":"m_ghost"}',
    '{"decision":"none"}',
  ]);
  // search 能给出候选、但 resolveById 在竞态窗口里解析失败（如文件刚被删）。
  // 真实 MemeStore.search 会预过滤掉文件缺失的候选，这里用 stub 直击这条防御分支。
  const matcher = new MemeMatcher({
    models,
    memeStore: {
      search: () => [
        { id: 'm_ghost', tag: '摸鱼', category: '常用', keywords: ['摸鱼'], description: '' },
      ],
      resolveById: () => null,
    },
    config: {
      meme: { matcherEnabled: true, matcherBaseUrl: 'http://matcher.test/v1', matcherModel: 'test-mini' },
    },
    logger: createTestLogger(),
  });

  const { promise, enqueued } = attach(matcher);
  const result = await promise;
  assert.equal(result.attached, false);
  assert.equal(models.calls.length, 2, 'resolveById 失败应触发重试');
  assert.ok(models.calls[1].messages.at(-1).content.includes('解析失败'));
  assert.equal(enqueued.length, 0);
});

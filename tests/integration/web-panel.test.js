/**
 * tests/integration/web-panel.test.js — 运维面板端到端
 *
 * 真起 HTTP 服务（端口 0，随机端口），真发请求。不 mock 路由层，
 * 因为这一层最容易出的问题恰恰是"函数都对、路由拼错了"。
 *
 * 最关键的一条断言在最后：沙箱跑完整条管线之后，Sender 的队列必须是空的。
 * 沙箱一旦漏发一条消息到真实 QQ 群，损失是不可撤销的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildTestContainer, seedAffection, seedMemes, flush } from '../helpers.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';

/** 起一个容器 + 面板，返回一个绑好 baseUrl 的 fetch 助手 */
async function withPanel(opts = {}, fn) {
  const container = buildTestContainer(opts);
  const server = await container.webServer.listen(0, '127.0.0.1');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await fn({ container, base, get, post });
  } finally {
    await container.webServer.close();
    container.cleanup();
  }
}

test('静态首页与前端资源可访问', async () => {
  await withPanel({}, async ({ base }) => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const body = await html.text();
    assert.match(body, /RUAJI Bridge v2/);
    // 六个标签页都必须在页面上
    for (const view of ['overview', 'traces', 'sandbox', 'shadow', 'affection', 'memes']) {
      assert.match(body, new RegExp(`data-view="${view}"`), `缺少 ${view} 标签页`);
    }

    for (const asset of ['/style.css', '/app.js']) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, `${asset} 应当可访问`);
    }
  });
});

test('静态资源不允许目录穿越', async () => {
  await withPanel({}, async ({ base }) => {
    for (const attack of ['/../../package.json', '/..%2f..%2fpackage.json', '/../server.js']) {
      const res = await fetch(`${base}${attack}`);
      assert.ok(res.status === 403 || res.status === 404, `${attack} 必须被拒绝，实际 ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('ruaji-bridge-v2'), '绝不能读到 public/ 之外的文件');
    }
  });
});

test('未知接口返回 404 而不是 500', async () => {
  await withPanel({}, async ({ get }) => {
    const { status, body } = await get('/api/does-not-exist');
    assert.equal(status, 404);
    assert.match(body.error, /未知接口/);
  });
});

test('大盘返回运行态、组件、指标与熔断四块', async () => {
  await withPanel({}, async ({ get }) => {
    const { status, body } = await get('/api/dashboard');
    assert.equal(status, 200);

    assert.equal(body.runtime.mode, 'test');
    assert.equal(body.runtime.sendEnabled, false);
    assert.ok(Number.isFinite(body.runtime.uptimeMs));

    const ids = body.components.map((c) => c.id);
    assert.deepEqual(ids, ['napcat-ws', 'napcat-http', 'model', 'unified-host']);
    // 统一宿主必须出现在卡片里（任务书要求探测 :8870）
    const host = body.components.find((c) => c.id === 'unified-host');
    assert.match(host.target, /8870/);

    assert.ok(body.metrics, '指标块不能为空');
    assert.ok(Array.isArray(body.circuits));
    assert.ok(Array.isArray(body.capabilities));
  });
});

test('大盘的探活失败不会让整个接口挂掉', async () => {
  // fetch stub 对所有路由都抛 ECONNREFUSED
  await withPanel({ routes: {} }, async ({ get }) => {
    const { status, body } = await get('/api/dashboard');
    assert.equal(status, 200, '探活全失败时大盘仍须可用');
    const model = body.components.find((c) => c.id === 'model');
    assert.equal(model.status, 'critical');
    assert.equal(model.detail.ok, false);
  });
});

test('好感度看板读到存量数据，主人被标注且不可调整', async () => {
  const container = buildTestContainer({});
  container.cleanup();

  await withPanel({}, async ({ container: c, get, post }) => {
    seedAffection(c.tmpDir, {
      10000001: { nickname: 'ruaji', affection: 100, relationship: '另一个自己 (唯一绑定者)', interactions: 9 },
      12345: { nickname: '群友A', affection: 42.5, relationship: '熟络群友', interactions: 3, recentDeltas: [] },
    });
    c.affectionStore.load();

    const { body } = await get('/api/affection');
    assert.equal(body.total, 2);

    const owner = body.items.find((u) => u.uid === '10000001');
    assert.equal(owner.isOwner, true);

    const other = body.items.find((u) => u.uid === '12345');
    assert.equal(other.affection, 42.5);
    assert.equal(other.level, '熟络群友');
    assert.ok(other.bar.includes('█'), '应当带进度条');

    // 主人不接受调整
    const rejected = await post('/api/affection/adjust', { uid: '10000001', affection: 50 });
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /恒为 100/);
  });
});

test('手动调整好感度在只读模式下如实报告"未落盘"', async () => {
  await withPanel({}, async ({ container, get, post }) => {
    seedAffection(container.tmpDir, {
      12345: { nickname: '群友A', affection: 20, relationship: '陌生人', interactions: 1, recentDeltas: [] },
    });
    container.affectionStore.load();

    const { status, body } = await post('/api/affection/adjust', {
      uid: '12345', affection: 66, reason: '面板集成测试',
    });

    assert.equal(status, 200);
    assert.equal(body.from, 20);
    assert.equal(body.to, 66);
    assert.equal(body.persisted, false, 'test 模式 sideEffectsEnabled=false，必须报告未落盘');
    assert.match(body.note, /内存/);
    assert.equal(body.item.lastChange.source, 'admin', '人工改动要能与模型打分区分开');

    // 内存里确实改了，主链路能立刻看到
    assert.equal(container.affectionStore.getContext('12345').affection, 66);

    // 文件确实没动
    const onDisk = JSON.parse(fs.readFileSync(path.join(container.tmpDir, 'affection.json'), 'utf8'));
    assert.equal(onDisk.users['12345'].affection, 20);

    const after = await get('/api/affection/12345');
    assert.equal(after.body.item.affection, 66);
  });
});

test('好感度调整拒绝非法输入', async () => {
  await withPanel({}, async ({ post }) => {
    assert.equal((await post('/api/affection/adjust', {})).status, 400);
    assert.equal((await post('/api/affection/adjust', { uid: '1' })).status, 400);
    assert.equal((await post('/api/affection/adjust', { uid: '1', affection: 'abc' })).status, 400);
  });
});

test('表情包图库列出索引、暴露引用写法并能取回图片', async () => {
  await withPanel({}, async ({ container, get, base }) => {
    seedMemes(container.tmpDir, [
      { id: 'm_1787266663929_161', tag: '摸鱼', keywords: ['摸鱼', '躺平'] },
      { id: 'm_broken_001', tag: '坏的', keywords: ['x'] },
    ]);
    container.memeStore.load();

    const { body } = await get('/api/memes');
    assert.equal(body.total, 2);

    const meme = body.items.find((m) => m.id === 'm_1787266663929_161');
    assert.equal(meme.reference, '&&meme:m_1787266663929_161&&');
    assert.equal(meme.usable, true);

    const img = await fetch(`${base}${meme.imageUrl}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');

    // 不存在的 ID 不能变成任意文件读取
    const bad = await fetch(`${base}/api/memes/file?id=../../../package.json`);
    assert.equal(bad.status, 404);
  });
});

test('表情包 Tag 检索复用主链路的 findByTag', async () => {
  await withPanel({}, async ({ container, get }) => {
    seedMemes(container.tmpDir, [{ id: 'm1', tag: '摸鱼', keywords: ['摸鱼', '躺平'] }]);
    container.memeStore.load();

    const hit = await get('/api/memes/search?tag=摸鱼');
    assert.equal(hit.body.picked.id, 'm1');
    assert.equal(hit.body.pickedReference, '&&meme:m1&&');

    const miss = await get('/api/memes/search?tag=不存在的标签');
    assert.equal(miss.body.picked, null);
    assert.match(miss.body.note, /不会发出图片/);

    const resolved = await get('/api/memes/resolve?id=m1');
    assert.equal(resolved.body.resolved.id, 'm1');

    const unresolved = await get('/api/memes/resolve?id=nope');
    assert.equal(unresolved.body.resolved, null);
    assert.ok(unresolved.body.reason);
  });
});

test('影子接口在没有对照文件时也能正常返回', async () => {
  await withPanel({}, async ({ get }) => {
    const files = await get('/api/shadow/files');
    assert.equal(files.status, 200);
    assert.ok(Array.isArray(files.body.files));

    const report = await get('/api/shadow/report');
    assert.equal(report.status, 200);
    assert.ok(Array.isArray(report.body.intentionalDiffs));
    assert.equal(report.body.intentionalDiffs.length, 3, '三条有意识差异必须一直在册');
  });
});

test('影子对照按 correlationId 把 decision 与 reply 缝成一行', async () => {
  await withPanel({ configOverrides: { mode: 'shadow' } }, async ({ container, get }) => {
    const rec = container.shadowRecorder;
    rec.enabled = true;
    rec._write({
      kind: 'decision', at: new Date().toISOString(), correlationId: 'corr-A',
      messageId: 'm1', sessionId: 'qq:group:1', v2Decision: 'direct', v2Reason: 'provider_direct',
      isAtBot: true, isNameCall: false, isOwner: false, oldBridgeDecision: null, match: null,
    });
    rec._write({
      kind: 'reply', at: new Date().toISOString(), correlationId: 'corr-A',
      messageId: 'm1', sessionId: 'qq:group:1', segments: 2, replyChars: 88, latencyMs: 700,
      contextSources: [{ source: 'local-window', slot: 'recent', chars: 120 }],
      suppressedSideEffects: [{ kind: 'affection' }],
    });

    const { body } = await get('/api/shadow/report?file=memory');
    const row = body.diffs.find((r) => r.correlationId === 'corr-A');
    assert.equal(row.v2Decision, 'direct');
    assert.equal(row.segments, 2);
    assert.equal(row.latencyMs, 700);
    assert.equal(row.match, null, '没回填旧裁决时必须显式为 null，不能假装一致');
    assert.equal(body.sideEffects.suppressed, 1);
  });
});

test('影子接口不允许读 shadowDir 之外的文件', async () => {
  await withPanel({}, async ({ get }) => {
    const { status } = await get('/api/shadow/entries?file=../../package.json');
    assert.equal(status, 404);
  });
});

test('沙箱跑完整条管线，产出规范化/裁决/Prompt/分段四段结果', async () => {
  await withPanel({
    modelAdapter: new MockModelAdapter({ replies: ['不该被用到'] }),
  }, async ({ container, post }) => {
    const { status, body } = await post('/api/sandbox/run', {
      messageType: 'group',
      groupId: '707423412',
      userId: container.config.identity.ownerId,
      nickname: 'ruaji(阵亡)',
      text: '帮我看看这段配置',
      isAtBot: true,
      callModel: false,
      mockReply: '好的，我看看。\n\n配置没问题，直接跑就行。',
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // ① 规范化
    assert.equal(body.inbound.sessionId, 'qq:group:707423412');
    assert.equal(body.inbound.executionKey, 'group_707423412');
    assert.equal(body.inbound.flags.isAtBot, true);
    assert.equal(body.inbound.flags.isOwner, true);
    assert.equal(body.inbound.text, '帮我看看这段配置');

    // ② 裁决：真 @ 且无 Provider → 兜底 direct
    assert.equal(body.decision.route, 'direct');

    // ③ Prompt 全文
    assert.ok(body.prompt.systemText.length > 0, '必须给出完整 System Prompt');
    assert.equal(body.prompt.messages[0].role, 'system');
    assert.equal(body.prompt.messages.at(-1).role, 'user');

    // ④ 切句 + Middleware：空行分段 → 两段
    assert.equal(body.segments.length, 2);
    assert.equal(body.segments[0].before, '好的，我看看。');
    assert.ok(body.segments[0].napcatPayload.message.includes('[CQ:at,qq='), '首段应当 @ 回发送人');
    assert.ok(!body.segments[1].napcatPayload.message.includes('[CQ:at,qq='), '后续段不再 @');

    // 沙箱绝不投递
    assert.equal(body.delivery.enqueued, false);
    assert.equal(container.sender.queue.length, 0, '沙箱执行后发送队列必须仍为空');
  });
});

test('沙箱裁决为 ignore 时如实停在裁决步，不调用模型', async () => {
  await withPanel({
    // 注册一个恒 ignore 的裁决 Provider
    plugins: [],
  }, async ({ container, post }) => {
    container.capabilityBus.register({
      id: 'test-decider',
      capability: 'decision.group_reply',
      priority: 100,
      invoke: async () => ({ route: 'ignore', reason: 'reading_the_air' }),
    });

    const { body } = await post('/api/sandbox/run', {
      messageType: 'group', groupId: '1', userId: '99', nickname: '路人',
      text: '今天天气不错', isAtBot: false, callModel: false,
    });

    assert.equal(body.decision.route, 'ignore');
    assert.equal(body.stoppedAt, 'decision');
    assert.equal(body.reply, null);
    assert.deepEqual(body.segments, []);
    assert.match(body.note, /不会调用模型/);
  });
});

test('沙箱识别"发送人就是机器人自己"这种会被丢弃的输入', async () => {
  await withPanel({}, async ({ container, post }) => {
    const { body } = await post('/api/sandbox/run', {
      messageType: 'group', groupId: '1',
      userId: container.config.identity.robotId,
      nickname: '瑞姬', text: '自言自语', isAtBot: false,
    });

    assert.equal(body.ok, false);
    assert.equal(body.droppedAt, 'inbound.normalize');
    assert.equal(body.droppedReason, 'self_message');
    assert.match(body.note, /机器人自己/);
  });
});

test('沙箱默认不跑收尾轮，勾选后才产生副作用记录', async () => {
  await withPanel({}, async ({ post }) => {
    const without = await post('/api/sandbox/run', {
      messageType: 'private', userId: '12345', nickname: '群友A',
      text: '在吗', mockReply: '在的。 [AFF:+2:友善打招呼]',
    });
    assert.equal(without.body.finalPass, null, '默认不该跑收尾轮');

    const withFinal = await post('/api/sandbox/run', {
      messageType: 'private', userId: '12345', nickname: '群友A',
      text: '在吗', mockReply: '在的。 [AFF:+2:友善打招呼]', runFinalPass: true,
    });
    assert.ok(withFinal.body.finalPass, '勾选后必须给出收尾轮结果');
    assert.match(withFinal.body.finalPass.note, /抑制/, 'test 模式下副作用应被抑制');
  });
});

test('沙箱的执行会被追踪采集器记录，可在 Trace Explorer 里查到', async () => {
  await withPanel({}, async ({ container, post, get }) => {
    const run = await post('/api/sandbox/run', {
      messageType: 'group', groupId: '1', userId: '12345',
      nickname: '群友A', text: '瑞姬在吗', isAtBot: true,
    });

    await flush();
    const detail = await get(`/api/traces/${run.body.correlationId}`);
    assert.equal(detail.status, 200);
    // 上下文聚合与 middleware 都经过了带 observer 的组件
    const categories = detail.body.trace.timeline.map((s) => s.category);
    assert.ok(categories.includes('context'), '应当记录到上下文聚合 span');
    assert.ok(categories.includes('middleware'), '应当记录到 middleware span');
  });
});

test('追踪列表与详情接口连通，清空后归零', async () => {
  await withPanel({}, async ({ post, get }) => {
    await post('/api/sandbox/run', {
      messageType: 'group', groupId: '1', userId: '12345', nickname: '群友A', text: 'hi', isAtBot: true,
    });
    await flush();

    const list = await get('/api/traces?limit=10');
    assert.ok(list.body.items.length >= 1);
    assert.equal(list.body.capacity, 200);

    const missing = await get('/api/traces/不存在的id');
    assert.equal(missing.status, 404);

    await post('/api/traces/clear');
    const cleared = await get('/api/traces');
    assert.equal(cleared.body.total, 0);
  });
});

test('面板路由表不重复且覆盖六大模块', async () => {
  await withPanel({}, async ({ container }) => {
    const routes = container.webServer.listRoutes();
    for (const required of [
      'GET /api/dashboard',
      'GET /api/traces',
      'GET /api/shadow/report',
      'GET /api/affection',
      'POST /api/affection/adjust',
      'GET /api/memes',
      'GET /api/memes/search',
      'POST /api/sandbox/run',
      'GET /api/config',
      'PUT /api/config',
      'POST /api/config/test-model',
    ]) {
      assert.ok(routes.includes(required), `缺少路由 ${required}`);
    }
    assert.equal(new Set(routes).size, routes.length, '路由不得重复');
  });
});

test('配置管理接口支持获取、校验、持久化与热更新', async () => {
  await withPanel({}, async ({ container, get, base }) => {
    // 1. GET /api/config
    const res = await get('/api/config');
    assert.equal(res.status, 200);
    assert.ok(res.body.config);
    assert.ok(res.body.metadata.presets.visionModels.length > 0);
    assert.equal(res.body.config.identity.ownerId, '10000001');
    assert.equal(res.body.config.napcat.inputStatusEnabled, true, '私聊输入状态默认开启');
    assert.equal(res.body.config.identity.ownerTitle, '主人', '未配置时称呼回落默认「主人」');

    // 2. PUT /api/config 校验非法输入
    const badRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wake: { namePattern: '[unclosed-regex' },
      }),
    });
    const badData = await badRes.json();
    assert.equal(badRes.status, 400);
    assert.ok(badData.error.includes('正则'));

    // 3. PUT /api/config 正常更新配置
    const okRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: {
          ownerId: '10000001',
          robotId: '398276230',
          botName: '瑞姬测试版',
          ownerTitle: '饲主大人',
        },
        napcat: {
          wsUrl: res.body.config.napcat.wsUrl,
          httpUrl: res.body.config.napcat.httpUrl,
          inputStatusEnabled: false,
        },
        meme: {
          autoCollect: true,
          autoAiTagging: true,
          visionModel: 'gemini-2.5-flash',
          visionBaseUrl: 'http://127.0.0.1:8868/v1',
          matcherEnabled: false,
          matcherBaseUrl: 'http://127.0.0.1:9999/v1',
          matcherModel: 'matcher-mini',
          matcherMaxRetries: 1,
          matcherCandidateCount: 6,
        },
      }),
    });
    const okData = await okRes.json();
    assert.equal(okRes.status, 200);
    assert.equal(okData.ok, true);

    // 4. 再次获取确认已生效
    const checkRes = await get('/api/config');
    assert.equal(checkRes.body.config.identity.botName, '瑞姬测试版');
    assert.equal(checkRes.body.config.napcat.inputStatusEnabled, false);
    assert.equal(container.config.napcat.inputStatusEnabled, false, '输入状态开关应热生效');
    const savedConfig = JSON.parse(fs.readFileSync(container.config.paths.configFile, 'utf8'));
    assert.equal(savedConfig.napcat.inputStatusEnabled, false, '重启后仍保留输入状态开关');
    assert.equal(checkRes.body.config.identity.ownerTitle, '饲主大人', '自定义称呼应持久化并在读取时回显');
    assert.equal(checkRes.body.config.meme.visionModel, 'gemini-2.5-flash');
    // 后置表情匹配字段：落盘回显 + 生效值回落
    const meme = checkRes.body.config.meme;
    assert.equal(meme.matcherEnabled, false);
    assert.equal(meme.matcherBaseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(meme.matcherModel, 'matcher-mini');
    assert.equal(meme.matcherMaxRetries, 1);
    assert.equal(meme.matcherCandidateCount, 6);
    assert.equal(meme.matcherEffectiveBaseUrl, 'http://127.0.0.1:9999/v1', '配置了专属端点时生效值就是它');
    assert.equal(meme.matcherEffectiveModel, 'matcher-mini');
    // 运行时 config 也热更新（matcherEnabled 热生效）
    assert.equal(container.config.meme.matcherEnabled, false);

    // 4.5 matcher 端点清空后回落 vision 端点
    const fallbackRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meme: { matcherBaseUrl: '', matcherModel: '' },
      }),
    });
    assert.equal(fallbackRes.status, 200);
    const fallbackCheck = await get('/api/config');
    assert.equal(fallbackCheck.body.config.meme.matcherBaseUrl, '');
    assert.equal(
      fallbackCheck.body.config.meme.matcherEffectiveBaseUrl,
      'http://127.0.0.1:8868/v1',
      'matcher 端点留空应回落 vision 端点',
    );
    assert.equal(fallbackCheck.body.config.meme.matcherEffectiveModel, 'gemini-2.5-flash');

    // 4.6 matcher 数值字段校验：非法重试次数 → 400
    const badMatcherRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meme: { matcherMaxRetries: 'abc' },
      }),
    });
    const badMatcherData = await badMatcherRes.json();
    assert.equal(badMatcherRes.status, 400);
    assert.ok(badMatcherData.error.includes('重试次数'), `报错应提及重试次数，实际: ${badMatcherData.error}`);

    // 5. PUT /api/config 设置每日轮转次数：合法值落盘 + 回显 + 热推给活着的 adapter
    const rotRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: {
          baseUrl: 'http://127.0.0.1:8642/v1',
          model: 'hermes-agent',
          sessionRotationsPerDay: 2,
        },
      }),
    });
    assert.equal(rotRes.status, 200);
    const rotCheck = await get('/api/config');
    assert.equal(rotCheck.body.config.model.sessionRotationsPerDay, 2);
    assert.equal(container.modelAdapter.sessionRotationsPerDay, 2, '轮转次数应热推给主 adapter');

    // 6. PUT 非法轮转次数（5 不能整除 24）→ 400
    const badRotRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: {
          baseUrl: 'http://127.0.0.1:8642/v1',
          model: 'hermes-agent',
          sessionRotationsPerDay: 5,
        },
      }),
    });
    const badRotData = await badRotRes.json();
    assert.equal(badRotRes.status, 400);
    assert.ok(badRotData.error.includes('轮转次数'), `报错应提及轮转次数，实际: ${badRotData.error}`);

    // 6.5 PUT decision.queueTimeout：落盘 + 回显 + 热生效（巡检器每次 tick 现读配置）
    const qtRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: { queueTimeout: { enabled: true, timeoutMs: 90000, notice: '⏳ 测试文案' } },
      }),
    });
    assert.equal(qtRes.status, 200);
    const qtCheck = await get('/api/config');
    assert.equal(qtCheck.body.config.decision.queueTimeout.timeoutMs, 90000);
    assert.equal(qtCheck.body.config.decision.queueTimeout.notice, '⏳ 测试文案');
    assert.equal(container.config.decision.queueTimeout.timeoutMs, 90000, '排队超时应热生效到运行态');

    // 6.6 PUT 非法排队超时时长（低于 1 秒）→ 400
    const badQtRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: { queueTimeout: { timeoutMs: 10 } },
      }),
    });
    const badQtData = await badQtRes.json();
    assert.equal(badQtRes.status, 400);
    assert.ok(badQtData.error.includes('排队超时'), `报错应提及排队超时，实际: ${badQtData.error}`);

    // 7. POST /api/config/test-model
    const probeRes = await fetch(`${base}/api/config/test-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'vision',
        baseUrl: 'http://127.0.0.1:8868/v1',
        model: 'gemini-2.5-flash',
      }),
    });
    const probeData = await probeRes.json();
    assert.ok(probeData.latencyMs != null);

    // 8. matcher 类型连通性测试：body 字段留空时回落 vision 字段
    const matcherProbeRes = await fetch(`${base}/api/config/test-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'matcher' }),
    });
    const matcherProbeData = await matcherProbeRes.json();
    assert.ok(matcherProbeData.latencyMs != null);
    // 回落后的实际请求发到了 vision 端点（fetch stub 记录了调用）
    const probeCalls = container.fetchStub.callsTo('8868');
    assert.ok(probeCalls.length >= 2, 'matcher 空字段应回落 vision 端点发起探测');
  });
});

test('请求体超限被拒绝而不是撑爆内存', async () => {
  await withPanel({}, async ({ base }) => {
    const res = await fetch(`${base}/api/sandbox/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }),
    }).catch(() => null);
    // 服务端会在读到上限时 destroy 连接，客户端可能拿到 400 也可能直接断开
    if (res) assert.ok(res.status === 400 || res.status >= 500);
  });
});

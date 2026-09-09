import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PortrayalStore,
  AUTO_ANALYSIS_MSG_INTERVAL,
  AUTO_ANALYSIS_INITIAL_THRESHOLD,
  AUTO_ANALYSIS_COOLDOWN_MS,
  RECENT_MESSAGES_CAP,
  mergeUnique,
} from '../../src/storage/portrayal-store.js';
import {
  PortrayalWorker,
  PORTRAYAL_TEMPLATES,
  DEFAULT_ANALYSIS_LIMIT,
} from '../../src/orchestration/portrayal-worker.js';
import { makeTempDir, cleanupDir, createTestLogger } from '../helpers.js';

test('PortrayalStore 基础存储与增量自动分析判定', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const baseTime = Date.parse('2026-08-25T10:00:00Z');
  let now = baseTime;
  const store = new PortrayalStore({
    file: path.join(tmp, 'profiles.json'),
    persistEnabled: true,
    logger: createTestLogger(),
    now: () => now,
  });

  const UID = '2260757842';

  // 1. 发言未达初始门槛 (20)
  for (let i = 0; i < 15; i++) {
    store.recordUserMessage(UID, '御娘狼三千');
  }
  assert.equal(store.needsAutoAnalysis(UID), false);

  // 2. 达到初始门槛 (20)
  for (let i = 0; i < 5; i++) {
    store.recordUserMessage(UID, '御娘狼三千');
  }
  assert.equal(store.needsAutoAnalysis(UID), true);

  // 3. 执行一次画像保存
  store.setProfile(UID, {
    nickname: '御娘狼三千',
    tags: ['二次元', '乐子人', '搜图狂'],
    summary: '活跃群友，爱发怪图',
    taboos: '忌严肃说教',
    suggestion: '顺着接梗互怼',
  });

  // 分析后处于 24h 冷却期中
  assert.equal(store.needsAutoAnalysis(UID), false);

  // 4. 24小时后但发言增量不足 50 条
  now = baseTime + AUTO_ANALYSIS_COOLDOWN_MS + 1000;
  for (let i = 0; i < 30; i++) {
    store.recordUserMessage(UID, '御娘狼三千');
  }
  assert.equal(store.needsAutoAnalysis(UID), false);

  // 5. 发言增量满 50 条
  for (let i = 0; i < 20; i++) {
    store.recordUserMessage(UID, '御娘狼三千');
  }
  assert.equal(store.needsAutoAnalysis(UID), true);

  // 6. 精炼单行上下文提取
  const compact = store.getCompactContext(UID);
  assert.ok(compact.includes('画像: 二次元/乐子人/搜图狂'));
  assert.ok(compact.includes('雷区: 忌严肃说教'));
  assert.ok(compact.includes('建议: 顺着接梗互怼'));
});

test('PortrayalWorker 模版完整性与 JSON 解析', async () => {
  assert.ok(PORTRAYAL_TEMPLATES.auto_json.includes('tags'));
  assert.ok(PORTRAYAL_TEMPLATES.auto_json.includes('增量校准'));
  assert.ok(PORTRAYAL_TEMPLATES.auto_json.includes('防污染与主语界定原则'));
  assert.ok(PORTRAYAL_TEMPLATES.portrait.includes('相处建议'));
  assert.ok(PORTRAYAL_TEMPLATES.positive.includes('优势导向'));
  assert.ok(PORTRAYAL_TEMPLATES.negative.includes('缺点'));
  assert.ok(PORTRAYAL_TEMPLATES.clone.includes('克隆'));
  assert.ok(PORTRAYAL_TEMPLATES.match.includes('红娘'));

  const worker = new PortrayalWorker({
    portrayalStore: null,
    modelRouter: null,
    logger: createTestLogger(),
  });

  const parsed = worker._extractJson('```json\n{"tags": ["测试"], "summary": "概述"}\n```');
  assert.deepEqual(parsed.tags, ['测试']);
  assert.equal(parsed.summary, '概述');
});

test('PortrayalWorker analyzeProfileJson 支持增量旧画像注入', async () => {
  let capturedRequest = null;
  const mockModels = {
    generate: async (req) => {
      capturedRequest = req;
      return {
        rawText: JSON.stringify({
          tags: ['技术流', '热心'],
          summary: '性格理性，经常解答群友问题',
          taboos: '反感无意义刷屏',
          suggestion: '多探讨技术和实用话题',
        }),
      };
    },
  };

  const store = new PortrayalStore({
    file: null,
    persistEnabled: false,
    logger: createTestLogger(),
  });
  const UID = '123456';
  store.setProfile(UID, {
    nickname: '测试群友',
    tags: ['初级群友'],
    summary: '刚进群不久',
    taboos: '忌粗暴打断',
    suggestion: '友好引导',
  });

  const worker = new PortrayalWorker({
    portrayalStore: store,
    modelRouter: mockModels,
    logger: createTestLogger(),
  });

  const result = await worker.analyzeProfileJson({
    userId: UID,
    nickname: '测试群友',
    messages: ['测试群友: 大家好，我来请教个问题', '测试群友: 这个报错如何解决'],
  });

  assert.deepEqual(result.tags, ['技术流', '热心']);
  assert.ok(capturedRequest, '生成请求已被捕获');
  const userPrompt = capturedRequest.messages.find((m) => m.role === 'user')?.content || '';
  const sysPrompt = capturedRequest.messages.find((m) => m.role === 'system')?.content || '';
  assert.ok(userPrompt.includes('【该群友已有画像认知（此前积累，供参考与增量演进）】'), 'Prompt 中应注入既有画像');
  assert.ok(userPrompt.includes('既有标签: 初级群友'));
  assert.ok(userPrompt.includes('敏感/避坑点: 忌粗暴打断'));
  assert.ok(sysPrompt.includes('严禁将瑞姬的人设雷区直接扣给群友'), 'System Prompt 应包含防污染指示');
});

test('分析门槛可由配置覆盖，非法值回落默认', (t) => {
  const tmp = makeTempDir();
  t.after(() => cleanupDir(tmp));

  const mk = (opts) => new PortrayalStore({
    file: path.join(tmp, `cfg-${Math.abs(JSON.stringify(opts).length)}-${opts.initialThreshold ?? 'x'}.json`),
    persistEnabled: false,
    logger: createTestLogger(),
    ...opts,
  });

  // 配置生效：首次分析门槛降到 3 条
  const low = mk({ initialThreshold: 3, msgInterval: 5, cooldownMs: 1000 });
  const UID = '999';
  low.recordUserMessage(UID, '甲', '一');
  low.recordUserMessage(UID, '甲', '二');
  assert.equal(low.needsAutoAnalysis(UID), false, '2 条还不够');
  low.recordUserMessage(UID, '甲', '三');
  assert.equal(low.needsAutoAnalysis(UID), true, '达到自定义门槛 3');

  // 非法值（0 / 负数 / NaN）一律回落默认，避免每条发言都触发分析
  for (const bad of [0, -5, Number.NaN, null, undefined, 'abc']) {
    const s = mk({ initialThreshold: bad, msgInterval: bad, cooldownMs: bad });
    assert.equal(s.initialThreshold, AUTO_ANALYSIS_INITIAL_THRESHOLD, `initialThreshold=${bad} 应回落`);
    assert.equal(s.msgInterval, AUTO_ANALYSIS_MSG_INTERVAL, `msgInterval=${bad} 应回落`);
    assert.equal(s.cooldownMs, AUTO_ANALYSIS_COOLDOWN_MS, `cooldownMs=${bad} 应回落`);
  }

  // 收纳上限至少要跟得上 msgInterval，否则调大间隔反而喂不满模型
  const wide = mk({ msgInterval: 120 });
  assert.equal(wide.maxRecentMessages, 120);
  const narrow = mk({ msgInterval: 10 });
  assert.equal(narrow.maxRecentMessages, RECENT_MESSAGES_CAP, '不低于默认收纳上限');
});

test('mergeUnique 保序去重且就地修改', () => {
  const target = ['a', 'b'];
  const out = mergeUnique(target, ['b', 'c', 'c', 'd']);
  assert.equal(out, target, '返回的就是同一个数组');
  assert.deepEqual(target, ['a', 'b', 'c', 'd']);
  assert.deepEqual(mergeUnique([], null), [], 'incoming 为空不炸');
});

test('_collectMessages 按 limit 截最新，并对种子列表去重', () => {
  const worker = new PortrayalWorker({
    portrayalStore: null,
    modelRouter: null,
    logger: createTestLogger(),
  });

  assert.deepEqual(
    worker._collectMessages({ userId: '1', nickname: 'x', messages: ['a', 'b', 'c', 'd'], limit: 2 }),
    ['c', 'd'],
    '保留最新的 limit 条',
  );
  assert.deepEqual(
    worker._collectMessages({ userId: '1', nickname: 'x', messages: ['a', 'a', 'b'], limit: 10 }),
    ['a', 'b'],
  );
  assert.deepEqual(
    worker._collectMessages({ userId: '1', nickname: '御娘狼三千', messages: [], limit: 10 }),
    ['御娘狼三千: （暂无发言记录）'],
    '完全没记录时给个兜底占位',
  );
  assert.equal(
    worker._collectMessages({ userId: '1', nickname: 'x', messages: Array.from({ length: 120 }, (_, i) => `m${i}`) }).length,
    DEFAULT_ANALYSIS_LIMIT,
    '不传 limit 时用默认值',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSystemText,
  renderUserContent,
  renderUserMessage,
  renderLocalMediaHint,
  formatMsgTime,
  groupBySlot,
  TRIGGER_NOTICES,
  QQ_TOOLS_NOTICE,
  AFF_MARKER_RULE,
} from '../../src/orchestration/prompt-renderer.js';
import { mergeBatch } from '../../src/orchestration/inbound-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createContextBlock } from '../../src/contracts/context-block.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { loadFixture } from '../helpers.js';

const IDENTITY = { ownerId: '10000001', robotId: '398276230', botName: '瑞姬' };

function makeInbound(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c1',
    messageId: '1',
    timestamp: 1787435231,
    userId: '10000001',
    groupId: '707423412',
    messageType: 'group',
    content: '@瑞姬  我要和你对话十次，你回个OK即可',
    sender: { nickname: 'ruaji(阵亡)', card: '', displayName: 'ruaji(阵亡)' },
    ...overrides,
  });
}

test('formatMsgTime 用 OneBot event time 而非当前时间，按上海时区', () => {
  assert.equal(formatMsgTime(1787435231), '2026/8/23 05:47:11');
  assert.equal(formatMsgTime(1787435231000), '2026/8/23 05:47:11', '毫秒同样处理');
  assert.match(formatMsgTime(null), /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
  assert.match(formatMsgTime('not-a-number'), /^\d{4}\//);
});

test('groupBySlot 按 slot 分组，未知 slot 归到 extra', () => {
  const slots = groupBySlot([
    createContextBlock({ source: 'a', text: 'V', metadata: { slot: 'voice' } }),
    createContextBlock({ source: 'b', text: 'S', metadata: { slot: 'slang' } }),
    createContextBlock({ source: 'c', text: 'X' }),
  ]);
  assert.equal(slots.voice, 'V');
  assert.equal(slots.slang, 'S');
  assert.equal(slots.extra, 'X');
});

test('groupBySlot 的未知 slot 兜底不会被 Object.prototype 击穿', () => {
  // 回归：原实现是 (slots[slot] ?? slots.extra).push(...)。slot 来自远程 Provider
  // 的 JSON，'constructor'/'toString' 这类值会从 Object.prototype 取到函数，
  // ?? 兜不住，.push 当场抛 TypeError，整轮回复直接失败。
  for (const slot of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const slots = groupBySlot([createContextBlock({ source: 'gcp', text: 'X', metadata: { slot } })]);
    assert.equal(slots.extra, 'X', `slot=${slot} 应归到 extra`);
  }
});

test('远程 Provider 送来原型链 slot 名时 renderSystemText 不崩（meme 槽位已移除，归到 extra）', () => {
  const systemText = renderSystemText({
    inbound: makeInbound(),
    contextBlocks: [
      createContextBlock({ source: 'gcp', text: '[远程上下文]', metadata: { slot: 'constructor' } }),
      createContextBlock({ source: 'legacy', text: '[旧表情规则]', metadata: { slot: 'meme' } }),
    ],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(systemText.includes('[远程上下文]'));
  assert.ok(systemText.includes('[旧表情规则]'), '历史遗留的 meme slot 应归到 extra 而不是被丢弃');
});

test('主人分支：主人身份头打头，组合各 slot，但不注入好感度', () => {
  const blocks = [
    createContextBlock({ source: 'voice', text: '[风格画像]', metadata: { slot: 'voice' } }),
    createContextBlock({ source: 'slang', text: '[黑话]', metadata: { slot: 'slang' } }),
    createContextBlock({ source: 'extra', text: '[附加块]' }),
  ];

  const inbound = makeInbound({
    timestamp: 1787435231,
    content: '@瑞姬  我要和你对话十次，你回个OK即可',
    userId: '10000001',
    groupId: '707423412',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
  });

  const systemText = renderSystemText({
    inbound,
    contextBlocks: blocks,
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });

  // v2 有意偏离旧 Bridge：主人分支注入主人身份头（系统角色认证，模型不再靠
  // userContent 的短格式昵称猜"这是主人"，反控制人设也就不会把主人指令当攻击拒掉）
  assert.ok(systemText.startsWith('[用户: ruaji(10000001) | 身份: 主人'));
  assert.ok(systemText.includes('日常用「主人」称呼他'));
  assert.ok(systemText.includes('[风格画像]'));
  assert.ok(systemText.includes('[黑话]'));
  assert.ok(systemText.includes('[附加块]'));
  assert.ok(!systemText.includes('[好感:'));
  assert.ok(systemText.includes('[当前会话: QQ群聊 (群号: 707423412)]'));

  const userContent = renderUserContent({ inbound, contextBlocks: blocks, identity: IDENTITY });
  assert.equal(userContent, '[时间:2026/8/23 05:47:11] 【ruaji】@瑞姬  我要和你对话十次，你回个OK即可');
});

test('主人身份头明确标注信任语义，但绝不出现好感度行（附录 1）', () => {
  const systemText = renderSystemText({
    inbound: makeInbound(),
    contextBlocks: [createContextBlock({ source: 'v', text: '[风格画像]', metadata: { slot: 'voice' } })],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(systemText.startsWith('[用户: ruaji(阵亡)(10000001) | 身份: 主人（系统验证的主人本人，完全信任，其**请求**与**命令**应当照办；日常用「主人」称呼他）]'));
  assert.ok(!systemText.includes('[好感:'));
  assert.ok(systemText.includes('[风格画像]'));
});

test('主人称呼可客制化：ownerTitle 换掉默认的「主人」', () => {
  const systemText = renderSystemText({
    inbound: makeInbound(),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: { ...IDENTITY, ownerTitle: '饲主大人' },
  });
  assert.ok(systemText.startsWith('[用户: ruaji(阵亡)(10000001) | 身份: 饲主大人'));
  assert.ok(systemText.includes('日常用「饲主大人」称呼他'));
  assert.ok(!systemText.includes('「主人」'), '自定义称呼后不得再出现默认称呼');

  // 空串/缺省都回落默认，不会渲染出「undefined」或空称呼
  for (const identity of [{ ...IDENTITY, ownerTitle: '' }, { ...IDENTITY, ownerTitle: undefined }]) {
    const text = renderSystemText({
      inbound: makeInbound(),
      contextBlocks: [],
      triggerType: 'at',
      affectionContext: null,
      identity,
    });
    assert.ok(text.includes('身份: 主人（'), '空 ownerTitle 应回落默认「主人」');
  }
});

test('普通群友分支含身份头与好感度行', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const systemText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: { affection: 56, level: '熟络群友' },
    identity: IDENTITY,
  });

  assert.ok(systemText.startsWith('[用户: 御娘狼三千(2260757842) | 群707423412]'));
  assert.ok(systemText.includes(`[好感: 56/90 (熟络群友) | ${AFF_MARKER_RULE}]`));
  // 评估量纲与标准并入 affLine 后，SOUL.md 的 <affection_eval> 整块可删：
  // 这里守住量纲措辞不被顺手砍掉。
  assert.ok(AFF_MARKER_RULE.includes('N取-5~+5'));
  assert.ok(AFF_MARKER_RULE.includes('走心交流+3~5'));
  assert.ok(AFF_MARKER_RULE.includes('纯水消息0'));
});

test('冷暴力与好感度上下限约束动态注入 Prompt（Favour_Ultra 特性）', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });

  // 冷暴力状态
  const coldText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: 15,
      level: '陌生人',
      isColdViolent: true,
      coldRemainingMinutes: 45,
    },
    identity: IDENTITY,
  });
  assert.ok(coldText.includes('状态: ❄️冷暴力惩罚中(剩余45分)'));
  assert.ok(coldText.includes('态度需极度冷淡疏离、极简敷衍'));

  // 好感已达上限 90
  const maxText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: 90,
      level: '挚友',
      atMax: true,
    },
    identity: IDENTITY,
  });
  assert.ok(maxText.includes('当前好感已达上限90，禁止输出正向加分，仅允许[AFF:0|...]持平或负向扣分'));

  // 好感已达下限 -100
  const minText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: -100,
      level: '死敌',
      atMin: true,
    },
    identity: IDENTITY,
  });
  assert.ok(minText.includes('当前好感已达下限-100，无法继续扣分'));

  // 负好感警戒区与画像复合注入
  const negText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: -35,
      level: '嫌弃',
      relationship: '嫌弃',
      is_unique: false,
      portrayal: '画像: 暴躁/杠精 | 雷区: 忌反驳',
    },
    identity: IDENTITY,
  });
  assert.ok(negText.includes('状态: 负好感警戒区，态度需戒备、冷漠或带刺'));
  assert.ok(negText.includes('[画像: 暴躁/杠精 | 雷区: 忌反驳]'));
});

test('私聊身份头显示"私聊"', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    groupId: null,
    messageType: 'private',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const systemText = renderSystemText({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(systemText.startsWith('[用户: 御娘狼三千(2260757842) | 私聊]'));
});

test('三段 triggerNotice 逐字保留，且只在群聊注入', () => {
  const inbound = makeInbound();
  // 会话环境标注、知识认知与 QQ 工具能力标注排在 triggerNotice 之后，是 systemText 的最后三段。
  // 断言整条尾巴而不是 includes —— 只断言"存在"的话，谁把 triggerNotice 挪到中间都发现不了。
  const sessionEnv = `\n[当前会话: QQ群聊 (群号: ${inbound.groupId})]`;
  const knowledgeNotice =
    '\n[知识与工具认知: 你的底层数据库存在时效延后，且并非全知全能。遇到不确定、具有时效性或涉及具体事实/机制的提问时，必须主动使用搜索工具与群聊记忆检索，以获取最新且准确的真实信息，切勿凭空编造。]';
  for (const trigger of ['at', 'keyword', 'ai_decision']) {
    const systemText = renderSystemText({
      inbound,
      contextBlocks: [],
      triggerType: trigger,
      affectionContext: null,
      identity: IDENTITY,
    });
    assert.ok(
      systemText.endsWith(TRIGGER_NOTICES[trigger] + sessionEnv + knowledgeNotice + QQ_TOOLS_NOTICE),
      `${trigger} 的情境提示应当逐字保留，且紧跟在会话环境标注、知识认知与QQ工具能力标注之前`,
    );
  }

  const privateText = renderSystemText({
    inbound: makeInbound({ messageType: 'private', groupId: null }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(!privateText.includes('[交互情境'), '私聊不注入情境提示');
  assert.ok(
    privateText.endsWith('\n[当前会话: QQ私聊]' + knowledgeNotice + QQ_TOOLS_NOTICE),
    '私聊也带会话环境、知识认知与QQ工具能力标注',
  );
});

test('QQ工具能力标注注入所有分支', () => {
  // 不点名具体工具名（清单由 MCP tools/list 负责），只覆盖核心场景措辞。
  assert.ok(QQ_TOOLS_NOTICE.includes('调工具查证'), 'QQ_TOOLS_NOTICE 应包含查证指引');

  const cases = [
    { userId: '10000001', triggerType: 'at' }, // 主人
    { userId: '2260757842', triggerType: 'at' }, // 普通群友
    { userId: '2260757842', triggerType: 'ai_decision' }, // 主动接话
  ];
  for (const c of cases) {
    const systemText = renderSystemText({
      inbound: makeInbound({ userId: c.userId }),
      contextBlocks: [],
      triggerType: c.triggerType,
      affectionContext: null,
      identity: IDENTITY,
    });
    assert.ok(systemText.includes(QQ_TOOLS_NOTICE), `${c.triggerType}/${c.userId} 分支都注入 QQ 工具能力标注`);
  }
});

test('主动接话：不注入任何身份头也不注入好感度', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const systemText = renderSystemText({
    inbound,
    contextBlocks: [createContextBlock({ source: 'v', text: '[风格画像]', metadata: { slot: 'voice' } })],
    triggerType: 'ai_decision',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(!systemText.includes('[用户:'));
  assert.ok(!systemText.includes('[好感:'));
});

test('userContent：主人显示【昵称】，非主人显示【昵称 (ID: uid)】', () => {
  const owner = renderUserContent({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY });
  assert.ok(owner.includes('【ruaji(阵亡)】'));
  assert.ok(!owner.includes('(ID:'));

  const other = renderUserContent({
    inbound: makeInbound({
      userId: '2260757842',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    contextBlocks: [],
    identity: IDENTITY,
  });
  assert.ok(other.includes('【御娘狼三千 (ID: 2260757842)】'));
});

test('群聊上下文以 [最近群聊消息] 前缀注入 userContent', () => {
  const out = renderUserContent({
    inbound: makeInbound(),
    contextBlocks: [
      createContextBlock({ source: 'gcp', text: '[05:40:00] linyuan: 在吗', metadata: { slot: 'recent' } }),
    ],
    identity: IDENTITY,
  });
  assert.ok(out.startsWith('[最近群聊消息]\n[05:40:00] linyuan: 在吗\n\n[时间:'));
});

test('带图片时 userMessage 变成多模态 parts，优先用 URL', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', url: 'https://x/y.png', localPath: 'F:/a.png' }],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].image_url.url, 'https://x/y.png');
});

test('没有 URL 时退回本地 file URI', () => {
  const inbound = makeInbound({ media: [{ kind: 'image', localPath: 'F:\\received_images\\a.png' }] });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(parts[1].image_url.url, 'file:///F:/received_images/a.png');
});

test('本地媒体清单把绝对路径告诉模型（附录 2）', () => {
  const hint = renderLocalMediaHint({
    media: [
      { kind: 'image', localPath: 'F:/received_images/a.png' },
      { kind: 'file', localPath: 'F:/received_files/Player.log' },
    ],
  });
  assert.ok(hint.includes('F:/received_images/a.png'));
  assert.ok(hint.includes('F:/received_files/Player.log'));
  assert.equal(renderLocalMediaHint({ media: [] }), '');
});

// ===== P1：防抖合并批次的逐条渲染 =====

const STUB_DECISION = { route: 'direct', triggerType: 'at', reason: 'stub', providerId: null };

function makeBatchItem(overrides = {}) {
  return {
    inbound: createInboundMessage({
      correlationId: 'c1',
      messageId: 'm1',
      timestamp: 1787435231,
      userId: '10000001',
      groupId: '707423412',
      messageType: 'group',
      content: 'hello',
      sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
      ...overrides,
    }),
    decision: STUB_DECISION,
  };
}

test('P1 修复：batch 逐条渲染，一行一条各标各的名', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '瑞姬看看这个',
      sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '对，就是这个',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  const lines = out.split('\n');

  assert.equal(lines.length, 2, '两条消息应渲染成两行');
  assert.ok(lines[0].includes('【qqqq819_01 (ID: 2260757842)】'), '第一行必须标 qqqq819_01 自己的名');
  assert.ok(lines[0].includes('瑞姬看看这个'), '第一行必须是 qqqq819_01 的话');
  assert.ok(lines[1].includes('【三²哒锅酱 (ID: 3382710099)】'), '第二行必须标三²哒锅酱自己的名');
  assert.ok(lines[1].includes('对，就是这个'), '第二行必须是三²哒锅酱的话');
});

test('batch 末条为主人：主人行短格式【昵称】，群友行带 ID', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '群友的话',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '10000001',
      content: '主人补一句',
      sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  const lines = out.split('\n');

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('【御娘狼三千 (ID: 2260757842)】'), '群友行带 ID');
  assert.ok(lines[1].includes('【ruaji】'), '主人行短格式');
  assert.ok(!lines[1].includes('(ID:'), '主人行不能带 ID');
  assert.ok(lines[1].includes('主人补一句'));
});

test('无 batch（单条）旧格式逐字节不变（回归）', () => {
  const owner = renderUserContent({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY });
  assert.equal(owner, '[时间:2026/8/23 05:47:11] 【ruaji(阵亡)】@瑞姬  我要和你对话十次，你回个OK即可');

  const other = renderUserContent({
    inbound: makeInbound({
      userId: '2260757842',
      content: '你好',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    contextBlocks: [],
    identity: IDENTITY,
  });
  assert.equal(other, '[时间:2026/8/23 05:47:11] 【御娘狼三千 (ID: 2260757842)】你好');

  // 防御：长度为 1 的 batch 数组不改变单条渲染（mergeBatch 不产生这种形态）
  const singleBatch = makeInbound({
    extensions: {
      batch: [{ messageId: 'm1', timestamp: 1787435231, userId: '10000001', displayName: 'ruaji(阵亡)', content: 'x' }],
    },
  });
  assert.equal(
    renderUserContent({ inbound: singleBatch, contextBlocks: [], identity: IDENTITY }),
    '[时间:2026/8/23 05:47:11] 【ruaji(阵亡)】@瑞姬  我要和你对话十次，你回个OK即可',
  );
});

test('batch 里的空正文（纯媒体消息）不占行', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '看这张图',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(out.split('\n').length, 1, '空正文不该渲染出一个只有名字的空行');
  assert.ok(out.includes('【三²哒锅酱 (ID: 3382710099)】看这张图'));
  assert.ok(!out.includes('御娘狼三千'));
});

test('整批都没有正文时退回末条身份的单行格式，不产出空串', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({ messageId: 'm1', content: '' }),
    makeBatchItem({
      messageId: 'm2',
      content: '',
      userId: '2260757842',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(out, '[时间:2026/8/23 05:47:11] 【御娘狼三千 (ID: 2260757842)】');
});

test('[最近群聊消息] 整批排除：触发文本每句话只出现一次（与滑窗排除联动）', () => {
  const sessions = new SessionStore({ windowSize: 15 });
  const sessionId = 'qq:group:707423412';
  // recordToWindow 的等价写入：批次里的每条都已入窗，另有一条无关旧消息
  sessions.recordContext(sessionId, { messageId: 'm0', nickname: 'linyuan', text: '更早的一句', userId: '111' });
  sessions.recordContext(sessionId, { messageId: 'm1', nickname: 'qqqq819_01', text: '瑞姬看看这个', userId: '2260757842' });
  sessions.recordContext(sessionId, { messageId: 'm2', nickname: '三²哒锅酱', text: '对，就是这个', userId: '3382710099' });

  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '瑞姬看看这个',
      sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '对，就是这个',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const recent = sessions.renderContext(
    sessionId,
    15,
    inbound.extensions.batch.map((b) => b.messageId),
  );
  const out = renderUserContent({
    inbound,
    contextBlocks: [createContextBlock({ source: 'local-window', text: recent, metadata: { slot: 'recent' } })],
    identity: IDENTITY,
  });

  assert.ok(out.startsWith('[最近群聊消息]'));
  assert.ok(out.includes('更早的一句'), '无关旧消息应保留在滑窗里');
  assert.ok(!recent.includes('瑞姬看看这个'), '先到的批次消息不该留在滑窗里');
  assert.ok(!recent.includes('对，就是这个'), '末条消息不该留在滑窗里');
  assert.equal(out.split('瑞姬看看这个').length - 1, 1, '触发文本中的话不应以滑窗形式重复出现');
  assert.equal(out.split('对，就是这个').length - 1, 1);
});

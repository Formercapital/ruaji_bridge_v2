/**
 * tests/unit/wake-relay-prompt.test.js — 委派转述唤醒提示词的「防重复注入」契约
 *
 * 背景（真实事故）：Hermes 原生已经把完整子代理汇报以 async_delegation_complete 的
 * user 行持久化进会话；桥接的唤醒轮早期又把整份报告当 {notice} 拼进提示词再 POST 一遍，
 * 于是模型上下文里连续堆了两份一模一样的长报告，纯烧 token。
 *
 * 这里的铁律只有一条：**提示词里绝不出现报告正文**，只允许 deleg id 这种短引用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DELEGATION_RELAY_PROMPT,
  RELAY_NOTICE_REFERENCE,
  renderDelegationRelayPrompt,
} from '../../src/orchestration/wake-flow.js';

const RAW_REPORT = 'INTERNAL REPORT: 2000 字技术报告正文\n第二段还有一大坨细节';
const delegationText = `[ASYNC DELEGATION BATCH COMPLETE — deleg_57043573]\n--- RESULT ---\n${RAW_REPORT}`;

test('默认提示词是极简提示：带 deleg id，不带报告正文', () => {
  const prompt = renderDelegationRelayPrompt(delegationText, {});
  assert.match(prompt, /deleg_57043573/);
  assert.equal(prompt.includes(RAW_REPORT), false, '不得内嵌报告正文');
  assert.equal(prompt.includes('INTERNAL REPORT'), false, '不得内嵌报告正文');
  assert.equal(prompt.includes('{ref}'), false, '占位符必须被替换');
  assert.equal(prompt.includes('{notice}'), false, '默认模板本就不该有 {notice}');
  assert.ok(prompt.length < DEFAULT_DELEGATION_RELAY_PROMPT.length + 40);
});

test('历史自定义模板里的 {notice} 也只替换成短引用，绝不回退成正文', () => {
  const legacy = {
    prompt: '（内部机制提示）后台子任务跑完了，原始汇报如下：\n{notice}',
  };
  const prompt = renderDelegationRelayPrompt(delegationText, legacy);
  assert.match(prompt, /deleg_57043573/);
  assert.equal(prompt.includes('INTERNAL REPORT'), false, '历史模板也不允许把正文塞回来');
  assert.equal(prompt.includes('{notice}'), false);
  assert.equal(prompt.includes('原始汇报如下：\n[ASYNC DELEGATION'), false);
});

test('自定义模板没有占位符时不追加任何内容', () => {
  const prompt = renderDelegationRelayPrompt(delegationText, { prompt: '请把上一条后台汇报转述给对方。' });
  assert.equal(prompt, '请把上一条后台汇报转述给对方。');
});

test('抠不到 deleg id 时 {notice} 换成指向上下文的短引用', () => {
  const prompt = renderDelegationRelayPrompt('没有 id 的内部汇报', {
    prompt: '（内部机制提示）原文：{notice}',
  });
  assert.equal(prompt, `（内部机制提示）原文：${RELAY_NOTICE_REFERENCE}`);
  assert.equal(prompt.includes('没有 id 的内部汇报'), false);
});

test('{ref} 在自定义模板里替换为带括号的 deleg id', () => {
  const prompt = renderDelegationRelayPrompt(delegationText, { prompt: '唤醒{ref}，请转述。' });
  assert.equal(prompt, '唤醒（deleg_57043573），请转述。');
});

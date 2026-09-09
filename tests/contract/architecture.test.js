/**
 * tests/contract/architecture.test.js — 架构边界静态扫描
 *
 * 这些测试不跑逻辑，只读源码。它们守住的是几条一旦破掉就很难再修回来的边界：
 *   验收标准 5   主流程不写死插件名称与地址
 *   验收标准 9   模型调用只通过 Model Adapter
 *   验收标准 13  Wiki 不存在于 v2 运行时链路
 *   验收标准 1   v2 不依赖旧 Bridge 的运行时
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const SRC = path.join(ROOT, 'src');

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const ALL_SOURCES = listSourceFiles(SRC);
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 去掉注释后再扫，避免注释里引用旧代码位置被误判 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('主流程与核心层不出现硬编码的插件地址（验收标准 5）', () => {
  // core/config.js 例外：NapCat 与模型是 v2 的一等公民依赖，不是插件，
  // 它们的安全默认值本来就该写在配置层。
  const EXEMPT = new Set(['src/core/config.js']);

  const guarded = ALL_SOURCES.filter((f) => {
    const r = rel(f);
    if (EXEMPT.has(r)) return false;
    return r.startsWith('src/orchestration/') || r.startsWith('src/core/') || r.startsWith('src/middleware/');
  });
  assert.ok(guarded.length > 0, '应当扫到文件');

  const offenders = [];
  for (const file of guarded) {
    const code = stripComments(read(file));
    const hits = code.match(/(127\.0\.0\.1|localhost):\d+/g);
    if (hits) offenders.push(`${rel(file)}: ${[...new Set(hits)].join(', ')}`);
  }
  assert.deepEqual(offenders, [], '插件地址只能出现在 manifest 配置里');
});

test('主流程不出现具体插件 id（验收标准 5）', () => {
  const pluginIds = ['group-chat-plus', 'living-memory', 'self-learning-upstream', 'mem0-vector', 'cpa-aux-model'];
  const guarded = ALL_SOURCES.filter((f) => rel(f).startsWith('src/orchestration/'));

  const offenders = [];
  for (const file of guarded) {
    const code = stripComments(read(file));
    for (const id of pluginIds) {
      if (code.includes(`'${id}'`) || code.includes(`"${id}"`)) offenders.push(`${rel(file)} 引用了 ${id}`);
    }
  }
  assert.deepEqual(offenders, [], '编排层只能依赖能力名，不能依赖插件名');
});

test('只有 model adapter 能碰 chat/completions（验收标准 9）', () => {
  const allowed = ['src/adapters/model/openai-compatible.js'];
  const offenders = [];
  for (const file of ALL_SOURCES) {
    if (allowed.includes(rel(file))) continue;
    const code = stripComments(read(file));
    if (code.includes('chat/completions')) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], '模型调用必须走 Model Adapter');
});

test('运行时链路里没有 Wiki（验收标准 13）', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const code = stripComments(read(file));
    if (/\bwiki\b/i.test(code)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], 'Wiki 已明确移除，不得出现在 v2 源码中');
});

test('不引用旧 Bridge 的任何模块（验收标准 1）', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const code = stripComments(read(file));
    // 只看 import / require 语句，注释与文档字符串不算
    const statements = code.match(/(?:import\s[^;]*?from\s*|require\()\s*['"]([^'"]+)['"]/g) ?? [];
    for (const statement of statements) {
      const specifier = /['"]([^'"]+)['"]/.exec(statement)?.[1];
      if (!specifier) continue;
      if (!specifier.startsWith('.')) {
        // 裸模块只允许 node: 内建与 package.json 里声明的依赖
        if (!specifier.startsWith('node:') && specifier !== 'ws') {
          offenders.push(`${rel(file)}: 引用了未声明的模块 ${specifier}`);
        }
        continue;
      }
      // 相对路径必须解析到 v2 项目内部
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(SRC)) {
        offenders.push(`${rel(file)}: 相对引用逃出了 src/ → ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'v2 必须是独立项目，不得 import 旧 Bridge 的任何模块');
});

test('不出现 Live2D 同步（明确移除项）', () => {
  const offenders = ALL_SOURCES.filter((f) => /live2d/i.test(stripComments(read(f))));
  assert.deepEqual(offenders.map(rel), []);
});

test('不出现 OpenClaw 兼容分支（明确移除项）', () => {
  const offenders = ALL_SOURCES.filter((f) => /openclaw/i.test(stripComments(read(f))));
  assert.deepEqual(offenders.map(rel), []);
});

test('源码里不出现任何真实密钥', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const code = read(file);
    if (/sk-[A-Za-z0-9]{16,}/.test(code)) offenders.push(`${rel(file)}: 疑似 sk- 密钥`);
    // 旧 config.json 里明文存过的 Hermes key 形态
    if (/[A-Za-z0-9_-]{40,}\b/.test(code) && /apiKey\s*[:=]\s*['"][A-Za-z0-9_-]{20,}/.test(code)) {
      offenders.push(`${rel(file)}: 疑似明文 apiKey`);
    }
  }
  assert.deepEqual(offenders, [], '密钥只能来自环境变量');
});

test('配置样例里没有明文密钥，只有 *Env 引用', () => {
  const raw = read(path.join(ROOT, 'bridge.config.example.json'));
  const example = JSON.parse(raw);
  assert.ok(example.napcat.accessTokenEnv, 'NapCat token 必须走环境变量');
  assert.ok(example.model.apiKeyEnv, '模型密钥必须走环境变量');
  assert.equal(example.napcat.accessToken, undefined);
  assert.equal(example.model.apiKey, undefined);
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(raw));
});

test('配置样例默认是 live 模式且允许发送与副作用', () => {
  const example = JSON.parse(read(path.join(ROOT, 'bridge.config.example.json')));
  assert.equal(example.mode, 'live');
  assert.equal(example.reply.sendEnabled, true);
  assert.equal(example.reply.sideEffectsEnabled, true);
});

test('所有 src 文件都是 ESM（有 import 或 export）', () => {
  const offenders = ALL_SOURCES.filter((f) => {
    const code = read(f);
    return !/^\s*(import|export)\s/m.test(code) && !code.includes('#!/usr/bin/env node');
  });
  assert.deepEqual(offenders.map(rel), []);
});

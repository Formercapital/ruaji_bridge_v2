#!/usr/bin/env node
/**
 * scripts/verify-wake-e2e.js — 异步唤醒回推的端到端验证工具
 *
 * 干的事：用**桥接自己的生产代码**（HermesSessionApi + WakeFlow + wake-extractor +
 * response.notice 管线 + 发送队列）去读一个真实 Hermes 的会话 transcript，把后台任务
 * 完成通知取回来并打印"会推到哪个 QQ、推什么"。发送强制走 dry-run（sendEnabled=false），
 * 所以验证过程中不会有任何消息真的发到 QQ。
 *
 * 前置：目标 Hermes 端已开
 *   platforms.api_server.extra.async_delivery: true
 * 并在其会话里跑过一次带 notify_on_complete 的后台任务（见下方"完整验证"）。
 *
 * 用法：
 *   HERMES_E2E_BASE_URL=http://127.0.0.1:8699/v1 \
 *   HERMES_E2E_KEY=<API key> \
 *   node scripts/verify-wake-e2e.js
 *
 * 环境变量：
 *   HERMES_E2E_BASE_URL  目标 Hermes 的 /v1 地址（默认 http://127.0.0.1:8646/v1）
 *   HERMES_E2E_KEY       该实例的 api_server key（默认读 bridge.config.json 的 model.apiKey）
 *   HERMES_E2E_TIMEOUT_MS  等待投递的上限（默认 60000）
 *   HERMES_E2E_CACHE_DIR   游标落盘目录（默认临时目录；重新验证时会用它证明不重复推送）
 *   HERMES_E2E_EXPECT_NONE=1  反转判定：期望"一条都没有"（用同一个 CACHE_DIR 跑第二遍防复读）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/core/config.js';
import { createContainer } from '../src/app/container.js';
import { createLogger } from '../src/core/logger.js';
import { MockModelAdapter } from '../src/adapters/model/mock-model.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const baseUrl = process.env.HERMES_E2E_BASE_URL ?? 'http://127.0.0.1:8646/v1';
  const timeoutMs = Number(process.env.HERMES_E2E_TIMEOUT_MS ?? 60000);
  const cacheDir = process.env.HERMES_E2E_CACHE_DIR
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ruaji-wake-e2e-'));

  const config = loadConfig({
    rootDir: ROOT,
    env: {
      ...process.env,
      HERMES_API_KEY: process.env.HERMES_E2E_KEY ?? process.env.HERMES_API_KEY ?? '',
    },
    cliOverrides: {
      mode: 'test',
      reply: { sendEnabled: false, sideEffectsEnabled: false },
      model: { baseUrl },
      wakeDelivery: { enabled: true, pollIntervalMs: 1500 },
      storage: { cacheDir },
      logging: { file: null, level: 'info' },
      health: { port: 0, lockPort: 0 },
      web: { enabled: false },
      mem0: { enabled: false },
    },
  });

  const logger = createLogger(config, ROOT);
  const container = createContainer(config, {
    logger,
    modelAdapter: new MockModelAdapter({ replies: ['(verification run)'] }),
  });

  console.log(`目标 Hermes : ${baseUrl}`);
  console.log(`游标目录    : ${cacheDir}`);
  console.log('发送模式    : dry-run（不会真的发 QQ）\n');

  const deadline = Date.now() + timeoutMs;
  let rounds = 0;
  while (Date.now() < deadline) {
    const out = await container.wakeFlow.pollOnce();
    rounds += 1;
    if (container.sender.dryRunLog.length > 0) break;
    if (out.sessions > 0 && rounds % 4 === 0) {
      console.log(`… 已轮询 ${rounds} 次（会话 ${out.sessions} 个）`);
    }
    await sleep(750);
  }

  const entries = container.sender.dryRunLog;
  const expectNone = process.env.HERMES_E2E_EXPECT_NONE === '1';
  if (entries.length === 0) {
    if (expectNone) {
      console.log('✅ 没有可投递的分体通知 —— 与预期一致（游标/去重记录已把已推过的通知挡住）。');
      await container.webServer?.close?.();
      container.cleanup?.();
      process.exit(0);
    }
    console.error('❌ 没有取到任何分体通知。检查：');
    console.error('   1. Hermes 端 platforms.api_server.extra.async_delivery 是否为 true');
    console.error('   2. 目标会话里是否真的跑过一次 notify_on_complete 的后台任务');
    console.error('   3. 会话 id 是否是桥接形状（qq_group_<群号>_<日期tag> / qq_private_<QQ号>_<日期tag>）');
    console.error(`   4. 健康计数: ${JSON.stringify(container.health.state.wakeDelivery)}`);
    container.cleanup?.();
    process.exit(1);
  }

  if (expectNone) {
    console.error(`❌ 期望 0 条，实际取到 ${entries.length} 条 —— 说明游标/去重没生效（有复读风险）`);
    for (const entry of entries) console.error(`   ${entry.targetId}: ${entry.message}`);
    container.cleanup?.();
    process.exit(1);
  }

  console.log(`✅ 取到 ${entries.length} 条待投递内容：\n`);
  for (const entry of entries) {
    console.log(`  目标 : ${entry.isGroup ? '群' : '私聊'} ${entry.targetId}`);
    console.log(`  会话 : ${entry.sessionId}`);
    console.log(`  正文 : ${entry.message.replace(/\n/g, '\n         ')}`);
    console.log(`  时间 : ${entry.at}\n`);
  }
  console.log(`游标文件: ${container.wakeCursorStore.file}`);
  console.log('再次运行本脚本（同一个 HERMES_E2E_CACHE_DIR）应当取到 0 条 —— 那才证明不会复读。');

  await container.webServer?.close?.();
  container.cleanup?.();
  process.exit(0);
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(2);
});

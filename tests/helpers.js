/**
 * tests/helpers.js — 测试公共装配
 *
 * 原则：不碰真实网络、不碰旧 Bridge 的数据文件。所有外部依赖都靠注入替换。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { loadConfig } from '../src/core/config.js';
import { createContainer } from '../src/app/container.js';
import { Logger } from '../src/core/logger.js';
import { MockModelAdapter } from '../src/adapters/model/mock-model.js';

export const TEST_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
export const FIXTURE_DIR = path.join(TEST_ROOT, 'tests', 'fixtures');

export function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, name.endsWith('.json') ? name : `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadTextFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** 静默 logger：把日志行收进数组，测试可以断言"有没有打这条警告" */
export function createTestLogger() {
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (line) => lines.push(line) });
  logger.lines = lines;
  logger.find = (substr) => lines.filter((l) => l.msg.includes(substr));
  return logger;
}

/** 每个测试一个独立临时目录，跑完自动删 */
export function makeTempDir(prefix = 'ruaji-v2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 可编程的 fetch 替身。
 * routes: { 'POST http://host/path': (req) => ({ status, body }) }
 */
export function createFetchStub(routes = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : url;
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${u.origin}${u.pathname}`;
    calls.push({ key, url: u.toString(), method, body: init.body ? JSON.parse(init.body) : null, init });

    const handler = routes[key] ?? routes[`${method} ${u.pathname}`] ?? routes['*'];
    if (!handler) {
      const err = new Error(`fetch stub 未配置路由: ${key}`);
      err.code = 'ECONNREFUSED';
      throw err;
    }

    const result = await handler({ url: u, method, body: init.body ? JSON.parse(init.body) : null, init });
    const status = result?.status ?? 200;
    const text = typeof result?.body === 'string' ? result.body : JSON.stringify(result?.body ?? {});

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(result?.headers ?? { 'content-type': 'application/json' })),
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      body: result?.stream ?? null,
    };
  };
  stub.calls = calls;
  stub.callsTo = (substr) => calls.filter((c) => c.url.includes(substr));
  return stub;
}

/** 把 SSE 文本包装成 ReadableStream，喂给 OpenAiCompatibleAdapter 的流式解析 */
export function sseStream(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[i++]) };
        },
      };
    },
  };
}

/** 假 WebSocket，测试重连与事件分发 */
export class FakeWebSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  open() { this.emit('open'); }
  pushEvent(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  fail(message) { this.emit('error', new Error(message)); this.emit('close', 1006, message); }
  close() { this.closed = true; this.emit('close', 1000, 'normal'); }
  static reset() { FakeWebSocket.instances = []; }
}

/**
 * 构建一个完整的测试容器。
 * @param {object} [opts]
 * @param {object} [opts.configOverrides]
 * @param {string[]|Function} [opts.replies]  mock 模型的回复
 * @param {object} [opts.routes]              fetch stub 路由
 */
export function buildTestContainer(opts = {}) {
  const tmp = makeTempDir();
  const logger = opts.logger ?? createTestLogger();
  const fetchImpl = opts.fetchImpl ?? createFetchStub(opts.routes ?? { '*': () => ({ body: { status: 'ok', retcode: 0 } }) });

  const config = loadConfig({
    rootDir: TEST_ROOT,
    file: 'bridge.config.example.json',
    env: { ...process.env, NAPCAT_ACCESS_TOKEN: 'test-token', HERMES_API_KEY: 'test-key' },
    cliOverrides: {
      mode: 'test',
      reply: {
        sendEnabled: false,
        sideEffectsEnabled: false,
        ...(opts.configOverrides?.reply ?? {}),
      },
      storage: {
        legacyRoot: tmp,
        affectionFile: path.join(tmp, 'affection.json'),
        // 必须指到 tmp：否则会读到仓库里的真实画像数据，测试结果跟着线上状态漂移
        portrayalFile: path.join(tmp, 'portrayal-profiles.json'),
        memeDataFile: path.join(tmp, 'memes_data.json'),
        memeRoot: path.join(tmp, 'memes'),
        receivedImagesDir: path.join(tmp, 'received_images'),
        receivedFilesDir: path.join(tmp, 'received_files'),
        cacheDir: path.join(tmp, '.cache'),
        // 影子日志也落到 tmp，避免测试在仓库里留下 shadow/ 目录
        shadowDir: path.join(tmp, 'shadow'),
      },
      logging: { file: null, level: 'debug' },
      health: { port: 0, lockPort: 0 },
      plugins: opts.plugins ?? [],
      ...(opts.configOverrides ?? {}),
      // identity 放在最后一个 spread **之后**：configOverrides.identity 只该覆盖它显式
      // 给的字段，不能因为整体替换对象而丢掉这里钉死的测试基线（例如 example 里的
      // groupWhitelist 是非空名单，一旦漏进来所有群聊用例都会被白名单门禁拦在入口）。
      identity: {
        ownerId: '10000001',
        robotId: '398276230',
        botName: '瑞姬',
        rateLimitUsers: ['10000002'],
        privateWhitelist: ['10000001', '10000003'],
        groupWhitelist: [],
        ...(opts.configOverrides?.identity ?? {}),
      },
    },
  });

  // 面板的 PUT /api/config 会往 paths.configFile 落盘。必须指到 tmp——否则测试
  // 会把仓库根目录那份**实盘** bridge.config.json 用测试值覆盖掉。
  config.paths.configFile = path.join(tmp, 'bridge.config.json');

  const container = createContainer(config, {
    logger,
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    modelAdapter: opts.modelAdapter ?? new MockModelAdapter({ replies: opts.replies ?? ['好的。'] }),
  });

  container.tmpDir = tmp;
  container.fetchStub = fetchImpl;
  container.cleanup = () => cleanupDir(tmp);
  return container;
}

/** 写一份最小的 memes_data.json + 图片文件，供表情包测试使用 */
export function seedMemes(tmpDir, memes) {
  const memeRoot = path.join(tmpDir, 'memes');
  fs.mkdirSync(path.join(memeRoot, '常用'), { recursive: true });

  const records = memes.map((m) => {
    const filePath = path.join(memeRoot, '常用', `${m.id}.png`);
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return {
      id: m.id,
      name: `${m.id}.png`,
      category: '常用',
      tag: m.tag ?? m.id,
      keywords: m.keywords ?? [m.tag ?? m.id],
      path: filePath,
      status: m.status ?? 'accepted',
      description: m.description ?? '',
    };
  });

  fs.writeFileSync(
    path.join(tmpDir, 'memes_data.json'),
    JSON.stringify({ categories: ['常用'], memes: records, settings: { max_send_per_reply: 1 } }, null, 2),
  );
  return { memeRoot, records };
}

export function seedAffection(tmpDir, users) {
  const file = path.join(tmpDir, 'affection.json');
  fs.writeFileSync(file, JSON.stringify({ users }, null, 2));
  return file;
}

/** 等待所有已排入的微任务与 setImmediate 完成 */
export function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

/**
 * core/rate-limit-policy.js — 频控策略的**唯一**事实来源
 *
 * 为什么需要这个模块：
 *
 *   修 bug 之前，限速名单在两个编排组件里各被快照成一个 `Set`：
 *
 *     decision-flow.js:52   this.rateLimitUsers = new Set(config.identity.rateLimitUsers…)
 *     inbound-flow.js:51    this.rateLimitUsers = new Set(deps.config.identity.rateLimitUsers…)
 *
 *   而面板保存配置时走的是 `Object.assign(config.identity, diskConfig.identity)`——
 *   只替换了 config 上的数组，构造期生成的 Set 永远不会被刷新。结果是
 *   "面板里加了人 / 文件里明明有，但运行中的进程就是不认"。同时判定阈值和
 *   窗口粒度也散落在两处（`config.decision.rateLimit.maxReplies` 现读、
 *   `sessionStore.rateLimitWindowMs` 构造期快照），热更新一半生效一半不生效。
 *
 *   现在所有解析/求值都收敛到这里，且**每次调用都现读活配置**（名单只有个位数
 *   条目，解析成本可忽略）。编排层只消费 `resolveRateLimitPolicy()` 的返回值，
 *   不再各自维护 Set。web 层也用同一套 parse/format，避免前端文本格式和后端
 *   存储格式漂移。
 *
 * 名单条目的两种写法（同一数组里可以混用，向后兼容纯字符串）：
 *
 *     "3443746455"                                     // 用全局默认额度
 *     2416406494                                       // 数字写法等价
 *     "2416406494:2"                                   // 单独额度：5 分钟内最多 2 条
 *     "2416406494:2:600000"                            // 单独额度 + 单独窗口（毫秒）
 *     "3768463847:block"                               // 严格拦截：永不回复
 *     "3768463847:0"                                   // 等价写法：窗口内允许 0 条 = 严格拦截
 *     { "userId": "2416406494", "maxReplies": 2,       // 配置文件里的完整对象写法
 *       "windowMs": 300000, "block": false }
 *
 * 全局默认值来自 `config.decision.rateLimit`（maxReplies / windowMs）。
 */

import { MESSAGE_TYPES } from '../contracts/messages.js';

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  maxReplies: 5,
  windowMs: 300000,
});

/** `id:block` 这类严格拦截标记，接受少量同义词，避免手写配置时踩坑 */
const BLOCK_TOKENS = new Set(['block', 'blocked', 'deny', 'denied', 'strict', 'block-all']);

/** 正整数（向下取整）；非法一律 null，绝不把 NaN 带进判定式 */
function positiveIntOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function trimId(value) {
  return String(value ?? '').trim();
}

/**
 * 解析单个名单条目。
 *
 * @param {string|number|object} entry
 * @returns {{ userId: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 *          无法解析（空、缺 userId）返回 null
 */
export function parseRateLimitEntry(entry) {
  if (entry == null || entry === '') return null;
  // 数字写法必须是正数：配置里手滑写 0 / -1 / NaN 不该变成 "用户 0"
  if (typeof entry === 'number' && !(entry > 0)) return null;

  // 对象写法：{ userId|id|uid, maxReplies|limit, windowMs|window, block }
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const userId = trimId(entry.userId ?? entry.id ?? entry.uid);
    if (!userId) return null;
    const maxRepliesRaw = entry.maxReplies ?? entry.limit;
    return {
      userId,
      maxReplies: positiveIntOrNull(maxRepliesRaw),
      windowMs: positiveIntOrNull(entry.windowMs ?? entry.window),
      // maxReplies=0 的语义就是"窗口内一条都不回"，直接升格成严格拦截，
      // 避免它被当成非法值静默丢弃、配置与行为对不上。
      block: entry.block === true || entry.blocked === true || entry.strict === true
        || (maxRepliesRaw != null && Number(maxRepliesRaw) === 0),
    };
  }

  // 文本写法：id[:maxReplies][:windowMs][:block]，各段顺序不敏感
  const token = String(entry).trim();
  if (!token) return null;

  const parts = token.split(':').map((s) => s.trim());
  const userId = parts.shift();
  if (!userId) return null;

  const rule = { userId, maxReplies: null, windowMs: null, block: false };
  for (const part of parts) {
    if (!part) continue;
    if (BLOCK_TOKENS.has(part.toLowerCase())) {
      rule.block = true;
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n)) continue;
    // 第一个数字是条数，第二个是窗口毫秒
    if (rule.maxReplies == null) {
      if (n === 0) rule.block = true; // id:0 —— 窗口内允许 0 条＝严格拦截
      else if (n > 0) rule.maxReplies = Math.floor(n);
      continue;
    }
    if (rule.windowMs == null && n > 0) rule.windowMs = Math.floor(n);
  }
  return rule;
}

/**
 * 条目 → 文本。前端输入框与日志都用这个格式，保证 parse/format 对称。
 * @param {string|number|object} entry
 */
export function formatRateLimitEntry(entry) {
  const rule = parseRateLimitEntry(entry);
  if (!rule) return '';
  let out = rule.userId;
  if (rule.maxReplies != null) out += `:${rule.maxReplies}`;
  if (rule.windowMs != null) out += `:${rule.windowMs}`;
  if (rule.block) out += ':block';
  return out;
}

/**
 * 规范化整份名单：解析 + 按 userId 去重（后来者覆盖，保留首次出现顺序）。
 * @param {unknown} list
 * @returns {{ userId: string, maxReplies: number|null, windowMs: number|null, block: boolean }[]}
 */
export function normalizeRateLimitList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const entry of list) {
    const rule = parseRateLimitEntry(entry);
    if (!rule) continue;
    const prev = byId.get(rule.userId);
    byId.set(rule.userId, prev
      ? {
          userId: rule.userId,
          maxReplies: rule.maxReplies ?? prev.maxReplies,
          windowMs: rule.windowMs ?? prev.windowMs,
          block: rule.block || prev.block,
        }
      : rule);
  }
  return [...byId.values()];
}

/**
 * 落盘/接口用的紧凑写法：只有默认额度的条目保持纯 QQ 号字符串（向后兼容旧配置文件
 * 与旧前端），带覆盖项或严格拦截的才写成对象。
 * @param {{ userId: string, maxReplies: number|null, windowMs: number|null, block: boolean }} rule
 * @returns {string|object}
 */
export function toConfigRateLimitEntry(rule) {
  const plain = rule.maxReplies == null && rule.windowMs == null && rule.block !== true;
  if (plain) return rule.userId;
  const out = { userId: rule.userId };
  if (rule.maxReplies != null) out.maxReplies = rule.maxReplies;
  if (rule.windowMs != null) out.windowMs = rule.windowMs;
  if (rule.block) out.block = true;
  return out;
}

/**
 * 在活配置里查这个用户的名单规则。**每次现读** `config.identity.rateLimitUsers`，
 * 面板保存后立即生效，不需要任何"推送活实例"的同步代码。
 *
 * @param {string|number} userId
 * @param {object} config
 * @returns {{ userId: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 */
export function resolveRateLimitRule(userId, config) {
  const uid = trimId(userId);
  if (!uid) return null;
  const list = config?.identity?.rateLimitUsers;
  if (!Array.isArray(list) || list.length === 0) return null;
  return normalizeRateLimitList(list).find((rule) => rule.userId === uid) ?? null;
}

/**
 * 求出该用户该走的具体额度（已合并全局默认值）。
 * 不在名单 → null（完全不限速）。
 *
 * @param {string|number} userId
 * @param {string} messageType MESSAGE_TYPES 之一
 * @param {object} config
 * @returns {{ userId: string, maxReplies: number, windowMs: number, block: boolean }|null}
 */
export function resolveRateLimitPolicy(userId, messageType, config) {
  const rule = resolveRateLimitRule(userId, config);
  if (!rule) return null;

  // 私聊默认不受频控约束（私聊本来就要过白名单门禁，是主人显式放行的对象），
  // 需要时用 decision.rateLimit.applyToPrivate=true 打开。
  if (messageType === MESSAGE_TYPES.PRIVATE && config?.decision?.rateLimit?.applyToPrivate !== true) {
    return null;
  }

  const defaults = config?.decision?.rateLimit ?? {};
  return {
    userId: rule.userId,
    maxReplies: rule.maxReplies
      ?? positiveIntOrNull(defaults.maxReplies)
      ?? RATE_LIMIT_DEFAULTS.maxReplies,
    windowMs: rule.windowMs
      ?? positiveIntOrNull(defaults.windowMs)
      ?? RATE_LIMIT_DEFAULTS.windowMs,
    block: rule.block === true,
  };
}

/**
 * 把一个 policy 落到计数上求值。
 *
 * 计数函数由调用方注入（编排层传 SessionStore），这样策略模块不依赖存储，
 * 两个编排组件（decision-flow / inbound-flow）共用同一份判定，不会再出现
 * "一处判 5 次、一处判别的" 的口径漂移。
 *
 * @param {{ userId: string, maxReplies: number, windowMs: number, block: boolean }|null} policy
 * @param {(userId: string, windowMs: number) => number} countRecentReplies
 * @returns {{ policy: object|null, limited: boolean, blocked: boolean, count: number }}
 */
export function evaluateRateLimit(policy, countRecentReplies) {
  if (!policy) return { policy: null, limited: false, blocked: false, count: 0 };
  const count = countRecentReplies(policy.userId, policy.windowMs);
  if (policy.block) return { policy, limited: true, blocked: true, count };
  return { policy, limited: count >= policy.maxReplies, blocked: false, count };
}

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
 *
 * 群级名单（identity.groupWhitelist）复用同一套语法，只是 id 字段叫 groupId：
 * "1076958977"（纯群号，**不限速**）、"1076958977:5"（5 分钟内最多 5 条）、
 * "1076958977:5:300000"（单独窗口）、"1076958977:block"。群级没有全局默认额度——
 * 想限速必须显式写条数，只写群号就保持旧行为（不限速）。
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
 * 解析单个名单条目。用户 / 群共用同一套文本与对象语法，只在 id 字段名上分叉：
 * 用户认 userId|id|uid，群认 groupId|gid|group|id。
 *
 * @param {string|number|object} entry
 * @param {string[]} idKeys 对象写法里按顺序尝试的 id 字段名
 * @returns {{ id: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 *          无法解析（空、缺 id）返回 null
 */
function parseIdLimitEntry(entry, idKeys) {
  if (entry == null || entry === '') return null;
  // 数字写法必须是正数：配置里手滑写 0 / -1 / NaN 不该变成 "用户 0"
  if (typeof entry === 'number' && !(entry > 0)) return null;

  // 对象写法：{ userId|id|uid | groupId|gid|group, maxReplies|limit, windowMs|window, block }
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    let id = '';
    for (const key of idKeys) {
      id = trimId(entry[key]);
      if (id) break;
    }
    if (!id) return null;
    const maxRepliesRaw = entry.maxReplies ?? entry.limit;
    return {
      id,
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
  const id = parts.shift();
  if (!id) return null;

  const rule = { id, maxReplies: null, windowMs: null, block: false };
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
 * 解析单个用户级名单条目。
 *
 * @param {string|number|object} entry
 * @returns {{ userId: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 */
export function parseRateLimitEntry(entry) {
  const rule = parseIdLimitEntry(entry, ['userId', 'id', 'uid']);
  return rule && { userId: rule.id, maxReplies: rule.maxReplies, windowMs: rule.windowMs, block: rule.block };
}

/**
 * 解析单个群级名单条目（identity.groupWhitelist）。
 *
 * @param {string|number|object} entry
 * @returns {{ groupId: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 */
export function parseGroupRateLimitEntry(entry) {
  const rule = parseIdLimitEntry(entry, ['groupId', 'gid', 'group', 'id']);
  return rule && { groupId: rule.id, maxReplies: rule.maxReplies, windowMs: rule.windowMs, block: rule.block };
}

/**
 * 条目 → 文本。前端输入框与日志都用这个格式，保证 parse/format 对称。
 * @param {string|number|object} entry
 */
function formatParsedIdLimitEntry(id, rule) {
  let out = id;
  if (rule.maxReplies != null) out += `:${rule.maxReplies}`;
  if (rule.windowMs != null) out += `:${rule.windowMs}`;
  if (rule.block) out += ':block';
  return out;
}

export function formatRateLimitEntry(entry) {
  const rule = parseRateLimitEntry(entry);
  return rule ? formatParsedIdLimitEntry(rule.userId, rule) : '';
}

/** 群级条目 → 文本（与 parseGroupRateLimitEntry 对称）。 */
export function formatGroupRateLimitEntry(entry) {
  const rule = parseGroupRateLimitEntry(entry);
  return rule ? formatParsedIdLimitEntry(rule.groupId, rule) : '';
}

/**
 * 规范化整份名单：解析 + 按 id 去重（后来者覆盖，保留首次出现顺序）。
 * 用户 / 群共用，靠 parseEntry 与 idField 分叉。
 * @param {unknown} list
 * @param {(entry: unknown) => object|null} parseEntry
 * @param {string} idField
 */
function normalizeIdLimitList(list, parseEntry, idField) {
  if (!Array.isArray(list)) return [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const entry of list) {
    const rule = parseEntry(entry);
    if (!rule) continue;
    const id = rule[idField];
    const prev = byId.get(id);
    byId.set(id, prev
      ? {
          [idField]: id,
          maxReplies: rule.maxReplies ?? prev.maxReplies,
          windowMs: rule.windowMs ?? prev.windowMs,
          block: rule.block || prev.block,
        }
      : rule);
  }
  return [...byId.values()];
}

export function normalizeRateLimitList(list) {
  return normalizeIdLimitList(list, parseRateLimitEntry, 'userId');
}

/** 规范化整份群名单（identity.groupWhitelist），按 groupId 去重，后来者覆盖。 */
export function normalizeGroupRateLimitList(list) {
  return normalizeIdLimitList(list, parseGroupRateLimitEntry, 'groupId');
}

/**
 * 落盘/接口用的紧凑写法：只有默认额度的条目保持纯 id 字符串（向后兼容旧配置文件
 * 与旧前端），带覆盖项或严格拦截的才写成对象。用户 / 群共用。
 * @param {{ maxReplies: number|null, windowMs: number|null, block: boolean }} rule
 * @param {string} idField
 * @returns {string|object}
 */
function toConfigIdLimitEntry(rule, idField) {
  const plain = rule.maxReplies == null && rule.windowMs == null && rule.block !== true;
  if (plain) return rule[idField];
  const out = { [idField]: rule[idField] };
  if (rule.maxReplies != null) out.maxReplies = rule.maxReplies;
  if (rule.windowMs != null) out.windowMs = rule.windowMs;
  if (rule.block) out.block = true;
  return out;
}

export function toConfigRateLimitEntry(rule) {
  return toConfigIdLimitEntry(rule, 'userId');
}

/** 群级规则 → 落盘/接口用的紧凑写法：只有群号（不限速）保持纯字符串。 */
export function toConfigGroupRateLimitEntry(rule) {
  return toConfigIdLimitEntry(rule, 'groupId');
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

// ===========================================================================
// 群级频控（identity.groupWhitelist 里的 "群号:条数[:窗口毫秒]"）
// ===========================================================================

/**
 * 在活配置里查这个群的名单规则。**每次现读** `config.identity.groupWhitelist`，
 * 面板保存后立即生效。与用户级名单共用同一套文本/对象语法。
 *
 * @param {string|number} groupId
 * @param {object} config
 * @returns {{ groupId: string, maxReplies: number|null, windowMs: number|null, block: boolean }|null}
 */
export function resolveGroupRateLimitRule(groupId, config) {
  const gid = trimId(groupId);
  if (!gid) return null;
  const list = config?.identity?.groupWhitelist;
  if (!Array.isArray(list) || list.length === 0) return null;
  return normalizeGroupRateLimitList(list).find((rule) => rule.groupId === gid) ?? null;
}

/**
 * 求出该群该走的具体额度。
 *
 * **只写群号（没写条数）→ null（完全不限速）**：群级频控没有全局默认额度，
 * 想限速必须显式写 "群号:条数"，这样纯群号的老配置行为一字不变。
 * 窗口可以省略，此时回落 config.decision.rateLimit.windowMs。
 *
 * @param {string|number} groupId
 * @param {object} config
 * @returns {{ groupId: string, maxReplies: number, windowMs: number, block: boolean }|null}
 */
export function resolveGroupRateLimitPolicy(groupId, config) {
  const rule = resolveGroupRateLimitRule(groupId, config);
  if (!rule) return null;
  if (rule.maxReplies == null && rule.block !== true) return null;

  const defaults = config?.decision?.rateLimit ?? {};
  return {
    groupId: rule.groupId,
    // block（或 "群号:0"）＝窗口内一条都不回；非 block 时 maxReplies 必非 null
    maxReplies: rule.maxReplies ?? 0,
    windowMs: rule.windowMs
      ?? positiveIntOrNull(defaults.windowMs)
      ?? RATE_LIMIT_DEFAULTS.windowMs,
    block: rule.block === true,
  };
}

/**
 * 把群级 policy 落到计数上求值，并算出还要等多久才能再回。
 *
 * 与用户级 evaluateRateLimit 同一套口径，但多返回一个 retryAfterMs：命中后要
 * 等最早的 (count - maxReplies + 1) 条回复滑出窗口才重新有空位，所以冷却时间
 * 取这批里最后一条的时间戳 + 窗口 - now。提示语据此换算出分钟数。
 *
 * @param {{ groupId: string, maxReplies: number, windowMs: number, block: boolean }|null} policy
 * @param {(groupId: string, windowMs: number) => number[]} getRecentReplies 窗口内回复时间戳（乱序即可）
 * @param {number} [now]
 * @returns {{ policy: object|null, limited: boolean, blocked: boolean, count: number, retryAfterMs: number }}
 */
export function evaluateGroupRateLimit(policy, getRecentReplies, now = Date.now()) {
  if (!policy) return { policy: null, limited: false, blocked: false, count: 0, retryAfterMs: 0 };
  const stamps = getRecentReplies(policy.groupId, policy.windowMs) ?? [];
  const count = stamps.length;
  if (policy.block) {
    return { policy, limited: true, blocked: true, count, retryAfterMs: policy.windowMs };
  }
  if (count < policy.maxReplies) {
    return { policy, limited: false, blocked: false, count, retryAfterMs: 0 };
  }
  const sorted = [...stamps].sort((a, b) => a - b);
  // 需要滑出窗口的是最早的 count-maxReplies+1 条，边界就是第 count-maxReplies 条
  const boundary = sorted[count - policy.maxReplies];
  const retryAfterMs = Math.max(0, boundary + policy.windowMs - now);
  return { policy, limited: true, blocked: false, count, retryAfterMs };
}

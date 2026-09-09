/**
 * storage/favour-client.js — Favour Ultra 数据读取客户端
 *
 * 通过统一宿主的通用插件页面 API 读取权威好感数据（分数、等级名、关系、
 * 排他标记）。桥接侧所有消费者（画像、回复上下文、面板）都从这里取数，
 * 保证与插件后端是同一份状态，不再有第二套刻度。
 *
 * 宿主地址来自配置（unifiedHost.baseUrl），不在代码里硬编码，
 * 与 contract/architecture 的"插件地址只能出现在配置里"一致。
 */

const DEFAULT_LEVELS = [
  [-200, -151, '极度厌恶'],
  [-150, -51, '厌恶'],
  [-50, -1, '反感'],
  [0, 149, '普通'],
  [150, 299, '喜欢'],
  [300, 449, '亲密'],
  [450, 500, '挚爱'],
];

export function resolveFavourLevel(favour, levels = DEFAULT_LEVELS) {
  const score = Number(favour);
  if (!Number.isFinite(score)) return '普通';
  for (const [min, max, name] of levels) {
    if (score >= min && score <= max) return name;
  }
  return score > 500 ? '挚爱' : '普通';
}

export class FavourClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl        统一宿主地址（配置注入）
   * @param {string} [opts.pluginKey]    宿主挂载键
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.cacheTtlMs]   读缓存，避免每条消息都打一次宿主
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || '');
    this.pluginKey = opts.pluginKey || 'favour_ultra';
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5000;
    this.maxFavour = opts.maxFavour ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.logger?.child({ component: 'favour-client' }) ?? console;
    this._cache = null;
    this._cachedAt = 0;
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  async listRecords() {
    if (!this.enabled) return [];
    const now = Date.now();
    if (this._cache && now - this._cachedAt < this.cacheTtlMs) return this._cache;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/plug/${this.pluginKey}/api/datarecords`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return this._cache ?? [];
      const data = await res.json();
      const records = [...(data?.global ?? []), ...(data?.non_global ?? [])];
      this._cache = records;
      this._cachedAt = now;
      return records;
    } catch (err) {
      // 宿主不可达时沿用上次结果并保持静默降级：好感读取失败不能阻断回复
      this.log.debug?.('Favour 数据读取失败，沿用上次结果', { error: err.message });
      return this._cache ?? [];
    }
  }

  /** 单个用户的好感现状；宿主不可达或无记录时返回 null（调用方负责降级） */
  async getContext(userId) {
    const uid = String(userId ?? '');
    if (!uid) return null;
    const records = await this.listRecords();
    const record = records.find((r) => String(r.user_id) === uid);
    if (!record) return null;

    const favour = Number(record.favour ?? 0);
    const relationship = record.relationship && record.relationship !== '无' ? record.relationship : '';
    return {
      favour,
      level: resolveFavourLevel(favour),
      relationship,
      isUnique: Boolean(record.is_unique),
      username: record.username || uid,
    };
  }

  /** 渲染成消费者可直接注入的一行文本（画像 / 回复上下文共用同一刻度） */
  async renderContextLine(userId) {
    const ctx = await this.getContext(userId);
    if (!ctx) return '';
    const relation = ctx.relationship || ctx.level;
    const unique = ctx.isUnique ? '★(排他)' : '';
    return `【瑞姬与该群友的关系现状】: 当前好感度 ${ctx.favour}/${this.maxFavour} (${ctx.level}) | 关系: ${relation}${unique}\n`;
  }
}

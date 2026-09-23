/**
 * adapters/hermes/hermes-api.js — Hermes 管理 API 的最小只读客户端
 *
 * 只做两件事：
 *   1. GET /api/sessions                      —— 列会话（message_count / parent_session_id）
 *   2. GET /api/sessions/{id}/messages        —— 读会话 transcript（含 display_kind）
 *
 * 为什么需要它：Hermes 的 API Server 是无状态 HTTP 通道，声明了
 * supports_async_delivery=False，后台任务结束后无法主动 push，只能把结果写回
 * 会话 transcript（唤醒自投递）。客户端要拿到这些结果，就得自己回读 transcript ——
 * 这正是 Hermes 自己的 TUI / 桌面端 / dashboard 消费分体投递（DELIVERY 行）的方式。
 *
 * 鉴权、地址全部复用模型出口的配置：同一个 api_server、同一把 API key
 * （模型走 /v1，管理 API 走根路径下的 /api）。
 */

const DEFAULT_TIMEOUT_MS = 8000;

export class HermesSessionApi {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  与 model.baseUrl 同源，形如 http://127.0.0.1:8646/v1
   * @param {string} [opts.apiKey]
   * @param {number} [opts.timeoutMs]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.root = String(opts.baseUrl ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.logger?.child({ component: 'hermes-api' }) ?? console;
  }

  get available() {
    return Boolean(this.root && this.fetchImpl);
  }

  /**
   * 统一的 GET：**永不抛异常**。轮询是后台任务，网络抖动只该被记录与下次重试，
   * 不该把异常抛到调用栈上。
   * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string}>}
   */
  async _get(pathname, { query, timeoutMs } = {}) {
    if (!this.available) return { ok: false, error: 'Hermes 管理 API 未配置' };
    let url;
    try {
      url = new URL(`${this.root}${pathname}`);
    } catch (err) {
      return { ok: false, error: `Hermes 地址非法: ${err.message}` };
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const res = await this.fetchImpl(url.toString(), {
        headers,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${String(text).slice(0, 200)}` };
      }
      return { ok: true, status: res.status, data: await res.json() };
    } catch (err) {
      const why =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `请求超时 (${timeoutMs ?? this.timeoutMs}ms)`
          : err?.message ?? String(err);
      return { ok: false, error: why };
    }
  }

  /** GET /api/sessions —— 列出持久化会话 */
  listSessions({ source = 'api_server', limit = 200 } = {}) {
    return this._get('/api/sessions', { query: { source, limit } });
  }

  /** GET /api/sessions/{id}/messages —— 读会话 transcript */
  fetchMessages(sessionId, { order = 'oldest', limit = 500 } = {}) {
    return this._get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      query: { order, limit },
    });
  }
}

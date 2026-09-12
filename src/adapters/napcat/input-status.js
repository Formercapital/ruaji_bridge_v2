/**
 * 私聊工作期间刷新 QQ 原生的「正在输入」。
 * 参考 ctrlkk/astrbot_plugin_input_state_by_nc：event_type=1，每 500ms 上报。
 * LLBot >= 7.12.3 使用相同接口：https://llonebot.apifox.cn/api-449484306
 * 停止上报后由 QQ 自行清除状态；event_type=0 是说话，不是取消。
 * 生命周期跟随整轮回复，长任务不套用上游的 120 秒上限。
 */

import { MESSAGE_TYPES } from '../../contracts/messages.js';

export class InputStatus {
  constructor({ napcatApi, config, logger } = {}) {
    this.api = napcatApi;
    this.config = config;
    this.log = logger?.child({ component: 'input-status' }) ?? console;
    this.active = new Map();
    this.stopped = false;
  }

  _enabled() {
    return !this.stopped && this.config.mode === 'live'
      && this.config.reply?.sendEnabled === true
      && this.config.napcat?.inputStatusEnabled !== false;
  }

  /** 返回本轮专属的清理函数，旧回复收尾不能停止同一用户的新回复。 */
  start(inbound, { signal } = {}) {
    if (!this._enabled() || signal?.aborted || inbound.messageType !== MESSAGE_TYPES.PRIVATE) {
      return () => {};
    }
    const userId = String(inbound.userId ?? '').trim();
    if (!userId) return () => {};

    let state = this.active.get(userId);
    if (!state) {
      state = { userId, timer: null, releases: new Set() };
      this.active.set(userId, state);
    }
    const release = () => {
      signal?.removeEventListener('abort', release);
      state.releases.delete(release);
      if (state.releases.size === 0) this._close(state);
    };
    state.releases.add(release);
    signal?.addEventListener('abort', release, { once: true });
    if (state.releases.size === 1) void this._refresh(state);
    return release;
  }

  async _refresh(state) {
    if (this.active.get(state.userId) !== state) return;
    if (!this._enabled()) {
      this._close(state);
      return;
    }
    try {
      await this.api.setInputStatus(state.userId);
    } catch (err) {
      // 协议端可能不支持此扩展：本轮停止上报，不能影响回复或持续刷错。
      this.log.warn('私聊输入状态上报失败，本轮停止提示', {
        userId: state.userId,
        error: err?.message ?? String(err),
      });
      this._close(state);
      return;
    }
    if (this.active.get(state.userId) !== state) return;
    // 一次请求结束后再计时，慢接口不会叠出一批并发请求。
    state.timer = setTimeout(() => {
      state.timer = null;
      void this._refresh(state);
    }, 500);
    state.timer.unref?.();
  }

  _close(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (this.active.get(state.userId) !== state) return;
    this.active.delete(state.userId);
    for (const release of state.releases) release();
  }

  stop() {
    this.stopped = true;
    for (const state of this.active.values()) this._close(state);
  }
}

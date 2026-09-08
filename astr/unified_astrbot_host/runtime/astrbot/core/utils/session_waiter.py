"""astrbot.core.utils.session_waiter —— 会话等待器（跨 HTTP 请求版）。

真 AstrBot 的 session_waiter 挂在平台事件队列上，等"同一会话同一个人的
下一条消息"。统一宿主里每条消息都是一次独立的 HTTP 请求（/api/v1/events），
没有常驻队列，所以这里把等待器实现成**进程内注册表**：

- 插件调用 ``await confirm_waiter(event)`` 时注册一个等待器并立即返回
  （上游会阻塞等待；跨 HTTP 阻塞会把宿主请求挂死，不能照抄）。
- 宿主在收到新消息时调用 :func:`feed`，命中 (session_id, sender_id) 的
  等待器就在**当前请求内**执行回调——回调里的 ``evt.send(...)`` 走当前
  请求的 send_hook，回复能随本次 HTTP 响应带回桥接。

已知偏离：上游超时会抛 TimeoutError 让插件回复"操作超时"；跨请求架构下
原请求早已返回，这里超时只静默注销等待器（记日志）。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from astrbot.core import logger


class SessionController:
    """等待器控制器。stop() 之后该等待器不再接收后续消息。"""

    def __init__(self, waiter: "_Waiter") -> None:
        self._waiter = waiter
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True
        if self._waiter in _WAITERS:
            _WAITERS.remove(self._waiter)


class _Waiter:
    __slots__ = ("callback", "controller", "session_id", "sender_id", "deadline", "created_at")

    def __init__(
        self,
        callback: Callable[[SessionController, Any], Awaitable[None]],
        session_id: str,
        sender_id: str,
        timeout_s: float,
    ) -> None:
        self.callback = callback
        self.controller = SessionController(self)
        self.session_id = session_id
        self.sender_id = sender_id
        self.deadline = time.monotonic() + timeout_s
        self.created_at = time.time()


#: 全进程等待器注册表（(session_id, sender_id) 精确匹配）
_WAITERS: list[_Waiter] = []


def session_waiter(
    timeout: float = 30,
    record_history_chains: bool = True,
    **kwargs: Any,
) -> Callable[[Callable], Callable]:
    """装饰器形式的会话等待器（签名对齐上游）。"""

    def decorator(fn: Callable[[SessionController, Any], Awaitable[None]]) -> Callable[[Any], Awaitable[None]]:
        async def wrapper(event: Any) -> None:
            session_id = str(getattr(event, "session_id", "") or "")
            sender_id = str(getattr(event, "get_sender_id", lambda: "")() or "")
            waiter = _Waiter(fn, session_id, sender_id, float(timeout))
            _WAITERS.append(waiter)

            # 过期自清理：时间到静默注销（原请求早已返回，无法再投递超时提示）
            async def _expire() -> None:
                await asyncio.sleep(float(timeout))
                if waiter in _WAITERS:
                    _WAITERS.remove(waiter)
                    logger.info(
                        "[session_waiter] 等待 %s:%s 的回复超时（%.0fs），已注销",
                        session_id,
                        sender_id,
                        float(timeout),
                    )

            try:
                asyncio.get_running_loop().create_task(_expire())
            except RuntimeError:
                pass
            return None

        wrapper.__name__ = getattr(fn, "__name__", "session_waiter_wrapper")
        return wrapper

    return decorator


async def feed(event: Any) -> bool:
    """把一条新到达的消息喂给等待器注册表。

    命中第一个 (session_id, sender_id) 匹配且未过期的等待器，在当前协程里
    执行其回调并注销。返回是否命中。

    宿主在 /api/v1/events 里每条 message.received 都调用一次；没有等待器时
    这是一次空列表遍历，成本可忽略。
    """
    now = time.monotonic()
    for waiter in [w for w in _WAITERS if w.deadline <= now]:
        _WAITERS.remove(waiter)

    session_id = str(getattr(event, "session_id", "") or "")
    sender_id = str(getattr(event, "get_sender_id", lambda: "")() or "")

    for waiter in list(_WAITERS):
        if waiter.session_id == session_id and waiter.sender_id == sender_id:
            _WAITERS.remove(waiter)
            try:
                await waiter.callback(waiter.controller, event)
            except Exception as exc:  # noqa: BLE001 —— 等待器回调失败不该炸宿主
                logger.exception("[session_waiter] 回调执行失败: %s", exc)
            return True
    return False


def pending_count() -> int:
    """当前挂起的等待器数量（测试与自省用）。"""
    return len(_WAITERS)


__all__ = ["SessionController", "session_waiter", "feed", "pending_count"]

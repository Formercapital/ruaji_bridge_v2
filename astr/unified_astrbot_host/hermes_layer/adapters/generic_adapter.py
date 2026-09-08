"""hermes_layer.adapters.generic_adapter —— 无专属适配器插件的通用激活层。

## 解决什么问题

宿主核心（ContextBuilder 的 enrich 管道）只通过 ``UnifiedPluginContract``
调用插件的 on_llm_request。以前每接入一个插件都要在
``runtime/context.py`` 的硬编码 map 里加一行专属适配器——这就是
"插件粘宿主"的根源。

本适配器是**通用**的：构造时传入插件 key，其余逻辑不含任何插件名。
``runtime/context.py`` 在装配专属适配器之后，对剩下所有注册了
OnLLMRequestEvent 钩子的挂载插件自动挂一个 GenericPluginAdapter。
从此新插件接入 = config.yaml 一段声明，宿主零改动。

## 行为（镜像 LivingMemoryAdapter 的注入模式）

- provide_context：构造事件与请求副本 → 调该插件全部 on_llm_request
  handler → diff 出插件写入的 system_prompt / extra_parts → 转成
  ContextBlock 列表。插件抛异常或超时只损失自己的贡献，不拖垮聚合。
- decide_reply 返回 None：裁决是 GCP 的专属行为，通用插件不参与。
- 事件（message.received / llm.response）不走适配器，走
  host_server 的 dispatch_to 配置——那本来就是声明式的。
"""

from __future__ import annotations

import asyncio
import copy
import time
from typing import Any

from astrbot.core import logger
from astrbot.core.star.star_handler import EventType, star_handlers_registry

from hermes_layer.contracts import ContextBlock, InboundMessage, estimate_tokens
from hermes_layer.context_builder import build_event, build_request, _diff
from hermes_layer.dispatch import resolve_owner
from hermes_layer.plugin_contract import UnifiedPluginContract


class GenericPluginAdapter(UnifiedPluginContract):
    """给任意挂载插件提供 on_llm_request 注入链路的通用适配器。"""

    def __init__(self, unified: Any, plugin_key: str) -> None:
        self._unified = unified
        self._key = str(plugin_key)

    @property
    def plugin_key(self) -> str:
        return self._key

    @property
    def execution_order(self) -> int:
        # 100：晚于全部专属适配器（LM=10, GCP=20）。GCP 的差分保留逻辑
        # 会看见 LM 的贡献；通用插件的注入排在重写之后，不会被它碰。
        return 100

    async def initialize(self, context: Any, config: dict[str, Any]) -> None:  # noqa: ARG002
        logger.info(
            "[通用适配器] 已激活 %s 的注入链路（%d 个 on_llm_request 钩子）",
            self._key,
            len(self._llm_request_handlers()),
        )

    async def terminate(self) -> None:
        return None

    async def on_message_received(self, message: InboundMessage) -> None:  # noqa: ARG002
        """事件摄取走 host_server 的 dispatch_to，适配器不参与。"""
        return None

    async def decide_reply(self, message: InboundMessage, history: list[dict[str, Any]]) -> Any:  # noqa: ARG002
        return None

    async def provide_context(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
    ) -> list[ContextBlock]:
        handlers = self._llm_request_handlers()
        if not handlers or self._unified is None:
            return []
        if not self._plugin_instance():
            return []

        self_id = str(self._unified.config.get("identity", {}).get("robot_id", ""))
        event = build_event(message, self_id=self_id)
        req = build_request(message, history)
        baseline = copy.deepcopy(req)

        timeout_s = float(getattr(self._unified, "_context_timeout_s", 2.5))
        started = time.perf_counter()
        try:
            await asyncio.wait_for(self._invoke_all(event, req, handlers), timeout=timeout_s)
        except asyncio.TimeoutError:
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.warning(
                "[通用适配器] %s 上下文注入超时（>%.0fms），本轮丢弃其贡献",
                self._key,
                timeout_s * 1000,
            )
            return [
                ContextBlock(
                    source=self._key,
                    kind="system_prompt",
                    elapsed_ms=elapsed_ms,
                    error=f"timeout>{timeout_s * 1000:.0f}ms",
                )
            ]
        except Exception as exc:  # noqa: BLE001 —— 单插件异常不能拖垮聚合
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.exception("[通用适配器] %s 上下文注入异常", self._key)
            return [
                ContextBlock(
                    source=self._key,
                    kind="system_prompt",
                    elapsed_ms=elapsed_ms,
                    error=f"{type(exc).__name__}: {exc}",
                )
            ]

        elapsed_ms = (time.perf_counter() - started) * 1000
        blocks = _diff(baseline, req, self._key, elapsed_ms)
        if not blocks:
            # 与 LivingMemoryAdapter 同款：报告"跑了但没贡献"，聚合层据此展示
            return [
                ContextBlock(
                    source=self._key,
                    kind="system_prompt",
                    elapsed_ms=elapsed_ms,
                    detail={"ran": True, "contributed": False, "handlers": len(handlers)},
                )
            ]
        return blocks

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _llm_request_handlers(self) -> list[Any]:
        return [
            h
            for h in star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMRequestEvent)
            if resolve_owner(h, self._unified.mounts) == self._key
        ]

    def _plugin_instance(self) -> Any:
        mount = self._unified.mounts.get(self._key)
        return getattr(mount, "instance", None) or mount

    async def _invoke_all(self, event: Any, req: Any, handlers: list[Any]) -> None:
        for handler in handlers:
            fn = getattr(handler, "handler", None)
            if fn is None:
                continue
            result = fn(event, req)
            if asyncio.iscoroutine(result):
                await result
            elif hasattr(result, "__aiter__"):
                # 异步生成器 handler：必须迭代才会执行到 yield 之后
                async for _ in result:
                    pass


__all__ = ["GenericPluginAdapter"]

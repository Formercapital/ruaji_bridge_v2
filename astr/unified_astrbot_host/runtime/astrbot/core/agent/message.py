"""astrbot.core.agent.message —— LLM 消息的内容分片。

LivingMemory 用的只有一处，但那一处很关键：

    core/event_handler_modules/memory_recall.py:327
        TextPart(text=memory_str).mark_as_temp()

`mark_as_temp()` 的语义是"这段只给模型看，不写进会话历史"。回忆出来的记忆
必须是临时的 —— 否则下一轮又会把上一轮注入的记忆当成新对话再存一遍，
记忆库会自我复制到爆。所以 `_no_save` 这个标记不能省。
"""

from __future__ import annotations

from typing import Any, ClassVar, TypeVar

from pydantic import BaseModel, PrivateAttr

ContentPartT = TypeVar("ContentPartT", bound="ContentPart")


class ContentPart(BaseModel):
    """消息里的一个内容分片。"""

    # 上游用 __get_pydantic_core_schema__ 做按 type 分派的多态校验；
    # 垫片里没人拿 dict 反序列化成 ContentPart，只保留注册表本身。
    _registry: ClassVar[dict[str, type[ContentPart]]] = {}

    type: str
    _no_save: bool = PrivateAttr(default=False)

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        type_value = getattr(cls, "type", None)
        if isinstance(type_value, str):
            ContentPart._registry[type_value] = cls

    def mark_as_temp(self: ContentPartT) -> ContentPartT:
        """标记为"仅面向 Provider"，不落盘。"""
        self._no_save = True
        return self

    @property
    def no_save(self) -> bool:
        return self._no_save

    def model_dump_for_context(self) -> dict[str, Any]:
        data = self.model_dump()
        if self._no_save:
            data["_no_save"] = True
        return data


class TextPart(ContentPart):
    type: str = "text"
    text: str


class ThinkPart(ContentPart):
    type: str = "think"
    think: str
    encrypted: str | None = None


class ImageURLPart(ContentPart):
    type: str = "image_url"
    image_url: dict[str, Any] = {}


class Message(BaseModel):
    """一轮 LLM 消息。"""

    role: str = "user"
    content: str | list[ContentPart] | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None

    def text(self) -> str:
        if isinstance(self.content, str):
            return self.content
        if isinstance(self.content, list):
            return "".join(p.text for p in self.content if isinstance(p, TextPart))
        return ""


def is_checkpoint_message(message: Any) -> bool:
    """上游用于识别"检查点消息"（记忆整合边界）。

    统一宿主的会话历史没有 checkpoint 概念，恒为 False —— 上游插件
    （如 Favour_Ultra 的主动搭话历史读取）用它过滤，全部保留即可。
    """
    _ = message
    return False


def bind_checkpoint_messages(messages: list[Any]) -> list[Any]:
    """上游把历史消息绑定到检查点；垫片原样返回。"""
    return messages


__all__ = [
    "ContentPart",
    "ImageURLPart",
    "Message",
    "TextPart",
    "ThinkPart",
    "bind_checkpoint_messages",
    "is_checkpoint_message",
]

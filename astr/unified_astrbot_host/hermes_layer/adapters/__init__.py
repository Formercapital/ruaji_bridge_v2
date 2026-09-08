"""hermes_layer.adapters —— 插件适配器汇总。

- 专属适配器（LivingMemory / GCP）：需要宿主侧定制行为的插件。
- GenericPluginAdapter：其余插件的通用激活层，见 generic_adapter.py。
"""

from hermes_layer.adapters.living_memory_adapter import LivingMemoryAdapter
from hermes_layer.adapters.group_chat_plus_adapter import GroupChatPlusAdapter
from hermes_layer.adapters.generic_adapter import GenericPluginAdapter

__all__ = [
    "GenericPluginAdapter",
    "GroupChatPlusAdapter",
    "LivingMemoryAdapter",
]

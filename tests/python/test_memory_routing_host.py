import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, AsyncMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'astr/unified_astrbot_host'))

import bootstrap  # noqa: F401
from hermes_layer.contracts import InboundMessage
from host_server import HostServer
from astrbot.core.star.star_handler import EventType, star_handlers_registry
import host_server

OWNER_ID = '1216245687'
OTHER_ID = '2260757842'


class HostMemoryRoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.mock_unified = SimpleNamespace(
            config={
                'identity': {'owner_id': OWNER_ID, 'robot_id': '931338416'},
                'events': {'dispatch_to': ['living_memory']},
            },
            mounts={'living_memory': SimpleNamespace(instance=MagicMock())},
        )
        self.server = HostServer.__new__(HostServer)
        self.server.unified = self.mock_unified
        self.server.event_targets = ['living_memory']

    async def test_dispatch_llm_response_skips_owner_private(self):
        invoked = []

        class DummyHandler:
            __module__ = "astrbot_plugin_livingmemory"
            handler_name = "test_on_llm_response"
            handler_module_path = "astrbot_plugin_livingmemory"

            def __call__(self, event, resp):
                invoked.append((event, resp))

        dummy = DummyHandler()
        handler_obj = SimpleNamespace(
            handler=dummy,
            handler_name="test_on_llm_response",
            handler_module_path="astrbot_plugin_livingmemory",
            event_type=EventType.OnLLMResponseEvent,
            owner_module="astrbot_plugin_livingmemory",
            owner=self.mock_unified.mounts['living_memory'].instance,
        )

        orig_method = star_handlers_registry.get_handlers_by_event_type
        star_handlers_registry.get_handlers_by_event_type = lambda et: [handler_obj] if et == EventType.OnLLMResponseEvent else []

        try:
            # 1. 主人私聊
            owner_payload = {
                'userId': OWNER_ID,
                'messageType': 'private',
                'isPrivate': True,
                'isOwner': True,
                'completion_text': '主人你好',
            }
            results = await self.server._dispatch_llm_response(owner_payload)
            self.assertEqual(len(results), 0, "主人私聊必须跳过派发给 living_memory")
            self.assertEqual(len(invoked), 0, "handler 不得被执行")

            # 2. 非主人私聊
            other_payload = {
                'userId': OTHER_ID,
                'messageType': 'private',
                'isPrivate': True,
                'isOwner': False,
                'completion_text': '群友你好',
            }
            results = await self.server._dispatch_llm_response(other_payload)
            self.assertEqual(len(results), 1, "非主人私聊必须派发给 living_memory")
            self.assertEqual(results[0]['plugin'], 'living_memory')
            self.assertEqual(len(invoked), 1)

            # 3. 主人群聊
            group_payload = {
                'userId': OWNER_ID,
                'groupId': '123456',
                'messageType': 'group',
                'isPrivate': False,
                'isOwner': True,
                'completion_text': '大家晚上好',
            }
            results = await self.server._dispatch_llm_response(group_payload)
            self.assertEqual(len(results), 1, "群聊即使是主人也必须正常派发")
            self.assertEqual(len(invoked), 2)
        finally:
            star_handlers_registry.get_handlers_by_event_type = orig_method

    async def test_dispatch_event_skips_owner_private(self):
        invoked = []

        orig_run_handlers = host_server.run_handlers

        async def mock_run_handlers(event, handlers, mounts=None, timeout_s=5):
            invoked.append((event, handlers))
            return [{"plugin": "living_memory", "ok": True}], []

        host_server.run_handlers = mock_run_handlers

        dummy = SimpleNamespace(
            __module__="astrbot_plugin_livingmemory",
            handler_name="test_on_message",
            handler_module_path="astrbot_plugin_livingmemory",
        )
        handler_obj = SimpleNamespace(
            handler=dummy,
            handler_name="test_on_message",
            handler_module_path="astrbot_plugin_livingmemory",
            event_type=EventType.AdapterMessageEvent,
            owner_module="astrbot_plugin_livingmemory",
            owner=self.mock_unified.mounts['living_memory'].instance,
        )

        orig_method = star_handlers_registry.get_handlers_by_event_type
        star_handlers_registry.get_handlers_by_event_type = lambda et: [handler_obj] if et == EventType.AdapterMessageEvent else []

        try:
            # 1. 主人私聊消息
            owner_msg = InboundMessage(
                message_id='m1',
                user_id=OWNER_ID,
                is_private=True,
                role='owner',
                text='主人指令',
            )
            reports, _, _ = await self.server._dispatch_event(owner_msg)
            self.assertEqual(len(reports), 0, "主人私聊必须跳过消息摄取")
            self.assertEqual(len(invoked), 0)

            # 2. 非主人私聊消息
            other_msg = InboundMessage(
                message_id='m2',
                user_id=OTHER_ID,
                is_private=True,
                role='member',
                text='普通群友问好',
            )
            reports, _, _ = await self.server._dispatch_event(other_msg)
            self.assertEqual(len(reports), 1, "非主人私聊必须正常摄取")
            self.assertEqual(reports[0]['plugin'], 'living_memory')
            self.assertEqual(len(invoked), 1)

            # 3. 主人群聊消息
            group_msg = InboundMessage(
                message_id='m3',
                group_id='123456',
                user_id=OWNER_ID,
                is_private=False,
                role='owner',
                text='主人在群里说话',
            )
            reports, _, _ = await self.server._dispatch_event(group_msg)
            self.assertEqual(len(reports), 1, "群聊中主人消息必须正常摄取")
            self.assertEqual(len(invoked), 2)
        finally:
            star_handlers_registry.get_handlers_by_event_type = orig_method
            host_server.run_handlers = orig_run_handlers


if __name__ == '__main__':
    unittest.main()

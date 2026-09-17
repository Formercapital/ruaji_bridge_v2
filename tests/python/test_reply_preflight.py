import asyncio
import importlib.util
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'astr/unified_astrbot_host'))
import bootstrap
from hermes_layer.reply_preflight import check_reply_preflight
from host_server import HostServer
from hermes_layer.adapters.generic_adapter import GenericPluginAdapter
from hermes_layer.contracts import InboundMessage
sys.path.insert(0, str(ROOT / 'astr'))
from astrbot_plugin_Favour_Ultra.main import FavourManagerTool

spec = importlib.util.spec_from_file_location('favour_reply_gate', ROOT / 'astr/astrbot_plugin_Favour_Ultra/reply_gate.py')
gate_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate_module)


class ReplyPreflightTests(unittest.IsolatedAsyncioTestCase):
    async def test_cold_user_auto_is_stopped_without_sending_cold_reply(self):
        plugin = FavourManagerTool.__new__(FavourManagerTool)
        plugin.__dict__.update(self.plugin.__dict__)
        del plugin.check_reply_gate
        self.extra['_bridge_trigger_type'] = 'ai_decision'
        plugin.cold_violence_users['2'] = datetime.now() + timedelta(minutes=5)
        stopped, sent = [], []
        async def send(value):
            sent.append(value)
        event = SimpleNamespace(get_sender_id=lambda: '2', get_extra=self.extra.get,
                                stop_event=lambda: stopped.append(True), send=send,
                                plain_result=lambda value: value)
        req = SimpleNamespace(system_prompt='original', extra_user_content_parts=[])
        await plugin.inject_favour_prompt(event, req)
        self.assertEqual(stopped, [True], 'cold user must not trigger auto generation')
        self.assertEqual(sent, [], 'auto should not send even a cold-violence notice')
        self.assertEqual(req.system_prompt, 'original')
        self.assertEqual(req.extra_user_content_parts, [])

    async def test_auto_gate_through_real_host_adapter(self):
        plugin = FavourManagerTool.__new__(FavourManagerTool)
        plugin.__dict__.update(self.plugin.__dict__)
        del plugin.check_reply_gate
        unified = SimpleNamespace(config={}, mounts={'favour_ultra': SimpleNamespace(instance=plugin)})
        adapter = GenericPluginAdapter(unified, 'favour_ultra')
        adapter._llm_request_handlers = lambda: [SimpleNamespace(handler=plugin.inject_favour_prompt)]
        message = InboundMessage.from_payload({'userId': '2', 'groupId': '3', 'text': 'latest', 'triggerType': 'ai_decision'})
        for state in ['cold', 'blacklisted', 'expired', 'normal']:
            plugin.auto_blacklisted.clear()
            plugin.cold_violence_users.clear()
            if state == 'cold':
                plugin.cold_violence_users['2'] = datetime.now() + timedelta(minutes=5)
            if state == 'blacklisted':
                plugin.auto_blacklisted.add('2')
            if state == 'expired':
                plugin.cold_violence_users['2'] = datetime.now() - timedelta(seconds=1)
            blocks = await adapter.provide_context(message)
            self.assertEqual(any(b.detail.get('intercepted') for b in blocks), state in ['cold', 'blacklisted'])
            self.assertTrue(all(not b.content for b in blocks), 'no cold notice or favour prompt on auto')
            self.assertTrue(all(not b.error for b in blocks), 'no database access is required for auto')

    async def test_direct_cold_still_sends_notice(self):
        plugin = FavourManagerTool.__new__(FavourManagerTool)
        plugin.__dict__.update(self.plugin.__dict__)
        del plugin.check_reply_gate
        plugin.cold_violence_users['2'] = datetime.now() + timedelta(minutes=5)
        sent, stopped = [], []
        async def send(value):
            sent.append(value)
        event = SimpleNamespace(get_sender_id=lambda: '2', get_extra=self.extra.get,
                                stop_event=lambda: stopped.append(True), send=send, plain_result=lambda value: value)
        await plugin.inject_favour_prompt(event, SimpleNamespace())
        self.assertEqual(stopped, [True])
        self.assertEqual(len(sent), 1)

    def setUp(self):
        self.extra = {}
        self.event = SimpleNamespace(get_sender_id=lambda: '2', get_extra=self.extra.get)
        self.plugin = SimpleNamespace(
            _get_session_id=lambda event: 'global', _is_shared_session=lambda sid: ':' not in sid,
            _session_in_list=lambda sid, items: sid in items,
            _get_cold_violence_key=lambda uid, sid: uid,
            allowed_sessions=[], blocked_sessions=[], auto_blacklisted=set(),
            enable_cold_violence=True, cold_violence_users={},
            cold_violence_replies={'on_message': 'wait {time_str}'},
        )
        self.plugin.check_reply_gate = lambda event: gate_module.check_reply_gate(self.plugin, event)
        self.host = SimpleNamespace(mounts={'favour_ultra': SimpleNamespace(instance=self.plugin)})

    async def test_allow_blacklist_cold_and_expiry_are_read_only(self):
        self.assertTrue((await check_reply_preflight(self.host, self.event, ['favour_ultra']))['allowed'])
        self.plugin.auto_blacklisted.add('2')
        self.assertFalse(self.plugin.check_reply_gate(self.event)['allowed'])
        self.plugin.auto_blacklisted.clear()
        self.plugin.cold_violence_users['2'] = datetime.now() + timedelta(minutes=5)
        before = dict(self.plugin.cold_violence_users)
        for _ in range(2):
            result = await check_reply_preflight(self.host, self.event, ['favour_ultra'])
            self.assertTrue(result['ok'])
            self.assertEqual(result['reason'], 'cold_violence')
        self.assertEqual(before, self.plugin.cold_violence_users)
        self.plugin.cold_violence_users['2'] = datetime.now() - timedelta(seconds=1)
        self.assertTrue(self.plugin.check_reply_gate(self.event)['allowed'])
        self.assertIn('2', self.plugin.cold_violence_users)

    async def test_scope_and_auto_match_prompt_gate(self):
        self.plugin._get_session_id = lambda event: 'qq:group:3'
        self.plugin.auto_blacklisted.add('qq:group:3:2')
        self.assertFalse(self.plugin.check_reply_gate(self.event)['allowed'])
        self.plugin.allowed_sessions = ['other']
        self.assertTrue(self.plugin.check_reply_gate(self.event)['allowed'])
        self.plugin.allowed_sessions = []
        self.extra['_bridge_trigger_type'] = 'ai_decision'
        self.assertFalse(self.plugin.check_reply_gate(self.event)['allowed'])

    async def test_normal_injection_uses_same_guard_and_stops_before_database(self):
        plugin = FavourManagerTool.__new__(FavourManagerTool)
        plugin.__dict__.update(self.plugin.__dict__)
        del plugin.check_reply_gate
        plugin.auto_blacklisted.add('2')
        stopped = []
        event = SimpleNamespace(get_sender_id=lambda: '2', get_extra=self.extra.get,
                                stop_event=lambda: stopped.append(True))
        self.assertFalse(plugin.check_reply_gate(event)['allowed'])
        await plugin.inject_favour_prompt(event, SimpleNamespace())
        self.assertEqual(stopped, [True])

    async def test_missing_invalid_and_throwing_guard_fail_closed(self):
        self.assertFalse((await check_reply_preflight(SimpleNamespace(mounts={}), self.event, ['favour_ultra']))['ok'])
        for value in [None, {}, {'allowed': 'true'}]:
            self.plugin.check_reply_gate = lambda event: value
            self.assertFalse((await check_reply_preflight(self.host, self.event))['allowed'])
        def fail(event):
            raise RuntimeError('offline')
        self.plugin.check_reply_gate = fail
        self.assertFalse((await check_reply_preflight(self.host, self.event))['ok'])
        async def timeout(event):
            raise asyncio.TimeoutError()
        self.plugin.check_reply_gate = timeout
        self.assertFalse((await check_reply_preflight(self.host, self.event))['ok'])

    async def test_endpoint_reconstructs_event_and_requires_plugin(self):
        server = HostServer.__new__(HostServer)
        server.unified = SimpleNamespace(mounts=self.host.mounts, config={})
        seen = []
        original = self.plugin.check_reply_gate
        def record(event):
            seen.append((event.get_sender_id(), event.unified_msg_origin))
            return original(event)
        self.plugin.check_reply_gate = record
        for private in [False, True]:
            async def body():
                return {'userId': '2', 'groupId': '3', 'text': 'correction', 'isPrivate': private, 'requireFavour': True}
            response = await server.handle_reply_preflight(SimpleNamespace(json=body))
            self.assertTrue(json.loads(response.text)['allowed'])
        self.assertEqual(seen[0][0], '2')
        self.assertNotEqual(seen[0][1], seen[1][1])
        server.unified.mounts = {}
        response = await server.handle_reply_preflight(SimpleNamespace(json=body))
        self.assertFalse(json.loads(response.text)['allowed'])


if __name__ == '__main__':
    unittest.main()

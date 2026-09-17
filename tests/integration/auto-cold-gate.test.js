import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

test('silent host interception stops auto before model and sends no message', async () => {
  const logger = createTestLogger();
  const bus = new CapabilityBus({ logger });
  bus.register({ id: 'host', capability: 'context.enrich', invoke: async (input) => {
    assert.equal(input.triggerType, 'ai_decision');
    assert.equal(input.userId, '2');
    // Actual GenericPluginAdapter wire shape for event.stop_event() without send().
    return { blocks: [{ source: 'favour_ultra', content: '', detail: { intercepted: true, reply: null } }] };
  } });
  const sessions = new SessionStore();
  const config = { identity: {}, decision: { localWindowInject: 6 } };
  const context = new ContextFlow({ aggregator: new ContextAggregator({ capabilityBus: bus, logger }),
    sessionStore: sessions, config, logger });
  let modelCalls = 0;
  const flow = new InboundFlow({ config, sessionStore: sessions, contextFlow: context, logger,
    commandFlow: { _reply: () => assert.fail('silent interception must not send') },
    replyFlow: { run: async () => { modelCalls++; return { status: 'ok' }; }, waitForDelivery: async () => {} },
  });
  const inbound = createInboundMessage({ userId: '2', groupId: '3', messageType: 'group', text: 'latest message' });
  flow._buffer(inbound, { route: 'auto', triggerType: 'ai_decision' });
  await flow._runGeneration(inbound.executionKey);
  assert.equal(modelCalls, 0);
  assert.equal(sessions.isBusy(inbound.executionKey), false);
});

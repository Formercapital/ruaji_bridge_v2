import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand } from '../../src/core/command-registry.js';
import { canUseCommand, getIdentityRole } from '../../src/core/permission-policy.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { DecisionFlow } from '../../src/orchestration/decision-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { AffectionStore } from '../../src/storage/affection-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

const identity = { ownerId: '1', adminIds: ['2'], adminCommands: [], robotId: '9', botName: '瑞姬' };
const logger = createTestLogger();
const message = (text, userId = '2') => createInboundMessage({ text, userId, groupId: '10', messageType: 'group' });

test('role precedence and command matrix default deny admins, unknown commands and sensitive grants', () => {
  assert.equal(getIdentityRole('1', { ...identity, adminIds: ['1', '2'] }), 'owner');
  assert.equal(getIdentityRole(2, identity), 'admin');
  assert.equal(getIdentityRole('', {}), 'member');
  for (const entry of COMMANDS) {
    assert.equal(canUseCommand('owner', entry.id), true);
    assert.equal(canUseCommand('admin', entry.id, identity), false);
    assert.equal(canUseCommand('admin', entry.id, { ...identity, adminCommands: [entry.id] }), entry.adminGrantable === true);
    assert.equal(canUseCommand('member', entry.id, { adminCommands: [entry.id] }), entry.memberAllowed === true);
    for (const alias of entry.aliases) {
      assert.equal(findCommand(alias), entry);
      if (entry.arguments) assert.equal(findCommand(alias + '\t123'), entry);
      assert.equal(findCommand(alias + 'unexpected'), null);
    }
  }
  for (const role of ['owner', 'admin', 'member']) assert.equal(canUseCommand(role, '/future', { adminCommands: ['/future'] }), false);
});

test('/see 是放行的渲染修饰符：member 能用、命中即 forward 给模型不产生回复', async () => {
  assert.equal(findCommand('/see')?.id, '/see');
  assert.equal(findCommand('/see 这张图')?.id, '/see');
  assert.equal(canUseCommand('member', '/see', identity), true);
  assert.equal(canUseCommand('admin', '/see', identity), false, '管理员需显式授权，与其他命令同口径');

  const flow = new CommandFlow({ config: { identity: { ...identity, adminCommands: [] } }, logger });
  const inbound = message('/see 这张图', '3');
  assert.deepEqual(await flow.handle(inbound), { handled: false, command: null });
  assert.equal(inbound.flags.isCommand, true, '登记过才会回填 isCommand；forward 不产生回复');
});

test('every alias is gated before dispatch and Favour relay; grants are live and canonical', async () => {
  for (const favourUltraEnabled of [false, true]) {
    const config = { identity: { ...identity, adminCommands: [] }, favourUltraEnabled };
    const flow = new CommandFlow({ config, logger });
    let executions = 0;
    for (const entry of COMMANDS) if (entry.handler) flow[entry.handler] = async () => { executions++; return { handled: true }; };
    flow._relayFavourCommand = async () => { executions++; return { handled: true }; };
    for (const entry of COMMANDS) {
      for (const alias of entry.aliases) {
        config.identity.adminCommands = [];
        const before = executions;
        assert.equal((await flow.handle(message(alias))).handled, true);
        assert.equal(executions, before);
        config.identity.adminCommands = [entry.id];
        await flow.handle(message(alias));
        // forward 命令（/approve、/see）只放行给模型/下游，不执行任何 handler；
        // 其余 adminGrantable 命令被授权后应当真的跑一次 handler。
        assert.equal(executions - before, entry.adminGrantable && !entry.forward ? 1 : 0);
      }
    }
    const before = executions;
    assert.equal((await flow.handle(message('/future'))).handled, true);
    assert.equal((await flow.handle(message('/approve once'))).handled, true);
    assert.equal((await flow.handle(message('/approve once', '1'))).handled, false);
    assert.equal(executions, before);
    // Caller-supplied owner flags cannot promote an administrator.
    const forged = message('/new');
    forged.flags.isOwner = true;
    forged.flags.role = 'owner';
    await flow.handle(forged);
    assert.equal(executions, before);
  }
});

test('authorized Favour aliases relay a canonical command; revoke blocks immediately', async () => {
  const config = { identity: { ...identity, adminCommands: ['/冷暴力'] }, favourUltraEnabled: true };
  const flow = new CommandFlow({ config, logger });
  const relayed = [];
  flow._relayFavourCommand = async (_, text) => { relayed.push(text); return { handled: true }; };
  await flow.handle(message('瑞姬 /freeze\t30'));
  assert.deepEqual(relayed, ['/冷暴力\t30']);
  config.identity.adminCommands = [];
  await flow.handle(message('/冷暴力 30'));
  assert.equal(relayed.length, 1);
});

test('normalization preserves administrator identity without owner exemptions', async () => {
  const normalizer = new InboundNormalizer({ identity, wake: { mode: 'at' }, logger });
  const { message: inbound } = await normalizer.normalize({ post_type: 'message', message_type: 'group', user_id: 2, group_id: 10, self_id: 9, message_id: 1, raw_message: 'hello', message: [{ type: 'text', data: { text: 'hello' } }], sender: { nickname: 'admin' } });
  assert.equal(inbound.flags.isAdmin, true);
  assert.equal(inbound.flags.role, 'admin');
  assert.equal(inbound.flags.isOwner, false);
  const flow = new InboundFlow({ config: { identity: { ...identity, privateWhitelist: ['1'] } }, logger });
  assert.equal(flow._isPrivateAllowed('2'), false);
  const affection = new AffectionStore({ ownerId: '1', persistEnabled: false, logger });
  affection.onUserMessage({ uid: '2', nickname: 'admin' });
  assert.equal(affection.isOwner('2'), false);
  affection.triggerColdViolence('2', 60000);
  assert.equal(affection.isColdViolent('2'), true);
  const contextFlow = new ContextFlow({ aggregator: new ContextAggregator({ logger }), config: { identity }, affectionStore: affection, logger });
  assert.ok(contextFlow.getAffectionContext(inbound, 'at'), 'admin still receives affection context');
  const sessions = new SessionStore();
  const decisionFlow = new DecisionFlow({ config: { identity: { ...identity, rateLimitUsers: ['2'] }, decision: { rateLimit: { maxReplies: 1 } } }, sessionStore: sessions, logger });
  sessions.recordReply('2');
  assert.equal(decisionFlow._isRateLimited(inbound), true);
});

test('admin redirect failure falls back to preemption and loses privilege on removal', async () => {
  const config = { identity: { ...identity }, decision: { ownerRedirect: true, rateLimit: { maxReplies: 1, windowMs: 300000 } } };
  const sessions = new SessionStore();
  const flow = new DecisionFlow({ config, sessionStore: sessions, logger });
  const inbound = message('请补充细节');
  const controller = new AbortController();
  sessions.beginExecution(inbound.executionKey, { controller, sessionKey: 'active-key' });
  flow.modelRouter = { redirect: async () => ({ ok: false }) };
  assert.match(flow._redirectTextOf(inbound), /【管理员介入】/);
  config.identity.adminIds = [];
  assert.equal((await flow.arbitrateConcurrency(inbound)).action, 'queue');
  config.identity.adminIds = ['2'];
  assert.equal((await flow.arbitrateConcurrency(inbound)).action, 'preempt');
  assert.equal(controller.signal.aborted, true);
});

test('auto and external proactive messages never intervene regardless of identity or @', async () => {
  for (const userId of ['1', '2', '3']) {
    for (const isAtBot of [false, true]) {
      for (const external of [false, true]) {
        const sessions = new SessionStore();
        const flow = new DecisionFlow({ config: { identity, decision: { ownerRedirect: true } }, sessionStore: sessions, logger });
        flow.modelRouter = { redirect: async () => assert.fail('auto must never redirect') };
        const inbound = message('自动传递的消息', userId);
        inbound.flags.isAtBot = isAtBot;
        inbound.extensions.proactive = external;
        const decision = external ? null : { route: 'auto' };
        assert.equal((await flow.arbitrateConcurrency(inbound, decision)).action, 'start');
        const controller = new AbortController();
        sessions.beginExecution(inbound.executionKey, { controller, source: 'direct' });
        assert.equal((await flow.arbitrateConcurrency(inbound, decision)).action, isAtBot ? 'queue' : 'drop');
        assert.equal(controller.signal.aborted, false);
      }
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionFlow } from '../../src/orchestration/decision-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';
import { InboundFlow } from '../../src/orchestration/inbound-flow.js';

function setup(fetchImpl) {
  const config = { identity: { ownerId: '1', adminIds: ['2'] }, favourUltraEnabled: true,
    unifiedHost: { baseUrl: 'http://host' }, decision: { ownerRedirect: true } };
  const sessions = new SessionStore();
  const controller = new AbortController();
  const inbound = createInboundMessage({ userId: '2', groupId: '3', messageType: 'group', text: '纠正方向' });
  sessions.beginExecution(inbound.executionKey, { controller, sessionKey: 'original-run' });
  const calls = [];
  const flow = new DecisionFlow({ config, sessionStore: sessions, fetchImpl, logger: createTestLogger(),
    modelRouter: { redirect: async (...args) => { calls.push(args); return { ok: true }; } } });
  return { flow, config, sessions, controller, inbound, calls };
}
const response = (body, ok = true) => ({ ok, json: async () => body });

test('redirect rejection actively stops Hermes before allowing replacement generation', async () => {
  const ctx = setup(async () => response({ ok: true, allowed: true }));
  let finishStop;
  const stopped = new Promise((resolve) => { finishStop = resolve; });
  let stopCalls = 0;
  ctx.flow.modelRouter.redirect = async () => ({ ok: false, code: 'redirect_not_accepted' });
  ctx.flow.modelRouter.stop = async (key) => {
    assert.equal(key, 'original-run');
    stopCalls++;
    return stopped;
  };
  let settled = false;
  const pending = ctx.flow.arbitrateConcurrency(ctx.inbound).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  assert.equal(settled, false);
  assert.equal(ctx.controller.signal.aborted, true);
  finishStop({ ok: true, stopped: true });
  assert.equal((await pending).action, 'preempt');
});

test('queued generation and concurrent messages wait for outstanding server stop', async () => {
  const ctx = setup(async () => response({ ok: true, allowed: true }));
  ctx.flow.modelRouter.redirect = async () => ({ ok: false });
  let finishStop;
  ctx.flow.modelRouter.stop = () => new Promise((resolve) => { finishStop = resolve; });
  const pending = ctx.flow.arbitrateConcurrency(ctx.inbound);
  await new Promise((resolve) => setImmediate(resolve));
  let generated = 0;
  const flow = new InboundFlow({ config: ctx.config, sessionStore: ctx.sessions, logger: createTestLogger(),
    contextFlow: { collect: async () => ({ blocks: [] }) },
    replyFlow: { run: async () => { generated++; return { status: 'ok' }; }, waitForDelivery: async () => {} },
  });
  flow._buffer(ctx.inbound, { route: 'direct' });
  const generation = flow._runGeneration(ctx.inbound.executionKey);
  let concurrentSettled = false;
  const concurrent = ctx.flow.arbitrateConcurrency(ctx.inbound).then(() => { concurrentSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(generated, 0);
  assert.equal(concurrentSettled, false);
  finishStop({ ok: true, stopped: true });
  await Promise.all([pending, generation, concurrent]);
  assert.equal(generated, 1);
});

test('stop errors release the barrier and preserve local cancellation', async () => {
  const ctx = setup(async () => response({ ok: true, allowed: true }));
  ctx.flow.modelRouter.redirect = async () => ({ ok: false });
  ctx.flow.modelRouter.stop = async () => { throw new Error('unreachable'); };
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'preempt');
  await ctx.sessions.waitForStop(ctx.inbound.executionKey);
  assert.equal(ctx.controller.signal.aborted, true);
});

test('owner redirect rejection must not stop a replacement run', async () => {
  const ctx = setup(async () => assert.fail('owner does not preflight'));
  ctx.inbound.userId = '1';
  const replacement = new AbortController();
  ctx.flow.modelRouter.redirect = async () => {
    ctx.sessions.beginExecution(ctx.inbound.executionKey, { controller: replacement });
    return { ok: false };
  };
  ctx.flow.modelRouter.stop = async () => assert.fail('must not stop successor');
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'queue');
  assert.equal(replacement.signal.aborted, false);
});

test('admin preflight precedes redirect, preserves original run and labels administrator', async () => {
  let payload;
  const ctx = setup(async (url, opts) => {
    assert.equal(url, 'http://host/api/v1/reply/preflight');
    payload = JSON.parse(opts.body);
    assert.equal(ctx.calls.length, 0);
    return response({ ok: true, allowed: true });
  });
  const active = ctx.sessions.getActive(ctx.inbound.executionKey);
  assert.deepEqual(await ctx.flow.arbitrateConcurrency(ctx.inbound, { route: 'direct' }), { action: 'awaiting', redirected: true });
  assert.equal(payload.userId, '2');
  assert.equal(payload.requireFavour, true);
  assert.equal(payload.isPrivate, false);
  assert.equal(ctx.calls[0][0], 'original-run');
  assert.match(ctx.calls[0][1], /^【管理员介入】/);
  assert.equal(ctx.sessions.getActive(ctx.inbound.executionKey), active);
  assert.equal(ctx.controller.signal.aborted, false);
});

test('deny, unavailable, malformed and failed checks never redirect or interrupt', async () => {
  for (const fetchImpl of [
    async () => response({ ok: true, allowed: false }),
    async () => response({ ok: false, allowed: true }),
    async () => response({ ok: true, allowed: true }, false),
    async () => response({}),
    async () => { throw new Error('timeout'); },
    async () => ({ ok: true, json: async () => { throw new Error('invalid json'); } }),
  ]) {
    const ctx = setup(fetchImpl);
    assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'drop');
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.controller.signal.aborted, false);
  }
});

test('successful preflight plus rejected redirect falls back to normal generation', async () => {
  const ctx = setup(async () => response({ ok: true, allowed: true }));
  ctx.flow.modelRouter.redirect = async () => ({ ok: false });
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'preempt');
  assert.equal(ctx.controller.signal.aborted, true);
});

test('preflight races do not redirect into replacement runs or after revocation', async () => {
  for (const scenario of ['ended', 'replaced', 'revoked']) {
    const ctx = setup(async () => {
      if (scenario === 'ended') ctx.sessions.endExecution(ctx.inbound.executionKey, ctx.controller);
      if (scenario === 'replaced') ctx.sessions.beginExecution(ctx.inbound.executionKey, { controller: new AbortController() });
      if (scenario === 'revoked') ctx.config.identity.adminIds = [];
      return response({ ok: true, allowed: true });
    });
    assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, { ended: 'start', replaced: 'queue', revoked: 'drop' }[scenario]);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.controller.signal.aborted, false);
  }
});

test('owner and auto bypass administrator preflight; auto still cannot intervene', async () => {
  const ctx = setup(async () => assert.fail('must not run preflight'));
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound, { route: 'auto' })).action, 'drop');
  ctx.inbound.userId = '1';
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound, { route: 'direct' })).action, 'awaiting');
});

test('legacy cold violence and missing required host fail closed', async () => {
  const ctx = setup(async () => assert.fail('no host call'));
  ctx.config.unifiedHost = {};
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'drop');
  ctx.config.favourUltraEnabled = false;
  ctx.flow.affection = { isColdViolent: () => true };
  assert.equal((await ctx.flow.arbitrateConcurrency(ctx.inbound)).action, 'drop');
  assert.equal(ctx.controller.signal.aborted, false);
});

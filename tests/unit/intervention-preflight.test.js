import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionFlow } from '../../src/orchestration/decision-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

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

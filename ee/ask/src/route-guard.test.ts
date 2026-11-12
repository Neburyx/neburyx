import { ExtensionRefusal, aiStatusResponseSchema, parseExtensionRefusal, type AuditEvent, type ExtensionRequest, type ExtensionRouteGroup } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from './route-guard.js';
import { buildPromptRegistry } from './prompts.js';
import { replyKey, createFixtureProvider } from './testing/fixture.js';
import type { ModelRequest } from './provider.js';

const SIGNAL = new AbortController().signal;
const MODEL_REQUEST: ModelRequest = { promptId: 'ask.plan', parameters: { catalog: 'T1', question: 'who is ‹person#1›?' } };

async function fixture() {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new Error(built.problems.join('; '));
  return createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'draft' } } });
}

function requestOf(options: { readonly previewOn: boolean; readonly record?: (event: AuditEvent) => Promise<void> }): { readonly request: ExtensionRequest; readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const record = options.record ?? (async (event: AuditEvent) => void events.push(event));
  return { events, request: { principalId: 'principal-1', principalRole: 'investigator', previewOn: options.previewOn, traceId: 'tr-1', audit: { record } } };
}

async function groupOf() {
  const provider = await fixture();
  const calls: string[] = [];
  const group: ExtensionRouteGroup = {
    routes: [
      { method: 'GET', url: '/v1/ai/probe', permission: 'principal', responseSchema: aiStatusResponseSchema, handler: async () => (calls.push('probe'), (await provider.complete(MODEL_REQUEST, SIGNAL)).status) },
      { method: 'GET', url: '/v1/ai/other', permission: 'principal', responseSchema: aiStatusResponseSchema, handler: async () => (calls.push('other'), 'other answer') },
    ],
  };
  return { provider, calls, guarded: guardAiRouteGroup(group) };
}

const refusalOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('the route-group hook with the preview on', () => {
  it('runs each wrapped handler and returns its answer unchanged, with no source in the call', async () => {
    const { guarded, calls, provider } = await groupOf();
    const { request, events } = requestOf({ previewOn: true });
    expect(await guarded.routes[0]?.handler(request)).toBe('ok');
    expect(await guarded.routes[1]?.handler(request)).toBe('other answer');
    expect(calls).toEqual(['probe', 'other']);
    expect(provider.calls).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('the route-group hook with the preview off', () => {
  it('does not run the handler, refuses with the reason, and the fixture records no provider call', async () => {
    const { guarded, calls, provider } = await groupOf();
    const { request } = requestOf({ previewOn: false });
    const thrown = await refusalOf(Promise.resolve(guarded.routes[0]?.handler(request)));
    expect(thrown).toBeInstanceOf(ExtensionRefusal);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: true });
    expect(calls).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('records one refusal event first, with the actor and trace and no source, resource or detail', async () => {
    const { guarded } = await groupOf();
    const { request, events } = requestOf({ previewOn: false });
    await refusalOf(Promise.resolve(guarded.routes[0]?.handler(request)));
    expect(events).toEqual([{ actorId: 'principal-1', actorRole: 'investigator', action: ROUTE_REFUSED_ACTION, result: 'refused', traceId: 'tr-1' }]);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['action', 'actorId', 'actorRole', 'result', 'traceId']);
  });

  it('still refuses, with the audited mark false, and runs no handler when the audit write fails', async () => {
    const { guarded, calls, provider } = await groupOf();
    const { request } = requestOf({ previewOn: false, record: async () => Promise.reject(new Error('down')) });
    const thrown = await refusalOf(Promise.resolve(guarded.routes[0]?.handler(request)));
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: false });
    expect(calls).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses every route of the group, one event for each call', async () => {
    const { guarded } = await groupOf();
    const { request, events } = requestOf({ previewOn: false });
    for (const route of guarded.routes) expect(parseExtensionRefusal(await refusalOf(Promise.resolve(route.handler(request))))?.reason).toBe('ai-preview-off');
    expect(events).toHaveLength(2);
  });
});

describe('a group passed to the hook', () => {
  it('keeps the routes in their order with their method, URL, permission and schema', async () => {
    const { guarded } = await groupOf();
    expect(guarded.routes.map((route) => [route.method, route.url, route.permission])).toEqual([['GET', '/v1/ai/probe', 'principal'], ['GET', '/v1/ai/other', 'principal']]);
  });
});

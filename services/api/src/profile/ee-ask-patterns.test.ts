import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { linkedRow } from '../testing/linked-entities-fixtures.js';
import { oneStepRow } from '../testing/pattern-fixtures.js';
import { DEFINITION, OTHER_IDENTITY, patternApp, type PatternApp } from '../testing/saved-pattern-rig.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

afterAll(removeAskFolders);

const INTENTS = { makerById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'maker', stableId: '$id' } } } };
const ANCHOR = 'W-1';
const jsonHeaders = { 'content-type': 'application/json' };

const answerRows = (call: ExecuteCall): Promise<ExecuteOutcome> =>
  Promise.resolve({
    status: 'rows',
    rows: call.templateId === 'pattern' ? [oneStepRow('W-1', 'W-2')] : call.templateId === 'linked-entities' ? [linkedRow({ anchor: 'W-1', match: 'W-2' })] : call.templateId === 'pattern-count' ? [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] : [],
  });

/** A stand-in for the model service: it records what it is sent and answers the next reply it was given. */
let stub: Server;
let baseUrl = '';
const received: string[] = [];
let replies: string[] = [];
beforeAll(async () => {
  stub = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: replies.shift() ?? '{"intent":null,"entities":{}}' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

/** The application with the real enterprise extension (its own classifier and provider, the model stand-in behind it) and a person who has saved patterns; another person has a shared and a private one on the same source. */
async function started(options: { readonly heavy?: boolean } = {}) {
  received.length = 0;
  replies = [];
  const extension = createEnterpriseExtension({ modelBaseUrl: baseUrl });
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS), NEBURYX_ASK_MAX_RETRIES: '0', NEBURYX_ASK_TIMEOUT_MS: '5000' }, { sourceIds: ['demo'] });
  expect(configured?.ok).toBe(true);
  extension.createAuditSink?.({ databaseUrl: 'postgres://app@127.0.0.1:1/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: randomUUID, onConnectionError: () => undefined });
  const heavyProbe = { templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches: 1_000_000, bounded: false, notices: [] }) };
  const context = await patternApp({ answer: answerRows, extension, ...(options.heavy === true ? { probes: new Map([['pattern', heavyProbe]]) } : {}) });
  const other = await patternApp({ sharing: context.store, identity: OTHER_IDENTITY });
  const save = async (who: PatternApp, name: string, body: Record<string, unknown> = {}): Promise<string> => {
    const response = await who.app.inject({ method: 'POST', url: '/v1/patterns', payload: { sourceId: 'demo', name, kind: 'definition', definition: DEFINITION, ...body }, headers: jsonHeaders });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  };
  const ownHeld = await save(context, 'OWN-HELD-NAME', { anchor: { entityType: 'maker', stableId: 'H-1' } });
  const ownAsked = await save(context, 'OWN-ASKED-NAME');
  const sharedId = await save(other, 'OTHERS-SHARED-NAME');
  const privateId = await save(other, 'OTHERS-PRIVATE-NAME');
  const row = other.store.patternRows.find((held) => held.id === sharedId);
  if (row === undefined) throw new Error('not saved');
  other.store.patternRows.splice(other.store.patternRows.indexOf(row), 1, { ...row, visibility: 'shared' });
  const ask = (question: string, reply: string) => {
    replies.push(reply);
    return context.app.inject({ method: 'POST', url: '/v1/ask', payload: { sourceId: 'demo', question }, headers: jsonHeaders });
  };
  return { context, other, ask, ownHeld, ownAsked, sharedId, privateId };
}

const sentCatalog = (): string => {
  const body = JSON.parse(received.at(-1) ?? '{}') as { messages?: { content?: unknown }[] };
  return JSON.stringify(body.messages);
};

describe('a question that names a saved pattern, through the real mount and the extension’s own classifier', () => {
  it('sends the model the caller’s own pattern names and none of another person’s, shared or private', async () => {
    const { ask, context, other } = await started();
    await ask('Run my pattern', '{"intent":null,"entities":{}}');
    const sent = received.at(-1) ?? '';
    expect(sent).toContain('OWN-HELD-NAME');
    expect(sent).toContain('OWN-ASKED-NAME');
    expect(sent).not.toMatch(/OTHERS-SHARED-NAME|OTHERS-PRIVATE-NAME/);
    await context.app.close();
    await other.app.close();
  });

  it('refuses a reply that names the key of nothing, and a reply that names the id of the other person’s pattern, as nothing found, with no read of the source', async () => {
    const { ask, context, other, sharedId } = await started();
    for (const pattern of ['pat_9', sharedId]) {
      const answer = await ask('Run it', JSON.stringify({ intent: 'saved-pattern', entities: { pattern } }));
      expect(answer.json()).toMatchObject({ refused: { cause: 'nothing-found' } });
    }
    expect(context.executor.calls.filter((call) => call.templateId === 'pattern')).toEqual([]);
    await context.app.close();
    await other.app.close();
  });

  it('runs a held pattern and an asked pattern once each through the gate, as the caller, and answers with the label', async () => {
    const { ask, context, other, ownHeld, ownAsked } = await started();
    await ask('prime the catalog', '{"intent":null,"entities":{}}');
    const catalog = sentCatalog();
    const heldKey = /pat_\d+(?=, named \\"OWN-HELD-NAME)/.exec(catalog)?.[0] ?? '';
    const askedKey = /pat_\d+(?=, named \\"OWN-ASKED-NAME)/.exec(catalog)?.[0] ?? '';
    expect([heldKey, askedKey].every((key) => key !== '')).toBe(true);
    const held = await ask('Run my held pattern', JSON.stringify({ intent: 'saved-pattern', entities: { pattern: heldKey } }));
    expect(held.json()).toMatchObject({ answered: { intent: 'saved-pattern', entities: { pattern: ownHeld }, patternName: 'OWN-HELD-NAME', outcome: 'complete', result: { templateId: 'saved-pattern' } } });
    const asked = await ask(`Run my pattern on ${ANCHOR}`, JSON.stringify({ intent: 'saved-pattern', entities: { pattern: askedKey, anchor: ANCHOR } }));
    expect(asked.json()).toMatchObject({ answered: { entities: { pattern: ownAsked, anchor: ANCHOR }, patternName: 'OWN-ASKED-NAME' } });
    expect(context.executor.calls.filter((call) => call.templateId === 'pattern')).toHaveLength(2);
    const events = JSON.stringify(context.audit.events.filter((event) => event.action === 'ask.question'));
    expect(events).not.toMatch(/OWN-HELD-NAME|OWN-ASKED-NAME|W-1/);
    await context.app.close();
    await other.app.close();
  });

  it('stops a pattern that would read too much, and a Continue with its token reads one bounded page as the same pattern without asking the model again', async () => {
    const { ask, context, other, ownHeld } = await started({ heavy: true });
    await ask('prime the catalog', '{"intent":null,"entities":{}}');
    const heldKey = /pat_\d+(?=, named \\"OWN-HELD-NAME)/.exec(sentCatalog())?.[0] ?? '';
    const stop = (await ask('Run my held pattern', JSON.stringify({ intent: 'saved-pattern', entities: { pattern: heldKey } }))).json() as { answered: { continueToken: string; summary?: unknown } };
    expect(stop.answered.continueToken).toMatch(/^[0-9]{13}\.[0-9a-f]{64}$/);
    expect(stop.answered.summary).toBeUndefined();
    const readsBefore = context.executor.calls.filter((call) => call.templateId === 'pattern').length;
    const modelCalls = received.length;
    const page = await context.app.inject({ method: 'POST', url: '/v1/ask/continue', payload: { sourceId: 'demo', intent: 'saved-pattern', entities: { pattern: ownHeld }, continueToken: stop.answered.continueToken }, headers: jsonHeaders });
    expect(page.json()).toMatchObject({ answered: { intent: 'saved-pattern', entities: { pattern: ownHeld }, patternName: 'OWN-HELD-NAME', outcome: 'complete', result: { templateId: 'saved-pattern' } } });
    expect(context.executor.calls.filter((call) => call.templateId === 'pattern').length).toBeGreaterThan(readsBefore);
    expect(received).toHaveLength(modelCalls);
    expect(context.audit.events.filter((event) => event.action === 'pattern.list')).toEqual([]);
    await context.app.close();
    await other.app.close();
  });

  it('answers a Continue for a source that is not configured as continue-invalid, naming no source in any event', async () => {
    const { context, other, ownHeld } = await started();
    const answer = await context.app.inject({ method: 'POST', url: '/v1/ask/continue', payload: { sourceId: 'nowhere', intent: 'saved-pattern', entities: { pattern: ownHeld }, continueToken: `${Date.now() + 60_000}.${'a'.repeat(64)}` }, headers: jsonHeaders });
    expect([answer.statusCode, answer.json().error.details]).toEqual([400, { reason: 'continue-invalid' }]);
    expect(JSON.stringify(context.audit.events)).not.toContain('nowhere');
    expect(context.executor.calls.filter((call) => call.templateId === 'pattern')).toEqual([]);
    await context.app.close();
    await other.app.close();
  });

  it('refuses a Continue for a pattern of the caller with a token that was not issued, or for another person’s pattern, as continue-invalid with no source in the event', async () => {
    const { context, other, ownHeld, sharedId } = await started();
    for (const id of [ownHeld, sharedId]) {
      const answer = await context.app.inject({ method: 'POST', url: '/v1/ask/continue', payload: { sourceId: 'demo', intent: 'saved-pattern', entities: { pattern: id }, continueToken: `${Date.now() + 60_000}.${'a'.repeat(64)}` }, headers: jsonHeaders });
      expect([answer.statusCode, answer.json().error.details]).toEqual([400, { reason: 'continue-invalid' }]);
    }
    const events = context.audit.events.filter((event) => event.action === 'ask.continue');
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.sourceId === undefined)).toBe(true);
    expect(context.executor.calls.filter((call) => call.templateId === 'pattern')).toEqual([]);
    await context.app.close();
    await other.app.close();
  });
});

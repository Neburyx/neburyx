import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall } from './executor.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

const mapping = mappingOf(
  sourceWith('demo', {
    entities: [
      { type: 'thing', label: 'Thing', stable_id: 'thingId' },
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
    ],
    relationships: [{ type: 'USES', from: 'thing', to: 'phone', observed_at: 'seenAt' }],
    derived: [],
  }),
);
const [found] = mapping.sources;
if (found === undefined) throw new Error('no source');
const source = found;

const VALUES = ['+1-212-555-0100', '+1-212-555-0101', '+1-212-555-0102'];
const thing = plainNode(['Thing'], { thingId: 'T-1' }, 'e-thing');
const phone = (value: string) => plainNode(['Handle'], { phoneNumber: value }, `e-${value}`);
const when = { $type: 'dateTime', value: '2026-03-01T10:00:00Z' };
const rowOf = (value: string) => ({ a: thing, m: phone(value), rel: null, phase: 1, ts: when, id: value, rtype: 'USES', dir: 'out', ntype: 'phone', flag: null, members: 2, first: when });

function rig() {
  const events: AuditEvent[] = [];
  const logs: object[] = [];
  const executor = new TestExecutor(
    withOnlineIndexes(source, (call: ExecuteCall) => {
      const after = call.parameters['cursor'];
      const afterId = typeof after === 'object' && after !== null && 'id' in after ? String(after['id']) : undefined;
      const rows = VALUES.filter((value) => afterId === undefined || value < afterId).sort().reverse().slice(0, call.rowLimit).map(rowOf);
      return Promise.resolve({ status: 'rows' as const, rows });
    }),
  );
  const defaults = communitySeams();
  const parts = testSourceGate(mapping, { executor, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } }, logger: { warn: (fields) => void logs.push(fields) } });
  const read = (extra: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    parts.gate.run(gateRequest({ sourceId: 'demo', templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'thing', stableId: 'T-1', neighborType: 'phone', direction: 'out', sort: 'observed', ...extra }, limit: 1, indexes: { sourceId: 'demo', entries: onlineIndexesOf(source).map((row) => ({ ...row })) } as never, ...more }));
  return { read, executor, events, logs };
}

const payloadOf = (cursor: string): string => Buffer.from(cursor.split('.')[1] ?? '', 'base64url').toString('utf8');
const item = (page: { readonly items: readonly unknown[] }) => page.items[0] as ExpansionPage;

describe('the expansion of a keyed entity type', () => {
  it('shows the neighbors as tokens and holds no raw value in the cursor, which the gate reads back for the next page', async () => {
    const { read, executor } = rig();
    const first = await read({});
    const cursor = first.nextCursor ?? '';
    expect(cursor).toMatch(/^v1\./);
    for (const value of VALUES) expect(payloadOf(cursor)).not.toContain(value);
    expect(JSON.stringify(item(first).edges.map((edge) => edge.to.stableId))).not.toContain('+1-212');
    expect(item(first).edges[0]?.to.stableId).toMatch(/^p1\./);
    await read({}, { cursor });
    const sent = executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID)[1]?.parameters['cursor'];
    expect(sent).toMatchObject({ id: '+1-212-555-0102', nType: 'phone' });
  });

  it('expands from a keyed node by its token, reads the token back, and refuses a token of another type or source', async () => {
    const { read, executor } = rig();
    const token = item(await read({})).edges[0]?.to.stableId ?? '';
    await read({ entityType: 'phone', stableId: token, neighborType: 'thing', direction: 'in' }).catch(() => undefined);
    const calls = executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID);
    expect(calls.at(-1)?.parameters['stableId']).toBe('+1-212-555-0102');
    for (const text of ['p1.junk', '+1-212-555-0100', `${token}x`]) {
      const failure = await read({ entityType: 'phone', stableId: text, neighborType: 'thing', direction: 'in' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('does not refuse a masked request that pages keyed neighbors, and shows no raw value', async () => {
    const { read } = rig();
    const page = await read({}, { mask: true });
    const text = JSON.stringify(page);
    for (const value of VALUES) expect(text).not.toContain(value);
    expect(item(page).nodes.some((node) => node.properties.some((property) => property.masked))).toBe(true);
  });

  it('writes no raw value, token or cursor into the audit events or the logs', async () => {
    const { read, events, logs } = rig();
    const first = await read({});
    await read({}, { cursor: first.nextCursor });
    const text = JSON.stringify([events, logs]);
    for (const value of VALUES) expect(text).not.toContain(value);
    expect(text).not.toContain('p1.');
    expect(text).not.toContain('v1.');
  });
});

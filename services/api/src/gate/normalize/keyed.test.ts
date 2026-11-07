import { nodeSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { mappingOf, sourceWith } from '../../testing/gate-fixtures.js';
import { TEST_REFERENCE_KEYS } from '../../testing/gate.js';
import { plainNode, plainRelationship } from '../../testing/normalize-fixtures.js';
import { readToken } from '../../reference/token.js';
import { redactItems } from '../redact/index.js';
import type { GateContext } from '../types.js';
import { normalizeModelOf, type NormalizeContext } from './model.js';
import { normalizeRows } from './index.js';
import { DEFAULT_BUDGETS } from '../budgets.js';
import { EMPTY_ALLOWLIST, LOCAL_PRINCIPAL } from '../../testing/gate.js';

const PHONE = '+1-212-555-0100';
const mapping = (phone: Record<string, unknown> = {}) =>
  mappingOf(
    sourceWith('alpha', {
      entities: [
        { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }], search: ['phoneNumber'], ...phone },
        { type: 'person', label: 'Person', stable_id: 'personId', title: 'Person {personId}' },
      ],
      relationships: [
        { type: 'HAS_PHONE', from: 'person', to: 'phone' },
        { type: 'OWNS_PHONE', from: 'person', to: 'phone', stable_id: 'linkId' },
      ],
      derived: [],
    }),
  ).sources[0];
const modelOf = (phone?: Record<string, unknown>) => {
  const source = mapping(phone);
  if (source === undefined) throw new Error('no source');
  return normalizeModelOf(source);
};
const context = (overrides: Partial<NormalizeContext> = {}): NormalizeContext => ({ sourceId: 'request-source', hasMore: false, model: modelOf(), references: TEST_REFERENCE_KEYS, ...overrides });
const phoneNode = (value: unknown = PHONE) => plainNode(['Handle'], { phoneNumber: value });
const personNode = (id = 'p1') => plainNode(['Person'], { personId: id });
const row = (...values: unknown[]) => ({ values });
const place = { sourceId: 'request-source', entityType: 'phone' };

function redacted(result: ReturnType<typeof normalizeRows>, mask: boolean, model = modelOf()) {
  const gateContext: GateContext = { traceId: 't', principal: LOCAL_PRINCIPAL, system: false, sourceId: 'request-source', budgets: DEFAULT_BUDGETS, allowlist: EMPTY_ALLOWLIST, policyVersion: 'none', mask, model, deadlineAt: 0 };
  const [item] = redactItems([{ ...result }], gateContext);
  return item as unknown as ReturnType<typeof normalizeRows>;
}

describe('a node of a keyed entity type', () => {
  it('carries the token of its value as its reference, which reads back to the value only for its source and type', () => {
    const [node] = normalizeRows(context(), [{ n: phoneNode() }]).nodes;
    expect(node?.ref.entityType).toBe('phone');
    expect(node?.ref.stableId).toMatch(/^p1\./);
    expect(readToken(TEST_REFERENCE_KEYS, place, node?.ref.stableId ?? '')).toBe(PHONE);
    expect(() => readToken(TEST_REFERENCE_KEYS, { sourceId: 'other', entityType: 'phone' }, node?.ref.stableId ?? '')).toThrow();
    expect(nodeSchema.safeParse(node).success).toBe(true);
  });

  it('is the same reference each time, and a different one for another value', () => {
    const first = normalizeRows(context(), [{ n: phoneNode() }, { n: phoneNode() }, { n: phoneNode('+1-212-555-0199') }]);
    expect(first.nodes).toHaveLength(2);
    expect(first.nodes[0]?.ref.stableId).not.toBe(first.nodes[1]?.ref.stableId);
    expect(normalizeRows(context(), [{ n: phoneNode() }]).nodes[0]?.ref.stableId).toBe(first.nodes[0]?.ref.stableId);
  });

  it('keeps the node of a type that is not keyed under its raw ID', () => {
    const [node] = normalizeRows(context(), [{ n: personNode('p1') }]).nodes;
    expect(node?.ref).toEqual({ sourceId: 'request-source', entityType: 'person', stableId: 'p1' });
  });

  it('puts the token, and never the value, at the end of an aggregate edge and of a stored edge', () => {
    const owner = personNode();
    const phone = phoneNode();
    const aggregate = normalizeRows(context(), [row(owner, plainRelationship('HAS_PHONE', owner, phone), phone)]);
    const stored = normalizeRows(context(), [row(owner, plainRelationship('OWNS_PHONE', owner, phone, { linkId: 'L-1' }), phone)]);
    for (const result of [aggregate, stored]) {
      const [edge] = result.edges;
      expect(edge?.to.stableId).toMatch(/^p1\./);
      expect(readToken(TEST_REFERENCE_KEYS, place, edge?.to.stableId ?? '')).toBe(PHONE);
      expect(JSON.stringify(edge)).not.toContain(PHONE);
    }
    const [aggregateEdge] = aggregate.edges;
    expect(aggregateEdge !== undefined && 'aggregate' in aggregateEdge.ref ? aggregateEdge.ref.aggregate.to.stableId : '').toMatch(/^p1\./);
  });

  it('holds the value only in its own pii property: unmasked in the property, masked under a mask, and never in the reference', () => {
    const result = normalizeRows(context(), [{ n: phoneNode() }]);
    const unmasked = redacted(result, false).nodes[0];
    expect(unmasked?.properties.find((property) => property.key === 'phoneNumber')).toMatchObject({ value: PHONE, masked: false });
    const masked = redacted(result, true).nodes[0];
    const property = masked?.properties.find((candidate) => candidate.key === 'phoneNumber');
    expect(property?.masked).toBe(true);
    expect(JSON.stringify(masked)).not.toContain(PHONE);
    expect(masked?.ref.stableId).toBe(unmasked?.ref.stableId);
  });

  it('refuses to be normalized without the reference keys, instead of leaving the value as the reference', () => {
    expect(() => normalizeRows(context({ references: undefined }), [{ n: phoneNode() }])).toThrow();
  });
});

describe('the title of a keyed node', () => {
  const nodeOf = (model: ReturnType<typeof modelOf>, value: unknown = PHONE, extra: Record<string, unknown> = {}) => normalizeRows({ sourceId: 'request-source', hasMore: false, model, references: TEST_REFERENCE_KEYS }, [{ n: plainNode(['Handle'], { phoneNumber: value, ...extra }) }]);

  it('is the default title {stable_id}: the value unmasked, masked under a mask', () => {
    const model = modelOf();
    const result = nodeOf(model);
    expect(result.nodes[0]?.display.title).toBe(PHONE);
    expect(redacted(result, false, model).nodes[0]?.display.title).toBe(PHONE);
    const masked = redacted(result, true, model).nodes[0]?.display.title ?? '';
    expect(masked).not.toContain('212');
    expect(masked).not.toBe(PHONE);
  });

  it('is an explicit title built from the stable ID and another field: the value unmasked, the mask of it under a mask', () => {
    const model = modelOf({ title: 'Handle {phoneNumber} ({phoneKind})', pii: [{ property: 'phoneNumber', class: 'phone' }], filterable: ['phoneKind'] });
    const result = nodeOf(model, PHONE, { phoneKind: 'mobile' });
    expect(result.nodes[0]?.display.title).toBe(`Handle ${PHONE} (mobile)`);
    const masked = redacted(result, true, model).nodes[0]?.display.title ?? '';
    expect(masked).toMatch(/^Handle .* \(mobile\)$/);
    expect(masked).not.toContain('212-555');
  });

  it('falls back to the type and the stable ID when a placeholder is missing: the value unmasked, and under a mask the stable ID is masked', () => {
    const model = modelOf({ title: 'Handle {phoneNumber} {carrier}', filterable: ['carrier'] });
    const result = nodeOf(model);
    expect(result.nodes[0]?.qualityFlags).toContain('title-incomplete');
    expect(result.nodes[0]?.display.title).toBe(`phone ${PHONE}`);
    expect(redacted(result, false, model).nodes[0]?.display.title).toBe(`phone ${PHONE}`);
    const masked = redacted(result, true, model).nodes[0]?.display.title ?? '';
    expect(masked.startsWith('phone ')).toBe(true);
    expect(masked).not.toContain('212-555');
    expect(masked).not.toContain(PHONE);
  });
});


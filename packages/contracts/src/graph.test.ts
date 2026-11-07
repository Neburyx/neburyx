import { describe, expect, it } from 'vitest';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema } from './graph.js';

const node = {
  ref: { sourceId: 'alpha', entityType: 'gadget', stableId: 'g-1' },
  display: { title: 'Gadget g-1', type: 'gadget' },
  properties: [{ key: 'title', value: 'x', dataClass: 'text', masked: false }],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
};

describe('Count', () => {
  it.each([
    ['exact', { value: 3, quality: 'exact', scope: 'members' }],
    ['lowerBound', { value: 3, quality: 'lowerBound', scope: 'members' }],
    ['estimated', { value: 3, quality: 'estimated', scope: 'members' }],
    ['unknown with no value', { quality: 'unknown', scope: 'members' }],
    ['zero', { value: 0, quality: 'exact', scope: 'members' }],
  ])('accepts %s', (_name, count) => {
    expect(countSchema.safeParse(count).success).toBe(true);
  });

  it.each([
    ['unknown with a value', { value: 3, quality: 'unknown', scope: 'members' }],
    ['exact with no value', { quality: 'exact', scope: 'members' }],
    ['a negative value', { value: -1, quality: 'exact', scope: 'members' }],
    ['a fraction', { value: 1.5, quality: 'exact', scope: 'members' }],
    ['a value beyond the safe range', { value: 2 ** 53, quality: 'exact', scope: 'members' }],
    ['NaN', { value: Number.NaN, quality: 'exact', scope: 'members' }],
    ['a quality outside the four', { value: 1, quality: 'approximate', scope: 'members' }],
    ['no scope', { value: 1, quality: 'exact' }],
    ['an unknown key', { value: 1, quality: 'exact', scope: 'members', note: 'x' }],
  ])('refuses %s', (_name, count) => {
    expect(countSchema.safeParse(count).success).toBe(false);
  });
});

describe('ElementRef and Node', () => {
  it('accepts a node', () => {
    expect(nodeSchema.safeParse(node).success).toBe(true);
  });

  it.each([
    ['no stable ID', { ...node, ref: { sourceId: 'alpha', entityType: 'gadget', stableId: '' } }],
    ['a technical ID in the ref', { ...node, ref: { ...node.ref, technicalId: '4:abc:1' } }],
    ['a data class outside the list', { ...node, properties: [{ key: 'k', dataClass: 'unclassified', masked: false }] }],
    ['an unknown key', { ...node, extra: 1 }],
    ['no authorization', { ...node, authorization: undefined }],
  ])('refuses %s', (_name, value) => {
    expect(nodeSchema.safeParse(value).success).toBe(false);
  });

  it('shares the ref shape between a node and an element ref', () => {
    expect(elementRefSchema.safeParse(node.ref).success).toBe(true);
  });
});

describe('Edge', () => {
  const end = (stableId: string) => ({ sourceId: 'alpha', entityType: 'gadget', stableId });
  const storedRef = { sourceId: 'alpha', type: 'MADE_BY', from: 'gadget', to: 'gadget', stableId: 'r-1' };
  const stored = { ref: storedRef, from: end('a'), to: end('b'), type: 'MADE_BY', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] };
  const aggregate = { ...stored, ref: { sourceId: 'alpha', aggregate: { type: 'MADE_BY', from: end('a'), to: end('b') } }, memberCount: { value: 2, quality: 'exact', scope: 'members' }, observedFirst: '2026-01-02', observedLast: '2026-01-03' };
  const derived = { ...stored, ref: { sourceId: 'alpha', derived: { ruleId: 'shared', from: end('a'), to: end('b') } }, type: 'shared', semantics: 'derived', derivation: { ruleId: 'shared', ruleVersion: 1, supportingEdgeRefs: [stored.ref, aggregate.ref] } };

  it.each([['a stored edge', stored], ['an aggregate edge', aggregate], ['a derived edge', derived]])('accepts %s', (_name, edge) => {
    expect(edgeSchema.safeParse(edge).success).toBe(true);
  });

  it.each([
    ['an aggregate without a member count', { ...aggregate, memberCount: undefined }],
    ['a member count on a stored edge', { ...stored, memberCount: { value: 1, quality: 'exact', scope: 'members' } }],
    ['a derived edge without a derivation', { ...derived, derivation: undefined }],
    ['a stored edge with a derivation', { ...stored, derivation: derived.derivation }],
    ['a direction other than from-to', { ...stored, direction: 'out' }],
    ['a ref of no known form', { ...stored, ref: { sourceId: 'alpha', other: 1 } }],
    ['a stored ref with no type', { ...stored, ref: { sourceId: 'alpha', from: 'gadget', to: 'gadget', stableId: 'r-1' } }],
    ['a stored ref with no from', { ...stored, ref: { sourceId: 'alpha', type: 'MADE_BY', to: 'gadget', stableId: 'r-1' } }],
    ['a stored ref with no to', { ...stored, ref: { sourceId: 'alpha', type: 'MADE_BY', from: 'gadget', stableId: 'r-1' } }],
    ['a stored ref with no stable ID', { ...stored, ref: { sourceId: 'alpha', type: 'MADE_BY', from: 'gadget', to: 'gadget' } }],
    ['a stored ref in the old shape', { ...stored, ref: { sourceId: 'alpha', stableId: 'r-1' } }],
    ['a stored ref with an empty type', { ...stored, ref: { ...storedRef, type: '' } }],
    ['a stored ref with an empty end type', { ...stored, ref: { ...storedRef, to: '' } }],
    ['a stored ref with an unknown key', { ...stored, ref: { ...storedRef, extra: 1 } }],
    ['an unknown key', { ...stored, confidence: 0.9 }],
  ])('refuses %s', (_name, edge) => {
    expect(edgeSchema.safeParse(edge).success).toBe(false);
  });
});

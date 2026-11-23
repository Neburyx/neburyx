import { SENSITIVE_TITLE_KEY, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { normalizeModelOf } from '../gate/normalize/model.js';
import { redactResult } from '../gate/redact/index.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { redactContext } from '../testing/normalize-fixtures.js';
import { PACKS, packSource } from '../testing/pack-fixtures.js';
import { parseMapping } from './load.js';
import type { SourceModel } from './model.js';
import { sensitiveKeysOf, sensitivityVersionOf } from './sensitivity.js';

const sourceOf = (entities: unknown[], relationships: unknown[] = []): SourceModel => {
  const [source] = parseMapping(fileOf(baseSource({ entities, relationships })), 'neburyx.yaml').sources;
  if (source === undefined) throw new Error('no source');
  return source;
};

/** A mapping with names no pack uses: a type with a personal property its title is built from, a type with a personal property outside its title, a type with none. */
const OTHER = (extra: string[] = []) =>
  sourceOf([
    { type: 'thing_one', label: 'ThingOne', stable_id: 'code', title: '{label}', pii: [{ property: 'label', class: 'name' }] },
    { type: 'thing_two', label: 'ThingTwo', stable_id: 'code', pii: [{ property: 'secret_a', class: 'text' }, ...extra.map((property) => ({ property, class: 'text' }))] },
    { type: 'thing_three', label: 'ThingThree', stable_id: 'code' },
  ]);

describe('the sensitive keys of a source', () => {
  it('are exactly the personal properties of each entity type, the title where it is built from one, and none for a type without', () => {
    const keys = sensitiveKeysOf(OTHER());
    expect(keys.get('thing_one')).toEqual([SENSITIVE_TITLE_KEY, 'label']);
    expect(keys.get('thing_two')).toEqual(['secret_a']);
    expect(keys.has('thing_three')).toBe(false);
    expect(sensitiveKeysOf(undefined).size).toBe(0);
  });

  it('give no value, and a version that changes when any key of any type changes and holds when none does', () => {
    expect(JSON.stringify([...sensitiveKeysOf(OTHER())])).not.toMatch(/\bv-/u);
    const base = sensitivityVersionOf(OTHER());
    expect(base).toMatch(/^sv1:[0-9a-f]{64}$/u);
    expect(sensitivityVersionOf(OTHER())).toBe(base);
    expect(sensitivityVersionOf(OTHER(['secret_b']))).not.toBe(base);
    expect(sensitivityVersionOf(sourceOf([{ type: 'thing_one', label: 'ThingOne', stable_id: 'code' }]))).not.toBe(sensitivityVersionOf(sourceOf([{ type: 'thing_one', label: 'ThingOne', stable_id: 'code' }, { type: 'thing_two', label: 'ThingTwo', stable_id: 'code' }])));
  });
});

/** The set the gate masks under `mask: true` for every type of a mapping, found by running its redact stage over a node that holds every property the type names; the title counts when the stage changes it. */
function maskedByTheGate(source: SourceModel): Map<string, string[]> {
  const model = normalizeModelOf(source);
  const out = new Map<string, string[]>();
  for (const entity of source.entities) {
    const keys = [...new Set([entity.stableId, ...entity.titleProperties, ...entity.search, ...entity.reference, ...entity.pii, ...entity.filterable])];
    const node: GraphNode = { ref: { sourceId: 'alpha', entityType: entity.type, stableId: 'x' }, display: { title: 'PLAIN-TITLE', type: entity.type }, properties: keys.map((key) => ({ key, value: `value-of-${key}`, dataClass: 'text', masked: false })), qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
    const masked = redactResult({ nodes: [node], unreferenced: [], edges: [], dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] }, redactContext(model, true)).nodes[0];
    const hidden = [...(masked?.properties.filter((property) => property.masked).map((property) => property.key) ?? []), ...(masked?.display.title === 'PLAIN-TITLE' ? [] : [SENSITIVE_TITLE_KEY])].sort();
    if (hidden.length > 0) out.set(entity.type, hidden);
  }
  return out;
}

describe.each([...PACKS.map((pack) => [pack, packSource(pack)] as const), ['a mapping with other names', OTHER(['secret_b'])] as const])('the sensitive keys and the mask of the gate, over %s', (_name, source) => {
  it('are the same set for every type of the mapping, so a stored answer and a live one never differ in what is sensitive', () => {
    const fromGate = maskedByTheGate(source);
    expect([...sensitiveKeysOf(source)].sort()).toEqual([...fromGate].sort());
    expect(fromGate.size).toBeGreaterThan(0);
  });
});

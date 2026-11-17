import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { SCHEMA_DRAFT_CAP } from '../gate/templates/schema-draft.js';
import { parseMapping } from '../mapping/load.js';
import { judgeIndexes } from '../source-test/mapping-checks.js';
import { bareMapping } from './bare-source.js';
import { draftMapping, isEnvironmentName } from './draft.js';
import type { SourceSchema } from './schema-read.js';

const CONNECTION = { sourceId: 'own-source', uri: 'bolt://localhost:7687', database: 'neo4j', usernameEnv: 'NEO4J_USERNAME', passwordEnv: 'NEO4J_PASSWORD', connectWaitMs: 8000 };

const SCHEMA: SourceSchema = {
  labels: ['Person', 'Place'],
  labelsCut: false,
  types: ['LINKS_TO'],
  typesCut: false,
  propertyKeys: ['name', 'ref', 'street'],
  propertyKeysCut: false,
  indexes: [
    { name: 'person_ref', type: 'RANGE', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['ref'], state: 'ONLINE' },
    { name: 'person_name', type: 'TEXT', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['name'], state: 'ONLINE' },
    { name: 'lives_since', type: 'RANGE', entityType: 'RELATIONSHIP', labelsOrTypes: ['LINKS_TO'], properties: ['since'], state: 'ONLINE' },
    { name: 'token_lookup', type: 'LOOKUP', entityType: 'NODE', labelsOrTypes: [], properties: [], state: 'ONLINE' },
  ],
  indexesCut: false,
  constraints: [{ name: 'person_ref_unique', type: 'UNIQUENESS', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['ref'] }],
  constraintsCut: false,
};

function drafted(schema: SourceSchema = SCHEMA) {
  const draft = draftMapping(schema, CONNECTION);
  if (!draft.ok) throw new Error(draft.message);
  return draft;
}

const filled = (text: string): string => text.replaceAll('stable_id: TODO', 'stable_id: ref').replaceAll('from: TODO', 'from: Person').replaceAll('to: TODO', 'to: Place');

describe('the draft mapping', () => {
  it('holds the connection, an entity type for each label with the stable ID marker, and a relationship type for each type with from and to markers', () => {
    const document = parse(drafted().text) as { sources: { id: string; uri: string; database: string; auth: Record<string, string>; entities: Record<string, string>[]; relationships: Record<string, string>[] }[] };
    const [source] = document.sources;
    expect(source).toMatchObject({ id: 'own-source', uri: 'bolt://localhost:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'NEO4J_USERNAME', password_env: 'NEO4J_PASSWORD' } });
    expect(source?.entities).toEqual([
      { type: 'Person', label: 'Person', stable_id: 'TODO' },
      { type: 'Place', label: 'Place', stable_id: 'TODO' },
    ]);
    expect(source?.relationships).toEqual([{ type: 'LINKS_TO', from: 'TODO', to: 'TODO' }]);
  });

  it('lists the constraint and index properties of a label as candidates, and marks search and pii as comments', () => {
    const { text } = drafted();
    expect(text).toContain('Properties on a uniqueness or key constraint of this label: ref');
    expect(text).toContain('Properties on a range or text index of this label: ref, name');
    expect(text).toContain('# TODO search: a list of properties people search by.');
    expect(text).toContain('# TODO pii: the properties that hold personal data');
    expect(text).toMatch(/Place[^\n]*\n[^\n]*constraint of this label: none/);
  });

  it('lists every property key, index (relationship and lookup ones too) and constraint the read returned', () => {
    const { text } = drafted();
    expect(text).toContain('# Property keys (database-wide): name, ref, street');
    expect(text).toContain('#   person_ref: RANGE on label Person, properties ref, ONLINE');
    expect(text).toContain('#   lives_since: RANGE on relationship type LINKS_TO, properties since, ONLINE');
    expect(text).toContain('#   token_lookup: LOOKUP on label none, properties none, ONLINE');
    expect(text).toContain('#   person_ref_unique: UNIQUENESS on label Person, properties ref');
  });

  it('counts the markers it holds', () => {
    expect(drafted().markers).toBe(1 + 3 * 2 + 2 * 1);
  });

  it('says that a kind was cut at that place, with no count', () => {
    const draft = drafted({ ...SCHEMA, labelsCut: true, propertyKeysCut: true });
    expect(draft.cut).toEqual(['labels', 'property keys']);
    expect(draft.text).toContain(`# NOTE: the database has more than ${SCHEMA_DRAFT_CAP} labels; the list of labels below is partial.`);
    expect(draft.text).toContain(`# NOTE: the database has more than ${SCHEMA_DRAFT_CAP} property keys; the list of property keys below is partial.`);
    expect(draft.text.split('\n').filter((line) => line.startsWith('# NOTE')).join(' ').match(/\d+/g)).toEqual(['500', '500']);
    expect(drafted().cut).toEqual([]);
  });

  it('keeps a name with a colon, a quote, a line break, a hash or a document marker inside its value and its comment', () => {
    const odd = ['a: b', 'say "hi"', 'two\nlines', 'x # y', '---', "it's", 'back\\slash', ' split'];
    const draft = drafted({ ...SCHEMA, labels: odd, types: ['t: u\nv'], propertyKeys: odd, indexes: [], constraints: [] });
    const document = parse(draft.text) as { sources: { entities: { type: string; label: string }[]; relationships: { type: string }[] }[] };
    const [source] = document.sources;
    expect(source?.entities.map((entity) => entity.label)).toEqual(odd);
    expect(source?.entities.every((entity) => Object.keys(entity).length === 3)).toBe(true);
    expect(source?.relationships).toEqual([{ type: 't: u\nv', from: 'TODO', to: 'TODO' }]);
    expect(Object.keys(document)).toEqual(['sources']);
    for (const line of draft.text.split('\n')) expect([...line].some((char) => char.charCodeAt(0) < 9 || (char.charCodeAt(0) > 10 && char.charCodeAt(0) < 32) || char.charCodeAt(0) === 0x2028 || char.charCodeAt(0) === 0x2029)).toBe(false);
  });

  it('writes every marker as a different text when a name read from the database is the marker', () => {
    const draft = drafted({ ...SCHEMA, labels: ['TODO', 'Place'], propertyKeys: ['TODO_'] });
    const document = parse(draft.text) as { sources: { entities: { stable_id: string }[]; relationships: { from: string; to: string }[] }[] };
    const [source] = document.sources;
    expect(source?.entities.map((entity) => entity.stable_id)).toEqual(['TODO__', 'TODO__']);
    expect(source?.relationships[0]).toMatchObject({ from: 'TODO__', to: 'TODO__' });
  });

  it('writes the stable ID marker in a form no property can have when the property keys were cut, and the loader refuses it', () => {
    const draft = drafted({ ...SCHEMA, propertyKeysCut: true });
    expect(draft.marker).toBe('TODO');
    expect(draft.text).toContain('stable_id: "{TODO}"');
    const left = draft.text.replaceAll('from: TODO', 'from: Person').replaceAll('to: TODO', 'to: Place');
    expect(() => parseMapping(left, 'draft.yaml')).toThrow();
    expect(parseMapping(left.replaceAll('stable_id: "{TODO}"', 'stable_id: ref'), 'draft.yaml').sources).toHaveLength(1);
  });

  it('reads the constraint types of the 2026 series as keys too', () => {
    const named = drafted({ ...SCHEMA, constraints: [{ name: 'c', type: 'NODE_PROPERTY_UNIQUENESS', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['ref'] }] });
    expect(named.text).toContain('Properties on a uniqueness or key constraint of this label: ref');
  });

  it('makes no draft for a database with no label, and says why', () => {
    const draft = draftMapping({ ...SCHEMA, labels: [] }, CONNECTION);
    expect(draft).toEqual({ ok: false, message: expect.stringContaining('no labels to draft from') });
  });

  it('is accepted by the mapping loader once the markers are replaced by choices', () => {
    const mapping = parseMapping(filled(drafted().text), 'draft.yaml');
    expect(mapping.sources[0]?.entities.map((entity) => [entity.type, entity.stableId])).toEqual([['Person', 'ref'], ['Place', 'ref']]);
    expect(mapping.sources[0]?.relationships[0]).toMatchObject({ type: 'LINKS_TO', from: 'Person', to: 'Place' });
  });

  it('is refused by the mapping loader while from or to is a marker', () => {
    expect(() => parseMapping(drafted().text.replaceAll('stable_id: TODO', 'stable_id: ref'), 'draft.yaml')).toThrow(/TODO/);
  });
});

describe('a draft with the stable ID marker left in', () => {
  it('loads, but test-source judges it as a failing stable ID, so an unfilled draft is not a passing mapping', () => {
    const text = drafted().text.replaceAll('from: TODO', 'from: Person').replaceAll('to: TODO', 'to: Place');
    const mapping = parseMapping(text, 'draft.yaml');
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const reads = { labels: new Set(['Person', 'Place']), types: new Set(['LINKS_TO']), indexes: [{ type: 'RANGE' as const, entityType: 'NODE' as const, name: 'Person', property: 'ref', single: true, state: 'ONLINE', constrained: true }] };
    const findings = judgeIndexes(source, reads);
    expect(findings.filter((finding) => finding.check === 'stable-id-unindexed' && finding.severity === 'fail').map((finding) => finding.entityType)).toEqual(['Person', 'Place']);
    const [filledSource] = parseMapping(filled(drafted().text), 'draft.yaml').sources;
    if (filledSource === undefined) throw new Error('no source');
    const real = judgeIndexes(filledSource, reads);
    expect(real.filter((finding) => finding.severity === 'fail').map((finding) => finding.entityType)).toEqual(['Place']);
  });
});

describe('the input of the draft', () => {
  it('has no field for a property value, and the draft holds only what the schema names', () => {
    const keys = Object.keys(SCHEMA).sort();
    expect(keys).toEqual(['constraints', 'constraintsCut', 'indexes', 'indexesCut', 'labels', 'labelsCut', 'propertyKeys', 'propertyKeysCut', 'types', 'typesCut']);
    expect(bareMapping(CONNECTION).sources[0]?.entities).toEqual([]);
  });

  it('accepts only environment variable names', () => {
    expect(['NEO4J_USERNAME', '_a1'].every(isEnvironmentName)).toBe(true);
    expect(['1A', 'A-B', 'A B', '', 'A=B'].some(isEnvironmentName)).toBe(false);
  });
});

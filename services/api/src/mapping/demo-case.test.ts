import { describe, expect, it } from 'vitest';
import { MAX_CASE_REF_LENGTH, MAX_STABLE_ID_LENGTH } from '@neburyx/contracts';
import { baseSource, expectRefused, fileOf, firstSource, issuesOf, load, type Json } from '../testing/mapping.js';

const demoCase: Json = { entity: { type: 'node_a', id: 'A-1' }, case_ref: 'REF-1' };

const synthetic = (overrides: Json = {}): Json => baseSource({ synthetic: true, demo_case: demoCase, ...overrides });

const withDemoCase = (value: Json): Json => synthetic({ demo_case: value });

const WIDE = '\u{1F600}';

describe('the demo case of a source', () => {
  it('is kept as the starting entity and the case reference of a synthetic source', () => {
    expect(firstSource(load(synthetic())).demoCase).toEqual({ entityType: 'node_a', stableId: 'A-1', caseRef: 'REF-1' });
  });

  it('is absent when the source names none', () => {
    expect(firstSource(load(baseSource({ synthetic: true }))).demoCase).toBeUndefined();
  });

  it.each([
    ['no synthetic flag', baseSource({ demo_case: demoCase })],
    ['a synthetic flag that is false', baseSource({ synthetic: false, demo_case: demoCase })],
  ])('is refused with %s', (_name, source) => {
    expectRefused(source, 'sources[0].demo_case', 'needs synthetic: true');
  });

  it('is refused when its entity type is not an entity type of the source', () => {
    expectRefused(withDemoCase({ ...demoCase, entity: { type: 'node_z', id: 'A-1' } }), 'sources[0].demo_case.entity.type', 'is not an entity type of this source');
  });

  it.each([
    ['a key that is not known', { ...demoCase, extra: 1 }, 'sources[0].demo_case.extra', 'is not a known key'],
    ['a key of the entity that is not known', { ...demoCase, entity: { type: 'node_a', id: 'A-1', extra: 1 } }, 'sources[0].demo_case.entity.extra', 'is not a known key'],
    ['no entity', { case_ref: 'REF-1' }, 'sources[0].demo_case.entity', 'is required'],
    ['no entity type', { ...demoCase, entity: { id: 'A-1' } }, 'sources[0].demo_case.entity.type', 'is required'],
    ['no stable ID', { ...demoCase, entity: { type: 'node_a' } }, 'sources[0].demo_case.entity.id', 'is required'],
    ['no case reference', { entity: { type: 'node_a', id: 'A-1' } }, 'sources[0].demo_case.case_ref', 'is required'],
    ['an empty entity type', { ...demoCase, entity: { type: '', id: 'A-1' } }, 'sources[0].demo_case.entity.type', 'must not be empty'],
    ['an empty stable ID', { ...demoCase, entity: { type: 'node_a', id: '' } }, 'sources[0].demo_case.entity.id', 'must not be empty'],
    ['an empty case reference', { ...demoCase, case_ref: '' }, 'sources[0].demo_case.case_ref', 'must not be empty'],
    ['an entity type over the limit', { ...demoCase, entity: { type: 'T'.repeat(MAX_STABLE_ID_LENGTH + 1), id: 'A-1' } }, 'sources[0].demo_case.entity.type', `at most ${MAX_STABLE_ID_LENGTH} characters`],
    ['a stable ID over the limit', { ...demoCase, entity: { type: 'node_a', id: 'I'.repeat(MAX_STABLE_ID_LENGTH + 1) } }, 'sources[0].demo_case.entity.id', `at most ${MAX_STABLE_ID_LENGTH} characters`],
    ['a case reference over the limit', { ...demoCase, case_ref: 'R'.repeat(MAX_CASE_REF_LENGTH + 1) }, 'sources[0].demo_case.case_ref', `at most ${MAX_CASE_REF_LENGTH} characters`],
    ['a control character in the case reference', { ...demoCase, case_ref: 'SECRET\u0007-1' }, 'sources[0].demo_case.case_ref', 'control character'],
    ['a control character in the stable ID', { ...demoCase, entity: { type: 'node_a', id: 'SECRET\u0007-1' } }, 'sources[0].demo_case.entity.id', 'control character'],
    ['an unpaired high surrogate in the case reference', { ...demoCase, case_ref: 'SECRET\uD800' }, 'sources[0].demo_case.case_ref', 'unpaired surrogate'],
    ['an unpaired low surrogate in the stable ID', { ...demoCase, entity: { type: 'node_a', id: 'SECRET\uDC00-1' } }, 'sources[0].demo_case.entity.id', 'unpaired surrogate'],
    ['an unpaired surrogate in the entity type', { ...demoCase, entity: { type: 'node_a\uD800', id: 'A-1' } }, 'sources[0].demo_case.entity.type', 'unpaired surrogate'],
  ])('is refused with %s', (_name, value, path, reason) => {
    expectRefused(withDemoCase(value), path, reason);
  });

  it('is refused without repeating a value in the message', () => {
    const issues = issuesOf(fileOf(withDemoCase({ ...demoCase, case_ref: `SECRET-${'R'.repeat(MAX_CASE_REF_LENGTH)}`, entity: { type: 'node_a', id: `SECRET-${'I'.repeat(MAX_STABLE_ID_LENGTH)}` } })));
    expect(issues).toHaveLength(2);
    expect(JSON.stringify(issues)).not.toContain('SECRET');
  });

  it('accepts a stable ID and a case reference of exactly the limit, counted as characters', () => {
    const id = WIDE.repeat(MAX_STABLE_ID_LENGTH);
    const caseRef = WIDE.repeat(MAX_CASE_REF_LENGTH);
    expect(firstSource(load(withDemoCase({ ...demoCase, entity: { type: 'node_a', id }, case_ref: caseRef }))).demoCase).toEqual({ entityType: 'node_a', stableId: id, caseRef });
    expectRefused(withDemoCase({ ...demoCase, entity: { type: 'node_a', id: `${id}x` } }), 'sources[0].demo_case.entity.id', `at most ${MAX_STABLE_ID_LENGTH} characters`);
    expectRefused(withDemoCase({ ...demoCase, case_ref: `${caseRef}x` }), 'sources[0].demo_case.case_ref', `at most ${MAX_CASE_REF_LENGTH} characters`);
  });

  it('accepts an entity type of exactly the limit when the source has it', () => {
    const type = 'T'.repeat(MAX_STABLE_ID_LENGTH);
    const source = synthetic({ entities: [{ type, label: 'NodeA', stable_id: 'id' }], relationships: [], demo_case: { ...demoCase, entity: { type, id: 'A-1' } } });
    expect(firstSource(load(source)).demoCase).toEqual({ entityType: type, stableId: 'A-1', caseRef: 'REF-1' });
  });

  it('is accepted with an ID made only of dots', () => {
    expect(firstSource(load(withDemoCase({ ...demoCase, entity: { type: 'node_a', id: '..' } }))).demoCase?.stableId).toBe('..');
  });
});

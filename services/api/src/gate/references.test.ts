import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { makeToken } from '../reference/token.js';
import { gateRequest, TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createTemplateCatalog, CatalogError } from './catalog.js';
import { ENTITY_LOAD_ID, entityLoadTemplate } from './templates/entity-load.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID, degreePreviewBoundedTemplate } from './templates/degree-preview.js';

const PHONE = '+1-212-555-0100';
const mapping = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
      { type: 'thing', label: 'Thing', stable_id: 'thingId' },
    ],
    relationships: [{ type: 'USES', from: 'thing', to: 'phone' }],
    derived: [],
  }),
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('no source');
const token = (value: string, sourceId = 'alpha', entityType = 'phone') => makeToken(TEST_REFERENCE_KEYS, { sourceId, entityType }, value);

function rig() {
  const executor = new TestExecutor(withOnlineIndexes(source ?? (() => { throw new Error('no source'); })(), (call) => Promise.resolve(call.templateId === ENTITY_LOAD_ID ? entityRows(call.cypher.includes('`Thing`') ? plainNode(['Thing'], { thingId: call.parameters['stableId'] }) : plainNode(['Handle'], { phoneNumber: PHONE })) : ({ status: 'rows' as const, rows: [{ c0: 1 }] }))));
  const parts = testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS });
  const read = (templateId: string, params: unknown, mask = false) => parts.gate.run(gateRequest({ sourceId: 'alpha', templateId, params, limit: 1, mask, indexes: { sourceId: 'alpha', entries: onlineIndexesOf(source ?? (() => { throw new Error('no source'); })()).map((row) => ({ ...row })) } }));
  const reads = (templateId: string) => executor.calls.filter((call) => call.templateId === templateId);
  return { read, reads };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe.each([ENTITY_LOAD_ID, DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID])('the %s read of a keyed node by its token', (templateId) => {
  it('gives the statement the value as its parameter, never the token', async () => {
    const { read, reads } = rig();
    await read(templateId, { entityType: 'phone', stableId: token(PHONE) });
    const [call] = reads(templateId);
    expect(call?.parameters['stableId']).toBe(PHONE);
    expect(call?.cypher).not.toContain(PHONE);
    expect(call?.cypher).not.toContain('p1.');
  });

  it('is the same read, masked or not', async () => {
    const { read, reads } = rig();
    await read(templateId, { entityType: 'phone', stableId: token(PHONE) }, true);
    expect(reads(templateId)[0]?.parameters['stableId']).toBe(PHONE);
  });

  it('finds a keyed node whose value is a canonical 64-bit integer, sending it as text and as that integer', async () => {
    const { read, reads } = rig();
    await read(templateId, { entityType: 'phone', stableId: token('4155550100') });
    expect(reads(templateId)[0]?.parameters['stableInteger']).toEqual({ $type: 'integer', value: '4155550100' });
  });

  it.each([
    ['a token of another source', () => ({ entityType: 'phone', stableId: token(PHONE, 'beta') })],
    ['a token of another entity type', () => ({ entityType: 'phone', stableId: token(PHONE, 'alpha', 'thing') })],
    ['a bit-flipped token', () => ({ entityType: 'phone', stableId: token(PHONE).replace(/.$/, (last) => (last === 'A' ? 'B' : 'A')) })],
    ['a malformed token', () => ({ entityType: 'phone', stableId: 'p1.!!' })],
    ['a raw value', () => ({ entityType: 'phone', stableId: PHONE })],
    ['a raw value that starts with the tag', () => ({ entityType: 'phone', stableId: 'p1.not-a-token' })],
    ['a raw value while masking', () => ({ entityType: 'phone', stableId: PHONE })],
  ])('refuses %s with INVALID_REQUEST and builds no statement', async (_name, params) => {
    const { read, reads } = rig();
    expect(await codeOf(read(templateId, params(), _name.includes('masking')))).toBe('INVALID_REQUEST');
    expect(reads(templateId)).toEqual([]);
  });

  it('answers every refusal alike', async () => {
    const { read } = rig();
    const bodies: unknown[] = [];
    for (const stableId of [PHONE, token(PHONE, 'beta'), 'p1.x']) {
      try {
        await read(templateId, { entityType: 'phone', stableId });
      } catch (error) {
        bodies.push(error instanceof AppError ? [error.code, error.details, error.reason] : error);
      }
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it('takes the stable ID of a type that is not keyed as it is, also when it looks like a token', async () => {
    const { read, reads } = rig();
    await read(templateId, { entityType: 'thing', stableId: 'p1.looks-like-a-token' });
    expect(reads(templateId)[0]?.parameters['stableId']).toBe('p1.looks-like-a-token');
  });
});

describe('a template that declares reference parameters', () => {
  it('is accepted when its schema has them, and refused when it does not', () => {
    expect(() => createTemplateCatalog({ templates: [entityLoadTemplate, degreePreviewBoundedTemplate] })).not.toThrow();
    expect(() => createTemplateCatalog({ templates: [{ ...entityLoadTemplate, id: 'x', referenceParams: { entityType: 'entityType', stableId: 'missing' } }] })).toThrow(CatalogError);
    expect(() => createTemplateCatalog({ templates: [{ ...entityLoadTemplate, id: 'y', referenceParams: { entityType: 'missing', stableId: 'stableId' } }] })).toThrow(CatalogError);
  });
});

import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patternValidateResponseSchema } from '../../../packages/contracts/src/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../services/api/src/app.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'domain-packs');
const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

async function validate(pack: string, definition: unknown): Promise<unknown> {
  const mapping = parseMapping(readFileSync(join(PACKS, pack, 'neburyx.yaml'), 'utf8'), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const executor = new TestExecutor(() => {
    throw new Error('the validate route called the source');
  });
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: communitySeams(), catalog: parts.catalog });
  const response = await app.inject({ method: 'POST', url: '/v1/patterns/validate', payload: JSON.stringify({ sourceId: source.id, definition }), headers: { 'content-type': 'application/json' } });
  expect(executor.calls).toEqual([]);
  await app.close();
  return patternValidateResponseSchema.parse(response.json());
}

const transfers = (extra: Record<string, unknown> = {}) => ({
  anchorType: 'account',
  steps: [{ relationshipTypes: ['TRANSFERRED_TO'], direction: 'out', arrivesAt: 'account', conditions: [{ op: 'eq', on: 'neighbor', property: 'status', value: { kind: 'text', value: 'frozen' } }], ...extra }],
});
const outAndBack = (relationshipType = 'LIVES_AT') => ({
  anchorType: 'claimant',
  steps: [
    { relationshipTypes: [relationshipType], direction: 'out', arrivesAt: 'address' },
    { relationshipTypes: [relationshipType], direction: 'in', arrivesAt: 'claimant' },
  ],
});

describe('a pattern over the banking pack', () => {
  it('over TRANSFERRED_TO, one step out to an account with a condition on a filterable property, validates', async () => {
    expect(await validate('banking-fraud', transfers())).toEqual({ status: 'ok' });
  });

  it('is refused, with the code and the path, when a name is changed: a relationship type the mapping does not name, a property that is not filterable', async () => {
    expect(await validate('banking-fraud', { ...transfers(), steps: [{ ...transfers().steps[0], relationshipTypes: ['SENT_TO'] }] })).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'relationshipTypes', 0], code: 'unknown-relationship-type' }] });
    expect(await validate('banking-fraud', transfers({ conditions: [{ op: 'eq', on: 'neighbor', property: 'holderName', value: { kind: 'text', value: 'a' } }] }))).toEqual({ status: 'invalid', problems: [{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }] });
  });
});

describe('a pattern over the insurance pack', () => {
  it('over LIVES_AT, out to an address and back in to a claimant, validates', async () => {
    expect(await validate('insurance-claims', outAndBack())).toEqual({ status: 'ok' });
  });

  it('is refused, with the code and the path, when a name is changed or a step is turned the wrong way', async () => {
    expect(await validate('insurance-claims', outAndBack('LIVES_IN'))).toEqual({
      status: 'invalid',
      problems: [
        { path: ['steps', 0, 'relationshipTypes', 0], code: 'unknown-relationship-type' },
        { path: ['steps', 1, 'relationshipTypes', 0], code: 'unknown-relationship-type' },
      ],
    });
    const wrong = outAndBack();
    expect(await validate('insurance-claims', { ...wrong, steps: [{ ...wrong.steps[0], direction: 'in' }, wrong.steps[1]] })).toMatchObject({ status: 'invalid', problems: [{ path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' }] });
  });
});

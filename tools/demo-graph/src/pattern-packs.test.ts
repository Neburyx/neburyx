import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patternPreviewResponseSchema, patternValidateResponseSchema } from '../../../packages/contracts/src/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../services/api/src/app.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { packMappingText } from '../../../services/api/src/testing/pack-fixtures.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';
import { withBudgets } from './testing/pack-run.js';

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

/** The two-step patterns the browser spec of the builder builds with choices only: out to a node type and back in to the starting type, over one relationship type. */
describe('the two-step patterns the builder builds', () => {
  it('validate against the real mapping of each pack', async () => {
    const bank = { anchorType: 'account', steps: [{ relationshipTypes: ['USES_DEVICE'], direction: 'out', arrivesAt: 'device' }, { relationshipTypes: ['USES_DEVICE'], direction: 'in', arrivesAt: 'account' }] };
    expect(await validate('banking-fraud', bank)).toEqual({ status: 'ok' });
    expect(await validate('insurance-claims', outAndBack())).toEqual({ status: 'ok' });
  });
});

/** What the builder's conditions and window produce: the first definition is the one the browser spec of the builder builds on the banking pack (an equality on a node, a range on a relationship, a window, and a step back); the second is the same kind of step over the insurance pack. */
describe('the conditions and the window the builder builds', () => {
  it('validate against the real mapping of each pack', async () => {
    const day = { kind: 'date', value: '2026-01-01' };
    const bank = {
      anchorType: 'account',
      steps: [
        {
          relationshipTypes: ['USES_DEVICE'],
          direction: 'out',
          arrivesAt: 'device',
          conditions: [
            { op: 'eq', on: 'neighbor', property: 'platform', value: { kind: 'text', value: 'ios' } },
            { op: 'between', on: 'relationship', property: 'lastSeen', from: day },
          ],
          window: { days: 30 },
        },
        { relationshipTypes: ['USES_DEVICE'], direction: 'in', arrivesAt: 'account' },
      ],
    };
    const claims = { anchorType: 'claim', steps: [{ relationshipTypes: ['FILED_BY'], direction: 'out', arrivesAt: 'claimant', conditions: [{ op: 'between', on: 'relationship', property: 'filedAt', from: day }], window: { from: '2026-01-01', to: '2026-03-31' } }] };
    expect(await validate('banking-fraud', bank)).toEqual({ status: 'ok' });
    expect(await validate('insurance-claims', claims)).toEqual({ status: 'ok' });
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

async function previewOf(pack: string, definition: unknown) {
  const mapping = parseMapping(readFileSync(join(PACKS, pack, 'neburyx.yaml'), 'utf8'), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const executor = new TestExecutor(() => {
    throw new Error('the preview route called the source');
  });
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: communitySeams(), catalog: parts.catalog });
  const response = await app.inject({ method: 'POST', url: '/v1/patterns/preview', payload: JSON.stringify({ sourceId: source.id, definition }), headers: { 'content-type': 'application/json' } });
  expect(executor.calls).toEqual([]);
  await app.close();
  const named = (type: string): string => {
    const found = source.entities.find((entity) => entity.type === type);
    return found?.display.name ?? found?.label ?? type;
  };
  return { answer: patternPreviewResponseSchema.parse(response.json()), named, budgets: source.budgets };
}

describe('the preview of a pattern over each pack', () => {
  it('lists the step of the banking pack with the display names of its types and the limits of its source', async () => {
    const { answer, named, budgets } = await previewOf('banking-fraud', transfers());
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.preview.start.name).toBe(named('account'));
    expect(answer.preview.steps.map((part) => part.text)).toEqual([`Step 1: follow TRANSFERRED_TO forward to ${named('account')}`]);
    expect([answer.preview.bounds.hopLimit.value, answer.preview.bounds.pageLimit.value, answer.preview.bounds.countCap.value]).toEqual([budgets.maxHops, budgets.maxPage, budgets.heavyOpThreshold]);
  });

  it('lists the two steps of the insurance pack, out to an address and back in to a claimant', async () => {
    const { answer, named } = await previewOf('insurance-claims', outAndBack());
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.preview.steps.map((part) => part.text)).toEqual([`Step 1: follow LIVES_AT forward to ${named('address')}`, `Step 2: follow LIVES_AT backward to ${named('claimant')}`]);
  });

  it('answers the problems of the validation, and no preview, when a name is changed', async () => {
    const { answer } = await previewOf('banking-fraud', { ...transfers(), steps: [{ ...transfers().steps[0], relationshipTypes: ['SENT_TO'] }] });
    expect(answer.status).toBe('invalid');
  });

  it('lists the two steps of the banking pack with a condition and a window, and says the window does not apply to a relationship type that carries no date', async () => {
    const two = { anchorType: 'account', steps: [transfers().steps[0], { ...transfers().steps[0], window: { days: 30 } }] };
    const { answer, named } = await previewOf('banking-fraud', two);
    if (answer.status !== 'ok') throw new Error('not ok');
    const [first, second] = answer.preview.steps;
    expect(first?.conditions.map((part) => part.text)).toEqual([`${named('account')}: status is "frozen"`]);
    expect(second?.window?.text).toBe('The window does not apply to TRANSFERRED_TO: no date is declared for it');
    expect(second?.window).toMatchObject({ appliesTo: [], notAppliedTo: ['TRANSFERRED_TO'] });
  });

  it('lists the two steps of the insurance pack with a condition and a window over a relationship type that carries a date', async () => {
    const claimOut = { anchorType: 'claim', steps: [{ relationshipTypes: ['FILED_BY'], direction: 'out', arrivesAt: 'claimant', window: { from: '2026-01-01', to: '2026-01-31' } }, { relationshipTypes: ['FILED_BY'], direction: 'in', arrivesAt: 'claim', conditions: [{ op: 'eq', on: 'neighbor', property: 'status', value: { kind: 'text', value: 'open' } }] }] };
    const { answer, named } = await previewOf('insurance-claims', claimOut);
    if (answer.status !== 'ok') throw new Error('not ok');
    const [first, second] = answer.preview.steps;
    expect(first?.window?.text).toBe('Window on FILED_BY: from 2026-01-01 to 2026-01-31, both included (UTC)');
    expect(second?.conditions.map((part) => part.text)).toEqual([`${named('claim')}: status is "open"`]);
  });
});

describe('the mapping text of a pack run with a budget lowered', () => {
  it.each(['banking-fraud', 'insurance-claims'] as const)('keeps the %s mapping valid and gives its source the budget', (pack) => {
    const [source] = parseMapping(withBudgets(packMappingText(pack, 'bolt://localhost:7687', 'run-db'), { max_hops: 2 }), 'neburyx.yaml').sources;
    expect(source?.budgets.maxHops).toBe(2);
    expect(withBudgets('x', undefined)).toBe('x');
  });
});

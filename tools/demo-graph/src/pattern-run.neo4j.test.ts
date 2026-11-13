import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNormalizedPattern } from '../../../services/api/src/gate/normalize/pattern.js';
import { PATTERN_ID } from '../../../services/api/src/gate/templates/pattern.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../../../services/api/src/testing/gate.js';
import { expectedReach } from './pattern-expected.js';
import { startPackRun, type PackRun } from './testing/pack-run.js';

let banking: PackRun;
let insurance: PackRun;

beforeAll(async () => {
  banking = await startPackRun('banking-fraud', 'banking-demo');
  insurance = await startPackRun('insurance-claims', 'insurance-demo');
}, 1_800_000);

afterAll(async () => {
  await banking?.close();
  await insurance?.close();
});

async function reached(pack: PackRun, sourceId: string, anchorType: string, stableId: string, steps: Record<string, unknown>[]) {
  const page = await pack.gate.run(gateRequest({ sourceId, principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType, stableId, steps }, limit: 500 }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  return { item, ids: new Set(item.matches.map((entry) => entry.match.stableId)) };
}

describe('a pattern over the banking pack on its demo graph', () => {
  it('follows TRANSFERRED_TO one step out and returns the set computed from the export, never the anchor', async () => {
    const transfers = banking.relationships('TRANSFERRED_TO');
    const anchor = 'AC-0000006';
    const expected = expectedReach('account', anchor, [{ edges: transfers, direction: 'out', arrivesAt: 'account' }]);
    expect(expected.size).toBeGreaterThan(0);
    const { item, ids } = await reached(banking, 'banking-demo', 'account', anchor, [{ relationshipTypes: ['TRANSFERRED_TO'], direction: 'out', arrivesAt: 'account' }]);
    expect(ids).toEqual(expected);
    expect(ids.has(anchor)).toBe(false);
    expect(item.bounded).toBe(false);
  });
});

describe('a pattern over the insurance pack on its demo graph', () => {
  it('follows LIVES_AT out to an address and back in and returns the set computed from the export, never the anchor', async () => {
    const lives = insurance.relationships('LIVES_AT');
    const sharing = new Map<string, number>();
    for (const edge of lives) sharing.set(edge.t, (sharing.get(edge.t) ?? 0) + 1);
    const anchor = lives.find((edge) => (sharing.get(edge.t) ?? 0) > 1)?.f;
    if (anchor === undefined) throw new Error('the export has no address shared by two claimants');
    const steps = [{ edges: lives, direction: 'out', arrivesAt: 'address' }, { edges: lives, direction: 'in', arrivesAt: 'claimant' }] as const;
    const expected = expectedReach('claimant', anchor, steps);
    expect(expected.size).toBeGreaterThan(0);
    const { item, ids } = await reached(insurance, 'insurance-demo', 'claimant', anchor, [
      { relationshipTypes: ['LIVES_AT'], direction: 'out', arrivesAt: 'address' },
      { relationshipTypes: ['LIVES_AT'], direction: 'in', arrivesAt: 'claimant' },
    ]);
    expect(ids).toEqual(expected);
    expect(ids.has(anchor)).toBe(false);
    expect(item.matches.every((entry) => entry.hops === 2 && entry.through.length === 1)).toBe(true);
  });
});

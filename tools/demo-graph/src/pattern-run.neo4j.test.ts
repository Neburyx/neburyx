import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNormalizedPattern } from '../../../services/api/src/gate/normalize/pattern.js';
import { PATTERN_ID } from '../../../services/api/src/gate/templates/pattern.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../../../services/api/src/testing/gate.js';
import { expectedReach } from './pattern-expected.js';
import { patternRunResponseSchema } from '../../../packages/contracts/src/pattern-run.js';
import { startPackRun, type PackRun } from './testing/pack-run.js';

let banking: PackRun;
let insurance: PackRun;

beforeAll(async () => {
  banking = await startPackRun('banking-fraud', 'banking-demo');
  insurance = await startPackRun('insurance-claims', 'insurance-demo', { budgets: { max_hops: 2 } });
}, 1_800_000);

afterAll(async () => {
  await banking?.close();
  await insurance?.close();
});

const PAGE = 50;

async function reached(pack: PackRun, sourceId: string, anchorType: string, stableId: string, steps: Record<string, unknown>[]) {
  const page = await pack.gate.run(gateRequest({ sourceId, principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params: { anchorType, stableId, steps }, limit: PAGE }));
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
    expect(expected.size).toBeLessThan(PAGE);
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
    expect(expected.size).toBeLessThan(PAGE);
    const { item, ids } = await reached(insurance, 'insurance-demo', 'claimant', anchor, [
      { relationshipTypes: ['LIVES_AT'], direction: 'out', arrivesAt: 'address' },
      { relationshipTypes: ['LIVES_AT'], direction: 'in', arrivesAt: 'claimant' },
    ]);
    expect(ids).toEqual(expected);
    expect(ids.has(anchor)).toBe(false);
    expect(item.matches.every((entry) => entry.hops === 2 && entry.through.length === 1)).toBe(true);
  });
});

const transfersOut = { relationshipTypes: ['TRANSFERRED_TO'], direction: 'out', arrivesAt: 'account' };
const livesOut = { relationshipTypes: ['LIVES_AT'], direction: 'out', arrivesAt: 'address' };
const livesBack = { relationshipTypes: ['LIVES_AT'], direction: 'in', arrivesAt: 'claimant' };
const SKIPPING = ['stopListSkipped', 'supernodesSkipped', 'readBounded'];

async function okRun(pack: PackRun, anchorType: string, stableId: string, steps: Record<string, unknown>[]) {
  const answer = await pack.patternOk({ definition: { anchorType, steps }, anchor: { entityType: anchorType, stableId }, limit: PAGE });
  if (answer.status !== 'ok') throw new Error('the run stopped as heavy');
  return answer;
}

describe('a run through POST /v1/patterns/run on the banking pack', () => {
  it('answers the accounts one step out with an exact count, the path of each match and the nodes and edges that are shown', async () => {
    const anchor = 'AC-0000006';
    const expected = expectedReach('account', anchor, [{ edges: banking.relationships('TRANSFERRED_TO'), direction: 'out', arrivesAt: 'account' }]);
    const answer = await okRun(banking, 'account', anchor, [transfersOut]);
    expect(new Set(answer.matches.map((entry) => entry.match.stableId))).toEqual(expected);
    expect(answer.count).toEqual({ value: expected.size, quality: 'exact', scope: 'template:pattern' });
    for (const entry of answer.matches) {
      expect(entry).toMatchObject({ hops: 1, through: [] });
      expect(entry.relationships).toHaveLength(1);
      expect(entry.relationships[0]).toMatchObject({ relationshipType: 'TRANSFERRED_TO', from: { stableId: anchor }, to: { stableId: entry.match.stableId } });
    }
    expect(answer.nodes.length).toBeGreaterThan(expected.size);
    expect(answer.edges.length).toBeGreaterThan(0);
  });

  it('answers the accounts two steps out with the account between on the path of each', async () => {
    const anchor = 'AC-0000006';
    const transfers = banking.relationships('TRANSFERRED_TO');
    const expected = expectedReach('account', anchor, [{ edges: transfers, direction: 'out', arrivesAt: 'account' }, { edges: transfers, direction: 'out', arrivesAt: 'account' }]);
    expect(expected.size).toBeGreaterThan(0);
    expect(expected.size).toBeLessThan(PAGE);
    const answer = await okRun(banking, 'account', anchor, [transfersOut, transfersOut]);
    expect(new Set(answer.matches.map((entry) => entry.match.stableId))).toEqual(expected);
    const first = new Set(expectedReach('account', anchor, [{ edges: transfers, direction: 'out', arrivesAt: 'account' }]));
    for (const entry of answer.matches) {
      expect(entry.hops).toBe(2);
      expect(entry.through).toHaveLength(1);
      expect(first.has(entry.through[0]?.stableId ?? '')).toBe(true);
      expect(entry.relationships.map((hop) => hop.relationshipType)).toEqual(['TRANSFERRED_TO', 'TRANSFERRED_TO']);
    }
    const skipped = answer.notices.some((notice) => SKIPPING.includes(notice.code));
    expect(answer.count).toEqual({ value: expected.size, quality: skipped ? 'lowerBound' : 'exact', scope: 'template:pattern' });
  });

  it('answers a page of at most 25 for a continue', async () => {
    const answer = await banking.patternOk({ definition: { anchorType: 'account', steps: [transfersOut, transfersOut] }, anchor: { entityType: 'account', stableId: 'AC-0000006' }, continue: true });
    if (answer.status !== 'ok') throw new Error('the run stopped as heavy');
    expect(answer.matches.length).toBeLessThanOrEqual(25);
  });
});

describe('a run through POST /v1/patterns/run on the insurance pack, whose max_hops is lowered to 2', () => {
  it('answers the other claimants at the addresses of the anchor, out to the address and back, with the address between', async () => {
    const lives = insurance.relationships('LIVES_AT');
    const sharing = new Map<string, number>();
    for (const edge of lives) sharing.set(edge.t, (sharing.get(edge.t) ?? 0) + 1);
    const anchor = lives.find((edge) => (sharing.get(edge.t) ?? 0) > 1)?.f;
    if (anchor === undefined) throw new Error('the export has no address shared by two claimants');
    const expected = expectedReach('claimant', anchor, [{ edges: lives, direction: 'out', arrivesAt: 'address' }, { edges: lives, direction: 'in', arrivesAt: 'claimant' }]);
    const answer = await okRun(insurance, 'claimant', anchor, [livesOut, livesBack]);
    expect(new Set(answer.matches.map((entry) => entry.match.stableId))).toEqual(expected);
    expect(answer.matches.every((entry) => entry.hops === 2 && entry.through[0]?.entityType === 'address')).toBe(true);
    expect(answer.matches.every((entry) => entry.relationships.map((hop) => hop.relationshipType).join() === 'LIVES_AT,LIVES_AT')).toBe(true);
    expect(expected.size).toBeLessThan(PAGE);
    expect(answer.count).toEqual({ value: expected.size, quality: 'exact', scope: 'template:pattern' });
    expect(answer.notices).toEqual([{ code: 'noStopList' }]);
  });

  it('refuses three steps with the cap of the source and reads nothing, and answers the same refusal again for the same key', async () => {
    const body = { definition: { anchorType: 'claimant', steps: [livesOut, livesBack, livesOut] }, anchor: { entityType: 'claimant', stableId: 'any-claimant' } };
    const first = await insurance.patternRun(body, 'insurance-three-steps-key-1');
    expect(first.status).toBe(422);
    expect(first.json).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } } });
    const again = await insurance.patternRun(body, 'insurance-three-steps-key-1');
    expect(again.replayed).toBe(true);
    expect(again.json).toEqual(first.json);
  });

  it('answers the stored answer again for the same key and the same request, with the replay header', async () => {
    const body = { definition: { anchorType: 'claimant', steps: [livesOut] }, anchor: { entityType: 'claimant', stableId: insurance.relationships('LIVES_AT')[0]?.f ?? '' } };
    const first = await insurance.patternRun(body, 'insurance-replay-key-0001');
    const second = await insurance.patternRun(body, 'insurance-replay-key-0001');
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(patternRunResponseSchema.parse(second.json)).toEqual(patternRunResponseSchema.parse(first.json));
  });
});

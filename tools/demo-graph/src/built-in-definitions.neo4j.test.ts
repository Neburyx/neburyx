import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { packMappingText } from '../../../services/api/src/testing/pack-fixtures.js';
import { expectedReach } from './pattern-expected.js';
import { startPackRun, type PackRun } from './testing/pack-run.js';

let banking: PackRun;

beforeAll(async () => {
  banking = await startPackRun('banking-fraud', 'banking-demo');
}, 1_800_000);

afterAll(async () => {
  await banking?.close();
});

const PAGE = 50;
const account = (index: number): string => `AC-${String(index).padStart(7, '0')}`;

const [source] = parseMapping(packMappingText('banking-fraud'), 'neburyx.yaml').sources;
const definitionOf = (id: string) => {
  const found = source?.builtInDefinitions?.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the pack has no built-in definition ${id}`);
  return found.definition;
};

/** The shipped definition, run through the route on the demo graph. */
async function run(id: string, anchor: string): Promise<Set<string>> {
  const answer = await banking.patternOk({ definition: definitionOf(id), anchor: { entityType: 'account', stableId: anchor }, limit: PAGE });
  if (answer.status !== 'ok') throw new Error('the run stopped as heavy');
  return new Set(answer.matches.map((entry) => entry.match.stableId));
}

describe('the typologies of the banking pack on its demo graph', () => {
  const transfers = () => banking.timedRelationships('TRANSFERRED_TO', 'transferredAt');
  const outOf = (id: string) => new Set(transfers().filter((edge) => edge.f === id).map((edge) => edge.t));
  const intoOf = (id: string) => new Set(transfers().filter((edge) => edge.t === id).map((edge) => edge.f));

  it('fan-out returns the accounts an account sends to when it sends to at least ten, and nothing for one that does not', async () => {
    expect(outOf(account(7000)).size).toBeGreaterThanOrEqual(10);
    expect(await run('fan-out', account(7000))).toEqual(expectedReach('account', account(7000), [{ edges: transfers(), direction: 'out', arrivesAt: 'account', fan: 10 }]));
    expect(outOf(account(7001)).size).toBeLessThan(10);
    expect((await run('fan-out', account(7001))).size).toBe(0);
  });

  it('fan-in returns the accounts that send to an account that receives from at least ten, and nothing for one that does not', async () => {
    expect(intoOf(account(7100)).size).toBeGreaterThanOrEqual(10);
    expect(await run('fan-in', account(7100))).toEqual(expectedReach('account', account(7100), [{ edges: transfers(), direction: 'in', arrivesAt: 'account', fan: 10 }]));
    expect(intoOf(account(7101)).size).toBeLessThan(10);
    expect((await run('fan-in', account(7101))).size).toBe(0);
  });

  it('cycles returns the account itself when money leaves it and comes back in three transfers, and nothing for an account on no such cycle', async () => {
    const next = new Map<string, string[]>();
    for (const edge of transfers()) next.set(edge.f, [...(next.get(edge.f) ?? []), edge.t]);
    const onCycle = (anchor: string): boolean => (next.get(anchor) ?? []).some((first) => first !== anchor && (next.get(first) ?? []).some((second) => second !== anchor && second !== first && (next.get(second) ?? []).includes(anchor)));
    expect(onCycle(account(7200))).toBe(true);
    expect(await run('cycles', account(7200))).toEqual(new Set([account(7200)]));
    const off = [...new Set(transfers().map((edge) => edge.f))].find((id) => !onCycle(id));
    if (off === undefined) throw new Error('every sending account is on a cycle');
    expect((await run('cycles', off)).size).toBe(0);
  });

  it('pass-through returns the accounts a transfer reaches whose next transfer is not earlier, and leaves out the chain whose second transfer is earlier', async () => {
    const steps = [{ edges: transfers(), direction: 'out' as const, arrivesAt: 'account' }, { edges: transfers(), direction: 'out' as const, arrivesAt: 'account', ordered: true }];
    const hit = await run('pass-through', account(7300));
    expect(hit).toEqual(expectedReach('account', account(7300), steps));
    expect(hit.has(account(7302))).toBe(true);
    const miss = await run('pass-through', account(7310));
    expect(miss).toEqual(expectedReach('account', account(7310), steps));
    expect(miss.has(account(7312))).toBe(false);
  });
});

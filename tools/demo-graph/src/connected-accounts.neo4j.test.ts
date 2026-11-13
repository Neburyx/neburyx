import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPackRun, type PackRun } from './testing/pack-run.js';

let pack: PackRun;

beforeAll(async () => {
  pack = await startPackRun('banking-fraud', 'banking-demo');
}, 900_000);

afterAll(async () => {
  await pack?.close();
});

const ref = (stableId: string) => ({ entityType: 'account', stableId });

/** The distinct accounts reached along `out` from the anchor: the first hop, then the second hop that is not the first hop and not the anchor, from the export's transfers. */
function reach(anchor: string) {
  const out = new Map<string, Set<string>>();
  for (const { f, t } of pack.relationships('TRANSFERRED_TO')) out.set(f, (out.get(f) ?? new Set()).add(t));
  const first = new Set([...(out.get(anchor) ?? [])].filter((id) => id !== anchor));
  const second = new Set<string>();
  for (const id of first) for (const next of out.get(id) ?? []) if (next !== anchor && !first.has(next)) second.add(next);
  return { first, second };
}

const idsOf = (answer: { readonly matchIds: readonly { readonly stableId: string }[] }) => answer.matchIds.map((match) => match.stableId).sort();

describe('the Connected accounts preset of the banking pack on its demo graph, through the run route', () => {
  it('returns the one account that seven payments go to, once, and not the anchor', async () => {
    const answer = await pack.ok('connected-accounts', { ref: ref('AC-0002000') });
    expect(idsOf(answer)).toEqual(['AC-0002001']);
    expect(reach('AC-0002000').first).toEqual(new Set(['AC-0002001']));
  });

  it('returns the accounts one and two hops away along the stored direction, never the anchor, and names the account in between for a second hop', async () => {
    const { first, second } = reach('AC-0000006');
    expect(first.size).toBe(2);
    expect(second.size).toBeGreaterThan(0);
    const answer = await pack.ok('connected-accounts', { ref: ref('AC-0000006'), maxHops: 2 });
    expect(idsOf(answer)).toEqual([...first, ...second].sort());
    expect(idsOf(answer)).not.toContain('AC-0000006');
    expect(answer.links).toHaveLength(answer.matchIds.length);
    const links = answer.links ?? [];
    expect(links.filter((link) => link.hops === 2).map((link) => link.match.stableId).sort()).toEqual([...second].sort());
    for (const link of links) {
      if (link.hops === 1) expect(first.has(link.match.stableId)).toBe(true);
      else expect(first.has(link.through?.stableId ?? '')).toBe(true);
    }
  });

  it('refuses three hops with the cap of the template and returns no match', async () => {
    const answer = await pack.run('connected-accounts', { ref: ref('AC-0000006'), maxHops: 3 });
    expect(answer.status).not.toBe(200);
    expect(answer.json).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } } });
    expect(answer.json).not.toHaveProperty('matchIds');
  });

  it('cuts at the limit and labels the count a lower bound, never exact', async () => {
    const answer = await pack.ok('connected-accounts', { ref: ref('AC-0000006'), limit: 1 });
    expect(answer.matchIds).toHaveLength(1);
    expect(answer.count.quality).toBe('lowerBound');
  });
});

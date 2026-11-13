import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPackRun, type PackRun } from './testing/pack-run.js';

let pack: PackRun;

beforeAll(async () => {
  pack = await startPackRun('insurance-claims', 'insurance-demo');
}, 900_000);

afterAll(async () => {
  await pack?.close();
});

const claimant = (stableId: string) => ({ entityType: 'claimant', stableId });
const idsOf = (answer: { readonly matchIds: readonly { readonly stableId: string }[] }) => answer.matchIds.map((match) => match.stableId).sort();

/** The other claimants who live at any address of the anchor, from the export's `LIVES_AT` rows. */
function sharing(anchor: string): string[] {
  const rows = pack.relationships('LIVES_AT');
  const addresses = new Set(rows.filter((row) => row.f === anchor).map((row) => row.t));
  return [...new Set(rows.filter((row) => addresses.has(row.t) && row.f !== anchor).map((row) => row.f))].sort();
}

describe('the facts of the generated insurance export that the cases and the runs below rest on', () => {
  it('gives CT-00100 three claims and CT-00000 none', () => {
    const filed = pack.relationships('FILED_BY');
    expect(filed.filter((row) => row.t === 'CT-00100').map((row) => row.f).sort()).toEqual(['CL-001007', 'CL-001504', 'CL-001968']);
    expect(filed.filter((row) => row.t === 'CT-00000')).toEqual([]);
  });

  it('gives CT-00000 one address that nobody else shares', () => {
    const lives = pack.relationships('LIVES_AT');
    const own = lives.filter((row) => row.f === 'CT-00000');
    expect(own).toEqual([{ f: 'CT-00000', t: 'AD-00379' }]);
    expect(lives.filter((row) => row.t === 'AD-00379')).toHaveLength(1);
  });

  it('gives AD-00001 and AD-00002 the same street and city, and CT-00458 and CT-00485 an address each of them', () => {
    const [first, second] = ['AD-00001', 'AD-00002'].map((id) => pack.entities('address').find((properties) => properties['addressId'] === id));
    expect(first).toBeDefined();
    expect([first?.['line1'], first?.['city']]).toEqual([second?.['line1'], second?.['city']]);
    const lives = pack.relationships('LIVES_AT');
    expect(lives).toContainEqual({ f: 'CT-00458', t: 'AD-00001' });
    expect(lives).toContainEqual({ f: 'CT-00485', t: 'AD-00002' });
    const addressesOf = (id: string) => new Set(lives.filter((row) => row.f === id).map((row) => row.t));
    expect([...addressesOf('CT-00458')].filter((address) => addressesOf('CT-00485').has(address))).toEqual([]);
  });
});

describe('the Shared addresses preset of the insurance pack on its demo graph, through the run route', () => {
  it('returns the ring of the first address and the claimants of the second address of the anchor, and not the anchor', async () => {
    const answer = await pack.ok('shared-addresses', { ref: claimant('CT-00100') });
    const found = idsOf(answer);
    expect(found).toEqual(sharing('CT-00100'));
    for (const id of ['CT-00101', 'CT-00102', 'CT-00103', 'CT-00300', 'CT-00671']) expect(found).toContain(id);
    expect(found).not.toContain('CT-00100');
  });

  it('returns no match, an exact count of zero, for a claimant who lives alone', async () => {
    const answer = await pack.ok('shared-addresses', { ref: claimant('CT-00000') });
    expect(answer.matchIds).toEqual([]);
    expect(answer.count).toMatchObject({ value: 0, quality: 'exact' });
  });

  it('does not join two claimants whose address nodes carry the same street and city', async () => {
    const answer = await pack.ok('shared-addresses', { ref: claimant('CT-00458') });
    expect(idsOf(answer)).toEqual(sharing('CT-00458'));
    expect(idsOf(answer)).not.toContain('CT-00485');
  });

  it('cuts at the limit and labels the count a lower bound', async () => {
    const answer = await pack.ok('shared-addresses', { ref: claimant('CT-00100'), limit: 2 });
    expect(answer.matchIds).toHaveLength(2);
    expect(answer.count.quality).toBe('lowerBound');
  });
});

describe('the Claims by claimant preset of the insurance pack on its demo graph, through the run route', () => {
  it('returns the three claims of the claimant, along the stored direction', async () => {
    const answer = await pack.ok('claimant-claims', { ref: claimant('CT-00100') });
    expect(idsOf(answer)).toEqual(['CL-001007', 'CL-001504', 'CL-001968']);
  });

  it('returns no match, an exact count of zero, for a claimant with no claim', async () => {
    const answer = await pack.ok('claimant-claims', { ref: claimant('CT-00000') });
    expect(answer.matchIds).toEqual([]);
    expect(answer.count).toMatchObject({ value: 0, quality: 'exact' });
  });

  it('finds the same claims at two hops, each one hop away, and nothing further', async () => {
    const answer = await pack.ok('claimant-claims', { ref: claimant('CT-00100'), maxHops: 2 });
    expect(idsOf(answer)).toEqual(['CL-001007', 'CL-001504', 'CL-001968']);
    expect(answer.links).toHaveLength(3);
    for (const link of answer.links ?? []) expect(link.hops).toBe(1);
  });
});

import { MEMBERS_PER_NEIGHBOR, SIZES } from './plan.js';
import { runAdmin, type RunningNeo4j } from '../neo4j-server.js';

export const ENTITIES = [
  { type: 'hub', label: 'BenchHub', stable_id: 'hubId' },
  { type: 'leaf', label: 'BenchLeaf', stable_id: 'leafId' },
];

export const RELATIONSHIPS = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
  { type: 'TIED', from: 'hub', to: 'leaf', stable_id: 'tieId' },
  { type: 'NOTED', from: 'hub', to: 'leaf', observed_at: 'seenAt' },
  { type: 'PAID', from: 'hub', to: 'leaf' },
];

export const hubOf = (size: number): string => `hub-${size}`;

const CHUNK = 20_000;

/** The counts a built anchor must have, for the check after the build. */
export interface BuiltCounts {
  readonly linked: number;
  readonly tied: number;
  readonly noted: number;
  readonly paid: number;
  readonly neighbors: number;
}

/**
 * Builds one anchor with `size` relationships of each of four types to one neighbor type: dated with an ID (`LINKED`), undated with an ID (`TIED`) and with no ID and no time (`PAID`), one to each neighbor, and dated with no ID (`NOTED`),
 * ten to each of a tenth as many neighbors. Written in chunks, with the dev login, into the database of this run.
 */
async function buildAnchor(server: RunningNeo4j, size: number): Promise<void> {
  const hub = hubOf(size);
  const leafOf = (expression: string): string => `'${hub}-' + toString(${expression})`;
  await runAdmin(server, `CREATE (:BenchHub {hubId: '${hub}'})`);
  for (let from = 1; from <= size; from += CHUNK) {
    const to = Math.min(size, from + CHUNK - 1);
    await runAdmin(server, `MATCH (h:BenchHub {hubId: '${hub}'}) UNWIND range(${from}, ${to}) AS i CREATE (h)-[:LINKED {relId: 'l-${hub}-' + toString(i), seenAt: datetime('2026-01-01T00:00:00Z') + duration({seconds: i})}]->(:BenchLeaf {leafId: ${leafOf('i')}})`);
  }
  for (let from = 1; from <= size; from += CHUNK) {
    const to = Math.min(size, from + CHUNK - 1);
    await runAdmin(server, `MATCH (h:BenchHub {hubId: '${hub}'}) UNWIND range(${from}, ${to}) AS i MATCH (l:BenchLeaf {leafId: ${leafOf('i')}}) CREATE (h)-[:TIED {tieId: 't-${hub}-' + toString(i)}]->(l)`);
  }
  for (let from = 1; from <= size; from += CHUNK) {
    const to = Math.min(size, from + CHUNK - 1);
    await runAdmin(server, `MATCH (h:BenchHub {hubId: '${hub}'}) UNWIND range(${from}, ${to}) AS i MATCH (l:BenchLeaf {leafId: ${leafOf('i')}}) CREATE (h)-[:PAID]->(l)`);
  }
  const neighbors = size / MEMBERS_PER_NEIGHBOR;
  for (let from = 1; from <= size; from += CHUNK) {
    const to = Math.min(size, from + CHUNK - 1);
    await runAdmin(server, `MATCH (h:BenchHub {hubId: '${hub}'}) UNWIND range(${from}, ${to}) AS i MATCH (l:BenchLeaf {leafId: ${leafOf(`1 + (i % ${neighbors})`)}}) CREATE (h)-[:NOTED {seenAt: datetime('2026-01-01T00:00:00Z') + duration({seconds: i})}]->(l)`);
  }
}

/** Makes the constraints and indexes the mapping asks for (the anchor's stable ID, the neighbor's, and each relationship ID), awaits them, builds the three anchors and checks the counts it built; a count that differs fails the run, since a figure about the wrong graph is worse than none. */
export async function buildSupernodes(server: RunningNeo4j, sizes: readonly number[] = SIZES): Promise<void> {
  await runAdmin(server, 'CREATE CONSTRAINT bench_hub FOR (n:BenchHub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX bench_leaf FOR (n:BenchLeaf) ON (n.leafId)');
  await runAdmin(server, 'CREATE CONSTRAINT bench_linked FOR ()-[r:LINKED]-() REQUIRE r.relId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT bench_tied FOR ()-[r:TIED]-() REQUIRE r.tieId IS UNIQUE');
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  for (const size of sizes) await buildAnchor(server, size);
  for (const size of sizes) {
    checkBuilt(size, await countsOf(server, size));
  }
}

/** What the build made must be what the plan says; a figure about the wrong graph is worse than none. `uneven` counts aggregate neighbors that do not hold ten members. */
export function checkBuilt(size: number, counts: BuiltCounts & { readonly uneven: number }): void {
  const { uneven, ...built } = counts;
  const expected: BuiltCounts = { linked: size, tied: size, noted: size, paid: size, neighbors: size };
  if (JSON.stringify(built) !== JSON.stringify(expected)) throw new Error(`the anchor of ${size} relationships was built with ${JSON.stringify(built)} instead of ${JSON.stringify(expected)}`);
  if (uneven !== 0) throw new Error(`the anchor of ${size} relationships has ${uneven} aggregate neighbors with other than ${MEMBERS_PER_NEIGHBOR} members`);
}

export async function countsOf(server: RunningNeo4j, size: number): Promise<BuiltCounts & { readonly uneven: number }> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(
      `MATCH (h:BenchHub {hubId: $hub})
       CALL { WITH h MATCH (h)-[r:LINKED]->() RETURN count(r) AS linked }
       CALL { WITH h MATCH (h)-[r:TIED]->() RETURN count(r) AS tied }
       CALL { WITH h MATCH (h)-[r:NOTED]->() RETURN count(r) AS noted }
       CALL { WITH h MATCH (h)-[r:PAID]->() RETURN count(r) AS paid }
       CALL { WITH h MATCH (h)-[r:NOTED]->(l) WITH l, count(r) AS members RETURN count(CASE WHEN members <> ${MEMBERS_PER_NEIGHBOR} THEN 1 END) AS uneven }
       CALL { WITH h MATCH (h)-[]->(l:BenchLeaf) RETURN count(DISTINCT l) AS neighbors }
       RETURN linked, tied, noted, paid, uneven, neighbors`,
      { hub: hubOf(size) },
    );
    const record = result.records[0];
    if (record === undefined) throw new Error(`the anchor of ${size} relationships is missing`);
    const number = (key: string): number => Number(String(record.get(key)));
    return { linked: number('linked'), tied: number('tied'), noted: number('noted'), paid: number('paid'), neighbors: number('neighbors'), uneven: number('uneven') };
  } finally {
    await session.close();
  }
}

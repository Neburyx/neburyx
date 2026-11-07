import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { integerCandidateOf } from '../gate/templates/stable-id.js';
import type { SystemRunner } from '../gate/types.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';

let server: RunningNeo4j;
let system: SystemRunner;
let executor: Neo4jExecutor;
const logged: Record<string, unknown>[] = [];

const LABELS = ['SpikeC', 'SpikeI', 'SpikeT', 'SpikeNone', 'SpikeBuild', 'SpikeM24', 'SpikeM25', 'SpikeM26'];

function source() {
  return sourceFor(server, { entities: LABELS.map((label) => ({ type: label.toLowerCase(), label, stable_id: 'code' })), relationships: [] });
}

function templateOf(id: string, cypher: string): TemplateDefinition {
  return {
    id,
    version: '1',
    auditAction: 'test.spike',
    cypher: `PROFILE ${cypher}`,
    paramsSchema: z.strictObject({ text: z.string() }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
    scope: 'system',
    profile: true,
    paged: true,
    entityParams: [],
    relationshipParams: [],
    refsOf: () => [],
    normalize: (rows, plan = null, context) => [{ operators: plan === null ? null : plan.map((operator) => operator.name), rows: rows.length, hasMore: context?.hasMore === true }],
  };
}

const noHint = (label: string, property = 'code') => `MATCH (n:${label}) WHERE n.${property} IN [$text, $textInteger] RETURN n LIMIT $limit + 1`;
const noHintEquality = (label: string, property = 'code') => `MATCH (n:${label}) WHERE n.${property} = $text RETURN n LIMIT $limit + 1`;
const hinted = (label: string, property = 'code') => `MATCH (n:${label}) USING INDEX n:${label}(${property}) WHERE n.${property} IN [$text, $textInteger] RETURN n LIMIT $limit + 1`;
const wrap = (...branches: string[]) => `CALL { ${branches.join(' UNION ')} } WITH n LIMIT $limit + 1 RETURN n`;

const STATEMENTS: Record<string, string> = {
  constraintAndRange: wrap(noHint('SpikeC'), noHint('SpikeI')),
  constraintAndRangeHinted: wrap(hinted('SpikeC'), hinted('SpikeI')),
  textEquality: wrap(noHintEquality('SpikeT')),
  textInList: wrap(noHint('SpikeT')),
  mixed: wrap(noHint('SpikeC'), noHintEquality('SpikeT'), noHint('SpikeI')),
  noIndex: wrap(noHint('SpikeNone')),
  noIndexHinted: wrap(hinted('SpikeNone')),
  building: wrap(hinted('SpikeBuild')),
  m24: wrap(noHint('SpikeM24', 'a'), noHint('SpikeM24', 'b')),
  m25: wrap(noHint('SpikeM25', 'a'), noHint('SpikeM25', 'b')),
  m26: wrap(noHint('SpikeM26', 'a'), noHint('SpikeM26', 'b')),
};

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT spike_c FOR (n:SpikeC) REQUIRE n.code IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX spike_i FOR (n:SpikeI) ON (n.code)');
  await runAdmin(server, 'CREATE TEXT INDEX spike_t FOR (n:SpikeT) ON (n.code)');
  for (const size of [24, 25, 26]) {
    await runAdmin(server, `CREATE INDEX spike_m${size}_a FOR (n:SpikeM${size}) ON (n.a)`);
    await runAdmin(server, `CREATE INDEX spike_m${size}_b FOR (n:SpikeM${size}) ON (n.b)`);
    await runAdmin(server, `UNWIND range(0, ${size - 1}) AS i CREATE (:SpikeM${size} {a: CASE WHEN i % 3 <> 2 THEN 'SAME' ELSE 'other' END, b: CASE WHEN i % 3 <> 0 THEN 'SAME' ELSE 'other' END})`);
  }
  await runAdmin(server, 'UNWIND [123, 9007199254740993, -42] AS v CREATE (:SpikeC {code: v}), (:SpikeI {code: v})');
  await runAdmin(server, "CREATE (:SpikeC {code: 'AC-1'}), (:SpikeI {code: 'AC-1'}), (:SpikeI {code: '123'}), (:SpikeT {code: 'AC-1'}), (:SpikeT {code: '123'}), (:SpikeT {code: 456}), (:SpikeNone {code: 'AC-1'}), (:SpikeNone {code: 123})");
  await runAdmin(server, 'UNWIND range(1, 150000) AS i CREATE (:SpikeBuild {code: toString(i)})');
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  executor = createNeo4jExecutor({
    sources: mapping.sources,
    env: envFor(server),
    logger: { warn: (fields: object) => void logged.push({ ...fields }) },
  });
  const catalog = createTemplateCatalog({ templates: Object.entries(STATEMENTS).map(([id, cypher]) => templateOf(id, cypher)) });
  system = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined }, catalog }).system;
}, 900_000);

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

type Seen = { readonly operators: readonly string[] | null; readonly rows: number; readonly hasMore: boolean };
type Refused = { readonly failure: string; readonly serverCodes: readonly unknown[] };

async function run(id: string, text: string, limit = 25): Promise<Seen | Refused> {
  const before = logged.length;
  try {
    const page = await system.run({ traceId: `tr-${id}`, sourceId: 'graph', templateId: id, params: { text }, limit });
    return page.items[0] as Seen;
  } catch (error) {
    const failure = error instanceof AppError ? `${error.code}${error.reason === undefined ? '' : `:${error.reason}`}` : String(error);
    return { failure, serverCodes: logged.slice(before).map((entry) => entry['serverCode']) };
  }
}

function seen(outcome: Seen | Refused): Seen {
  if ('failure' in outcome) throw new Error(`the read failed: ${outcome.failure} ${JSON.stringify(outcome.serverCodes)}`);
  return outcome;
}

const SEEKS = /IndexSeek/;
const SCANS = /NodeByLabelScan|AllNodesScan|NodeIndexScan/;
const names = (outcome: Seen): string => (outcome.operators ?? []).join(' > ');

describe(`the search statement on ${NEO4J_SERIES}`, () => {
  it.each([['123'], ['AC-1'], ['9007199254740993'], ['a text that is no integer']])('seeks the index of every branch, under a constraint and under a plain index, with no hint, for %s, with no scan and no filter', async (text) => {
    const outcome = seen(await run('constraintAndRange', text));
    const operators = outcome.operators ?? [];
    expect(operators.filter((name) => SEEKS.test(name)), names(outcome)).toHaveLength(2);
    expect(operators.some((name) => SCANS.test(name) || name === 'Filter'), names(outcome)).toBe(false);
    expect(operators.filter((name) => name === 'Limit').length, names(outcome)).toBeGreaterThan(2);
  });

  it('plans the same seek with the index hint, which is why the statement does not carry one', async () => {
    const outcome = seen(await run('constraintAndRangeHinted', '123'));
    expect(outcome.operators?.filter((name) => SEEKS.test(name)), names(outcome)).toHaveLength(2);
  });

  it('finds the entities of both integer and text IDs and keeps a value above the safe range exact', async () => {
    expect(seen(await run('constraintAndRange', '123')).rows).toBe(3);
    expect(seen(await run('constraintAndRange', '9007199254740993')).rows).toBe(2);
  });

  it('seeks a TEXT index when the statement matches the text only, for a text and for the digits of an integer', async () => {
    for (const text of ['AC-1', '123']) {
      const outcome = seen(await run('textEquality', text));
      expect(outcome.operators?.some((name) => SEEKS.test(name)), names(outcome)).toBe(true);
      expect(outcome.operators?.some((name) => SCANS.test(name)), names(outcome)).toBe(false);
    }
  });

  it('scans the label of a TEXT-indexed property when the statement also matches an integer, which is why a TEXT-only property is matched as text only', async () => {
    const outcome = seen(await run('textInList', 'AC-1'));
    expect(outcome.operators?.some((name) => SCANS.test(name)), names(outcome)).toBe(true);
  });

  it('finds a text value of a TEXT-indexed property and not an integer value that has the same digits, which a TEXT index does not hold', async () => {
    expect(seen(await run('textEquality', '123')).rows).toBe(1);
    expect(seen(await run('textEquality', '456')).rows).toBe(0);
  });

  it('seeks every branch of a statement that mixes a constraint, a TEXT index and a plain index', async () => {
    const outcome = seen(await run('mixed', 'AC-1'));
    expect(outcome.operators?.filter((name) => SEEKS.test(name)), names(outcome)).toHaveLength(3);
    expect(outcome.operators?.some((name) => SCANS.test(name)), names(outcome)).toBe(false);
  });

  it('does not refuse a statement for a type that has no index, with or without the hint: the server scans the label', async () => {
    for (const id of ['noIndex', 'noIndexHinted']) {
      const outcome = seen(await run(id, 'AC-1'));
      expect(outcome.operators?.some((name) => SCANS.test(name)), `${id}: ${names(outcome)}`).toBe(true);
    }
  });

  it('does not refuse the hinted statement while the index is being built: the server scans the label', async () => {
    const session = server.admin.session({ database: server.database });
    try {
      await session.run('CREATE INDEX spike_build FOR (n:SpikeBuild) ON (n.code)');
      const outcome = seen(await run('building', '77'));
      const shown = await session.run("SHOW INDEXES YIELD name, state WHERE name = 'spike_build' RETURN state");
      if (String(shown.records[0]?.get('state')) === 'POPULATING') expect(outcome.operators?.some((name) => SCANS.test(name)), names(outcome)).toBe(true);
      expect(outcome.rows).toBe(1);
    } finally {
      await session.close();
    }
  });

  it.each([
    [24, 24, false],
    [25, 25, false],
    [26, 25, true],
  ])('gives %i distinct entities matched through two properties as %i rows, and says there are more only when %s', async (size, rows, hasMore) => {
    const outcome = seen(await run(`m${size}`, 'SAME'));
    expect(outcome.rows).toBe(rows);
    expect(outcome.hasMore).toBe(hasMore);
  });
});

import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdmin, runAll, startNeo4j, NEO4J_SERIES, type RunningNeo4j } from '../testing/neo4j-server.js';

let server: RunningNeo4j;

const LIMIT = 25;
const COMMON = 3000;

interface Operator {
  readonly name: string;
  readonly rows: number;
  readonly dbHits: number;
}

interface Profiled {
  readonly operators: readonly Operator[];
  readonly rows: number;
}

const branch = (label: string, property = 'code', filtered = true): string =>
  `MATCH (n:${label}) WHERE n.${property} STARTS WITH $text${filtered ? ` AND n.${property} <> $text` : ''} RETURN n LIMIT $limit + 1`;
const wrap = (...branches: string[]): string => `CALL { ${branches.join(' UNION ')} } WITH n LIMIT $limit + 1 RETURN n`;

function isOperator(value: unknown): value is { readonly operatorType: string; readonly rows: number; readonly dbHits: number; readonly children: readonly unknown[] } {
  return typeof value === 'object' && value !== null && 'operatorType' in value && typeof value.operatorType === 'string' && 'children' in value && Array.isArray(value.children);
}

function flatten(node: unknown): Operator[] {
  if (!isOperator(node)) return [];
  return [{ name: node.operatorType.replace(/@.*$/, ''), rows: Number(node.rows), dbHits: Number(node.dbHits) }, ...node.children.flatMap(flatten)];
}

async function profile(cypher: string, text: string, limit = LIMIT): Promise<Profiled> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${cypher}`, { text, limit: neo4j.int(limit) });
    return { operators: flatten(result.summary.profile), rows: result.records.length };
  } finally {
    await session.close();
  }
}

async function codes(label: string, text: string): Promise<string[]> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`MATCH (n:${label}) WHERE n.code STARTS WITH $text AND n.code <> $text RETURN n.code AS code ORDER BY code`, { text });
    return result.records.map((record) => String(record.get('code')));
  } finally {
    await session.close();
  }
}

const SEEKS = /IndexSeek/;
const SCANS = /NodeByLabelScan|AllNodesScan|NodeIndexScan|IndexContainsScan|IndexEndsWithScan/;
const names = (outcome: Profiled): string => outcome.operators.map((operator) => operator.name).join(' > ');
const seeks = (outcome: Profiled): number => outcome.operators.filter((operator) => SEEKS.test(operator.name)).length;
const scans = (outcome: Profiled): boolean => outcome.operators.some((operator) => SCANS.test(operator.name));
const totalHits = (outcome: Profiled): number => outcome.operators.reduce((sum, operator) => sum + operator.dbHits, 0);

const VALUES = ['AC-1', 'AC-1001', 'AC-10010', 'AC-1002', 'AC-2001', '123456', 'A%B', 'A_B', 'A\\B', "O'B", 'ac-1001'];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT pfx_c FOR (n:PfxC) REQUIRE n.code IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX pfx_i FOR (n:PfxI) ON (n.code)');
  await runAdmin(server, 'CREATE TEXT INDEX pfx_t FOR (n:PfxT) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX pfx_common_a FOR (n:PfxCommon) ON (n.a)');
  await runAdmin(server, 'CREATE INDEX pfx_common_b FOR (n:PfxCommon) ON (n.b)');
  for (const size of [24, 25, 26]) {
    await runAdmin(server, `CREATE INDEX pfx_m${size}_a FOR (n:PfxM${size}) ON (n.a)`);
    await runAdmin(server, `CREATE INDEX pfx_m${size}_b FOR (n:PfxM${size}) ON (n.b)`);
    await runAdmin(server, `UNWIND range(0, ${size - 1}) AS i CREATE (:PfxM${size} {a: CASE WHEN i % 3 <> 2 THEN 'SAME-a' + toString(i) ELSE 'other' END, b: CASE WHEN i % 3 <> 0 THEN 'SAME-b' + toString(i) ELSE 'other' END})`);
  }
  for (const label of ['PfxC', 'PfxI', 'PfxT', 'PfxNone']) await runAdmin(server, `UNWIND $values AS v CREATE (:${label} {code: v})`, { values: VALUES });
  await runAdmin(server, 'CREATE (:PfxI {code: 123456789}), (:PfxC {code: 987654321}), (:PfxT {code: 4567}), (:PfxNone {code: 123456789})');
  await runAdmin(server, `UNWIND range(1, ${COMMON}) AS i CREATE (:PfxCommon {a: 'common-' + toString(i), b: 'common-' + toString(i + 100000)})`);
  await runAdmin(server, 'UNWIND range(1, 150000) AS i CREATE (:PfxBuild {code: \'bld-\' + toString(i)})');
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
}, 900_000);

afterAll(async () => {
  await runAll([() => server?.stop()]);
});

describe(`the prefix statement on ${NEO4J_SERIES}`, () => {
  it.each([['PfxC'], ['PfxI'], ['PfxT']])('seeks the index of %s with no hint, no scan, with the filter that leaves out a value equal to the text and without it', async (label) => {
    for (const filtered of [true, false]) {
      const outcome = await profile(wrap(branch(label, 'code', filtered)), 'AC-');
      expect(seeks(outcome), `${label} filtered=${filtered}: ${names(outcome)}`).toBe(1);
      expect(scans(outcome), `${label} filtered=${filtered}: ${names(outcome)}`).toBe(false);
    }
  });

  it.each([['AC-'], ['12'], ['9007199254740993'], ['a text that is no integer'], ['%'], ['_'], ['\\'], ["'"], ['x'.repeat(200)]])('seeks every branch of a statement that mixes a constraint, a plain index and a TEXT index, for %s', async (text) => {
    const outcome = await profile(wrap(branch('PfxC'), branch('PfxT'), branch('PfxI')), text);
    expect(seeks(outcome), names(outcome)).toBe(3);
    expect(scans(outcome), names(outcome)).toBe(false);
  });

  it.each([['PfxC'], ['PfxI'], ['PfxT']])('treats % _ \\ and a quote in the text as characters of the text and not as a pattern, in %s', async (label) => {
    expect(await codes(label, 'A%')).toEqual(['A%B']);
    expect(await codes(label, 'A_')).toEqual(['A_B']);
    expect(await codes(label, 'A\\')).toEqual(['A\\B']);
    expect(await codes(label, "O'")).toEqual(["O'B"]);
  });

  it.each([['PfxC'], ['PfxI'], ['PfxT']])('is case-sensitive and leaves out a value equal to the text, in %s', async (label) => {
    expect(await codes(label, 'AC-1')).toEqual(['AC-1001', 'AC-10010', 'AC-1002']);
    expect(await codes(label, 'AC-1001')).toEqual(['AC-10010']);
    expect(await codes(label, 'ac-')).toEqual(['ac-1001']);
  });

  it('never matches a stored integer with a prefix of its digits, under a constraint, a plain index and a TEXT index, and still returns the strings with those digits', async () => {
    for (const label of ['PfxC', 'PfxI', 'PfxT']) expect(await codes(label, '1234'), label).toEqual(['123456']);
    expect(await codes('PfxI', '4567')).toEqual([]);
    expect(await codes('PfxT', '4567')).toEqual([]);
  });

  it('scans the label of a type that has no index, which the guard of the gate is there to prevent', async () => {
    const outcome = await profile(wrap(branch('PfxNone')), 'AC-');
    expect(scans(outcome), names(outcome)).toBe(true);
  });

  it('scans the label while an index is being built, which the guard of the gate is there to prevent', async () => {
    const session = server.admin.session({ database: server.database });
    try {
      await session.run('CREATE INDEX pfx_build FOR (n:PfxBuild) ON (n.code)');
      const outcome = await profile(wrap(branch('PfxBuild')), 'bld-77');
      const shown = await session.run("SHOW INDEXES YIELD name, state WHERE name = 'pfx_build' RETURN state");
      if (String(shown.records[0]?.get('state')) === 'POPULATING') expect(scans(outcome), names(outcome)).toBe(true);
      expect(outcome.rows).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('cuts each branch at its own limit, so a prefix that thousands of entities carry reads about a limit of them and not all of them', async () => {
    const outcome = await profile(wrap(branch('PfxCommon', 'a'), branch('PfxCommon', 'b')), 'common-');
    expect(outcome.rows).toBe(LIMIT + 1);
    expect(totalHits(outcome), names(outcome)).toBeLessThan(COMMON / 3);
    const limits = outcome.operators.filter((operator) => operator.name === 'Limit');
    expect(limits.length, names(outcome)).toBeGreaterThan(2);
    expect(limits.every((operator) => operator.rows <= LIMIT + 1)).toBe(true);
  });

  it.each([
    [24, 24],
    [25, 25],
    [26, 26],
  ])('gives %i distinct entities matched through two properties as %i rows, which is one over the limit at 26', async (size, rows) => {
    const outcome = await profile(wrap(branch(`PfxM${size}`, 'a'), branch(`PfxM${size}`, 'b')), 'SAME-');
    expect(outcome.rows).toBe(rows);
    expect(seeks(outcome), names(outcome)).toBe(2);
  });
});

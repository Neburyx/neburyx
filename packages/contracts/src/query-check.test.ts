import { describe, expect, it } from 'vitest';
import { checkIntentQuery } from './query-check.js';

const RESERVED = ' (a reserved word; put it in backticks to use it as a name)';
const check = (query: string, parameters: readonly string[] = []): readonly string[] => checkIntentQuery({ intent: 'x', query, parameters });

const PASSING: readonly (readonly [string, string, readonly string[]])[] = [
  ['plain match', 'MATCH (n:Person) WHERE n.id = $id RETURN n.name AS name', ['id']],
  ['optional match', 'MATCH (n) OPTIONAL MATCH (n)-[r:KNOWS]->(m) RETURN n, m', []],
  ['with aggregation', 'MATCH (n)-[:PAID]->(m) WITH n, count(DISTINCT m) AS c WHERE c > 2 RETURN n.id, c', []],
  ['order, skip, limit', 'MATCH (n) RETURN n ORDER BY n.id DESC SKIP $skip LIMIT $limit', ['skip', 'limit']],
  ['unwind', 'UNWIND $ids AS id MATCH (n {id: id}) RETURN n', ['ids']],
  ['expression keywords', 'MATCH (n) WHERE NOT n.a IS NULL AND (n.b IN [1, 2] OR n.c = TRUE XOR n.d CONTAINS "z") RETURN CASE WHEN n.a THEN 1 ELSE 2 END AS k', []],
  ['starts with and ends with', 'MATCH (n) WHERE n.name STARTS WITH $prefix AND n.name ENDS WITH $suffix RETURN n', ['prefix', 'suffix']],
  ['exists subquery', 'MATCH (b) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) WHERE b.id = $id } RETURN b', ['id']],
  ['exists subquery that starts with a pattern', 'MATCH (b) WHERE EXISTS { (a)-[:KNOWS]->(b) } RETURN b', []],
  ['count and collect subqueries', 'MATCH (b) RETURN COUNT { (b)--() } AS c, COLLECT { MATCH (b)--(d) RETURN d.id } AS ds', []],
  ['temporal and spatial functions', "MATCH (n) WHERE n.at > date.truncate('month', date()) AND duration.between(n.a, n.b) > duration({days: 1}) AND point.distance(n.p, point({x: 1, y: 2})) < 3 RETURN datetime()", []],
  ['lowercase and mixed case', 'match (n) where n.a = 1 return n order by n.a skip 1 limit 2', []],
  ['comment between OPTIONAL and MATCH', 'MATCH (n) OPTIONAL /* x */ MATCH (n)--(m) RETURN m', []],
  ['whitespace between ORDER and BY', 'MATCH (n) RETURN n ORDER\n\t// c\nBY n.a', []],
  ['keywords as property, label, type, key', 'MATCH (n:Use)-[:Create]->(m:Delete) WHERE n.set = 1 AND n.call = m.merge RETURN {remove: n.load, drop: 1} AS m', []],
  ['keywords in strings, comments and backticks', "MATCH (n) // DELETE n\nWHERE n.a = 'CREATE' AND n.b = \"it's SET\" AND n.c = 'CALL' RETURN n /* MERGE */, n.`create`, `set`.x", []],
  ['two adjacent strings (a quote ends a string, there is no doubled-quote escape)', "MATCH (n) WHERE n.a = 'it''s CALL' RETURN n", []],
  ['numbers by the number rules', 'MATCH (n) WHERE n.a = 1_000 AND n.b = 1.5e-3 AND n.c = 0x1F AND n.d = 0o17 AND n.e IN [1, 2] RETURN n LIMIT 10', []],
  ['numbers next to dots', 'MATCH (a)-[:R*1..3]->(b) WHERE b.x = .5 AND b.y = 1.5 AND b.z IN [1..2] RETURN [1,2,3][1..2], 1..2', []],
  ['a range', 'MATCH (a)-[:R*1..3]->(b) RETURN b', []],
  ['a backticked name with non-ASCII text', 'MATCH (n:`Straße`) WHERE n.`é` = 1 RETURN n', []],
  ['dollar inside a string', "MATCH (n) WHERE n.a = '$notAParam' RETURN n", []],
  ['backticked parameter', 'MATCH (n) WHERE n.a = $`id` RETURN n', ['id']],
  ['plain functions', 'MATCH (n) RETURN size(collect(n)), toLower(n.a), coalesce(n.b, 1), count(*)', []],
  ['backslash escape in a string', "MATCH (n) WHERE n.a = 'it\\'s CREATE' RETURN n", []],
];

describe('queries that pass', () => {
  it.each(PASSING)('%s', (_name, query, parameters) => {
    expect(check(query, parameters)).toEqual([]);
  });

  it('passes a very long valid query quickly', () => {
    const query = `MATCH (n:Person) WHERE ${'n.a = $x AND '.repeat(800)}n.b = $x RETURN n`;
    expect(query.length).toBeGreaterThan(10_000);
    const started = Date.now();
    expect(check(query, ['x'])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('passes deeply nested map braces without recursion trouble', () => {
    const depth = 5000;
    const query = `RETURN ${'{a: '.repeat(depth)}1${'}'.repeat(depth)}`;
    expect(check(query)).toEqual([]);
  });
});

const REFUSED_WORDS = [
  'CREATE', 'MERGE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'FOREACH', 'LOAD', 'USE', 'CALL', 'UNION', 'PROFILE', 'EXPLAIN', 'INSERT', 'FINISH', 'LET', 'FILTER',
  'NEXT', 'OFFSET', 'CYPHER', 'SHOW', 'TERMINATE', 'ALTER', 'DROP', 'GRANT', 'DENY', 'REVOKE', 'START', 'STOP', 'ENABLE',
];

describe('clauses that are refused', () => {
  it.each(REFUSED_WORDS)('refuses %s at the start of the query', (word) => {
    const problems = check(`${word} (n) RETURN n`);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p === `intent "x": the clause ${word} is not allowed${RESERVED}`)).toBe(true);
  });

  it.each(REFUSED_WORDS)('refuses %s after RETURN and after WITH', (word) => {
    for (const query of [`MATCH (n) RETURN n ${word} (m)`, `MATCH (n) WITH n ${word} (m) RETURN n`, `MATCH (n) RETURN n ${word.toLowerCase()} (m)`]) {
      expect(check(query).some((p) => p.includes(`the clause ${word} is not allowed`))).toBe(true);
    }
  });

  it('refuses LOAD CSV and DETACH DELETE by their first word', () => {
    expect(check('LOAD CSV FROM "x" AS r RETURN r').some((p) => p.includes('LOAD'))).toBe(true);
    expect(check('MATCH (n) DETACH DELETE n').some((p) => p.includes('DETACH'))).toBe(true);
  });

  it('refuses a variable named like a keyword', () => {
    expect(check('MATCH (create) RETURN create').some((p) => p.includes('CREATE'))).toBe(true);
  });

  it('refuses an unknown word at a clause position without echoing it', () => {
    const problems = check('MATCH (n) RETURN n FROBNICATE (m)');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^intent "x": /);
    expect(problems[0]).not.toContain('FROBNICATE');
  });

  it('refuses a query that does not start with a clause', () => {
    expect(check('FROBNICATE (n) RETURN n')).toHaveLength(1);
    expect(check('(n) RETURN n')).toHaveLength(1);
  });

  it('refuses a lone OPTIONAL or ORDER', () => {
    expect(check('MATCH (n) OPTIONAL (m) RETURN n').some((p) => p.includes('OPTIONAL'))).toBe(true);
    expect(check('MATCH (n) RETURN n ORDER n.a').some((p) => p.includes('ORDER'))).toBe(true);
  });

  it('refuses a write in a subquery', () => {
    const problems = check('MATCH (b) WHERE EXISTS { MATCH (a) CREATE (c) } RETURN b');
    expect(problems).toEqual([`intent "x": the clause CREATE is not allowed${RESERVED}`]);
    expect(check('MATCH (b) RETURN COUNT { CALL { MATCH (a) RETURN a } RETURN 1 }').some((p) => p.includes('CALL'))).toBe(true);
    expect(check('MATCH (b) RETURN COLLECT { MATCH (a) SET a.x = 1 RETURN a }').some((p) => p.includes('SET'))).toBe(true);
  });

  it('refuses an empty subquery and subqueries nested too deeply', () => {
    expect(check('MATCH (b) WHERE EXISTS { } RETURN b').some((p) => p.includes('subquery is empty'))).toBe(true);
    const query = `MATCH (b) WHERE ${'EXISTS { MATCH (a) WHERE '.repeat(40)}true${' }'.repeat(40)} RETURN b`;
    expect(check(query).some((p) => p.includes('nested too deeply'))).toBe(true);
  });

  it('refuses a second statement', () => {
    const problems = check('MATCH (n) RETURN n; MATCH (m) RETURN m');
    expect(problems.some((p) => p.includes(';'))).toBe(true);
  });

  it('refuses an empty query', () => {
    expect(check('')).toEqual(['intent "x": the query is empty']);
    expect(check('  // nothing\n')).toEqual(['intent "x": the query is empty']);
  });
});

describe('text that hides a word', () => {
  it.each([
    ['1CREATE (m)'],
    ['MATCH (n) RETURN 1MERGE (m)'],
    ['MATCH (n) RETURN 1CALL { 1CREATE (m) }'],
    ['MATCH (n) RETURN 1FOREACH (x IN [1] | 1CREATE (m))'],
    ['RETURN 1UNION RETURN 2'],
    ['RETURN 1.5e3CREATE (m)'],
    ['RETURN 1_000CREATE (m)'],
    ['RETURN 0x1FCREATE (m)'],
    ['RETURN 1e5SET (m)'],
    ['RETURN 1.CREATE (m)'],
    ['RETURN 1.5.CREATE (m)'],
    ['RETURN 1._x'],
  ])('refuses a number that runs into a word: %s', (query) => {
    const problems = check(query);
    expect(problems).toContain('intent "x": a number runs into a word');
    expect(problems.every((p) => p.startsWith('intent "x": '))).toBe(true);
  });

  it.each([
    ['RETURN apoc\u00A0.do(1)'],
    ['RETURN `apoc`\u2003.`do`(1)'],
    ['RETURN x\u001C.y(1)'],
    ['RETURN apoc\u3000.date.parse("x")'],
    ['RETURN n\u0085CREATE (m)'],
    ['MATCH (n) RETURN n\u200BDELETE n'],
    ['MATCH (\u00E9) RETURN 1'],
    ['MATCH (n) RETURN n\u0000'],
  ])('refuses a character outside plain ASCII or whitespace in code: %j', (query) => {
    expect(check(query)).toContain('intent "x": the query holds a character outside plain ASCII or whitespace');
  });

  it.each([['MATCH (n) RETURN n // x\u2028CREATE (m)'], ['MATCH (n) RETURN n // x\u0085CREATE (m)'], ['MATCH (n) RETURN n // x\u2029DELETE n'], ['MATCH (n) RETURN n // x\u000BSET n.a = 1'], ['MATCH (n) RETURN n // x\u000CSET n.a = 1']])(
    'refuses a comment that holds a line break a database may read: %j',
    (query) => {
      expect(check(query)).toEqual(['intent "x": a comment holds a line break character other than a plain one']);
    },
  );

  it('lets a comment, a string and a backticked name hold any other text', () => {
    expect(check("MATCH (n) // \u00E9\u2603\nWHERE n.a = '\u2028\u00E9' RETURN n /* \u2028 */, n.`\u2028`")).toEqual([]);
  });

  it('still reads a plain line break as the end of a comment', () => {
    expect(check('MATCH (n) // x\nCREATE (m) RETURN n')).toEqual([`intent "x": the clause CREATE is not allowed${RESERVED}`]);
    expect(check('MATCH (n) // x\rCREATE (m) RETURN n')).toEqual([`intent "x": the clause CREATE is not allowed${RESERVED}`]);
  });

  it('refuses code after two adjacent strings', () => {
    expect(check("MATCH (n) WHERE n.a = 'it''s' CREATE (m) RETURN n")).toEqual([`intent "x": the clause CREATE is not allowed${RESERVED}`]);
  });
});

describe('functions that are refused', () => {
  it.each([
    ['MATCH (n) RETURN apoc.cypher.run("x", {})', 'apoc.cypher.run'],
    ['MATCH (n) RETURN `apoc.cypher.run`("x", {})', 'apoc.cypher.run'],
    ['MATCH (n) RETURN apoc.`do`.when(true, "a", "b")', 'apoc.do.when'],
    ['MATCH (n) RETURN db.labels()', 'db.labels'],
    ['MATCH (n) RETURN dbms.components()', 'dbms.components'],
    ['MATCH (n) RETURN gds.version()', 'gds.version'],
    ['MATCH (n) RETURN other.fn(1)', 'other.fn'],
    ['MATCH (n) RETURN APOC . text . join(1)', 'APOC.text.join'],
    ['MATCH (n) RETURN datex.truncate(1)', 'datex.truncate'],
  ])('refuses %s', (query, name) => {
    const problems = check(query);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(`intent "x": the function ${name} is not allowed`);
  });
});

describe('text that does not read as tokens', () => {
  it.each([
    ["MATCH (n) WHERE n.a = 'abc RETURN n"],
    ['MATCH (n) WHERE n.a = "abc RETURN n'],
    ["MATCH (n) WHERE n.a = 'abc\\'"],
    ['MATCH (n) RETURN n /* open'],
    ['MATCH (n) RETURN n.`open'],
    ['MATCH (n) WHERE n.a = $`open'],
  ])('refuses %s with one problem', (query) => {
    const problems = check(query);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('intent "x": the query does not read as a token stream');
  });

  it('refuses brackets that do not balance', () => {
    expect(check('MATCH (n RETURN n').some((p) => p.includes('brackets'))).toBe(true);
    expect(check('MATCH (n] RETURN n').some((p) => p.includes('brackets'))).toBe(true);
    expect(check('MATCH (n)) RETURN n').some((p) => p.includes('brackets'))).toBe(true);
  });

  it('refuses nested braces that hold a write', () => {
    const query = `MATCH (b) WHERE ${'EXISTS { MATCH (a) WHERE '.repeat(5)}EXISTS { CREATE (c) }${' }'.repeat(5)} RETURN b`;
    expect(check(query)).toEqual([`intent "x": the clause CREATE is not allowed${RESERVED}`]);
  });
});

describe('parameters', () => {
  it('reports a declared parameter the query does not use, by name', () => {
    expect(check('MATCH (n) RETURN n', ['missing'])).toEqual(['intent "x": the parameter $missing is declared but not used in the query']);
  });

  it('reports a parameter the query uses and is not declared, by name', () => {
    expect(check('MATCH (n) WHERE n.a = $extra RETURN n')).toEqual(['intent "x": the query uses the parameter $extra that is not declared']);
  });

  it('reports a name that does not fit', () => {
    for (const [query, name] of [['MATCH (n) WHERE n.a = $0 RETURN n', '0'], ['MATCH (n) WHERE n.a = $1abc RETURN n', '1abc']] as const) {
      const problems = check(query, [name]);
      expect(problems).toEqual([`intent "x": the parameter $${name} does not have a valid name`, `intent "x": the parameter $${name} is declared but not used in the query`]);
    }
    expect(check('MATCH (n) WHERE n.a = $0 RETURN n').some((p) => p.includes('$0'))).toBe(true);
  });

  it('reports a backticked name that does not fit without echoing it', () => {
    const problems = check('MATCH (n) WHERE n.a = $`SENTINEL_TEXT x` RETURN n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toContain('SENTINEL_TEXT');
  });

  it('reports each problem once', () => {
    const problems = check('MATCH (n) WHERE n.a = $e AND n.b = $e RETURN n');
    expect(problems).toHaveLength(1);
  });
});

describe('what a problem says', () => {
  it('never echoes text of the query', () => {
    const queries = [
      "MATCH (n) WHERE n.a = 'SENTINEL_TEXT' CREATE (m) RETURN n; RETURN 'SENTINEL_TEXT'",
      "MATCH (n) WHERE n.a = 'SENTINEL_TEXT' AND n.b = $p RETURN apoc.x.y('SENTINEL_TEXT') /* SENTINEL_TEXT */",
      "MATCH (n) // SENTINEL_TEXT\nRETURN n SENTINEL_WORD (m) 'SENTINEL_TEXT",
      "MATCH (n) WHERE EXISTS { MATCH (a {k: 'SENTINEL_TEXT'}) DELETE a } RETURN n",
    ];
    for (const query of queries) {
      const problems = check(query);
      expect(problems.length).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(problem).not.toContain('SENTINEL');
        expect(problem).toMatch(/^intent "x": [^"]+$/);
      }
    }
  });
});

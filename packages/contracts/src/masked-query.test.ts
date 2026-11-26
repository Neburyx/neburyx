import { describe, expect, it } from 'vitest';
import { mayUseMaskedProperty } from './masked-query.js';
import { checkIntentQuery } from './query-check.js';

const MARKED = ['name', 'born on'];
const may = (query: string, properties: readonly string[] = MARKED): boolean => mayUseMaskedProperty(query, properties);

const LISTED = [
  'count', 'collect', 'sum', 'avg', 'min', 'max', 'stdev', 'stdevp', 'percentilecont', 'percentiledisc', 'all', 'any', 'none', 'single', 'exists', 'coalesce', 'elementid', 'id', 'type', 'length', 'size', 'startnode',
  'endnode', 'head', 'last', 'toboolean', 'tobooleanornull', 'tofloat', 'tofloatornull', 'tointeger', 'tointegerornull', 'tostring', 'tostringornull', 'char_length', 'character_length', 'timestamp', 'randomuuid', 'labels',
  'nodes', 'relationships', 'range', 'reverse', 'tail', 'reduce', 'tobooleanlist', 'tofloatlist', 'tointegerlist', 'tostringlist', 'abs', 'ceil', 'floor', 'isnan', 'rand', 'round', 'sign', 'e', 'exp', 'log', 'log10', 'sqrt',
  'pi', 'sin', 'cos', 'tan', 'cot', 'asin', 'acos', 'atan', 'atan2', 'degrees', 'radians', 'haversin', 'left', 'right', 'substring', 'split', 'replace', 'trim', 'ltrim', 'rtrim', 'btrim', 'lower', 'upper', 'tolower', 'toupper',
  'normalize', 'shortestPath', 'allShortestPaths', 'duration.between', 'duration.inDays', 'duration.inMonths', 'duration.inSeconds', 'point.distance', 'point.withinBBox', 'vector.similarity.cosine', 'vector.similarity.euclidean',
] as const;

const CONSTRUCTORS = ['date', 'datetime', 'localdatetime', 'time', 'localtime', 'duration', 'point'] as const;

describe('a property the text names', () => {
  it.each([
    'MATCH (n) WHERE n.name = 1 RETURN n',
    'MATCH (n) WHERE n.`name` = 1 RETURN n',
    'MATCH (n) WHERE n.`born on` = 1 RETURN n',
    'MATCH (n) WHERE $p.name = 1 RETURN n',
    'MATCH (n {name: 1}) RETURN n',
    'MATCH (n:L {a: 1, name: 2}) RETURN n',
    'MATCH (a)-[r {name: 1}]->(b) RETURN r',
    'MATCH (n) WHERE EXISTS { (n)--({name: 1}) } RETURN n',
    'MATCH (n) RETURN n ORDER BY n.name',
  ])('is a use: %s', (query) => {
    expect(may(query)).toBe(true);
  });

  it.each([
    'MATCH (n) WHERE n.username = 1 AND n.nam = 1 AND n.names = 1 RETURN n',
    'MATCH (n) WHERE n.Name = 1 AND n.NAME = 2 RETURN n',
    'MATCH (n) WHERE n.id = "n.name" /* n.name */ RETURN n // name',
    'MATCH (name:name) WHERE name.id = $name RETURN name',
    'MATCH (name) WHERE COUNT { (name)--(c) WHERE name:L } > 0 RETURN name',
    'MATCH (n:L {username: 1}) RETURN n',
  ])('is not: %s', (query) => {
    expect(may(query)).toBe(false);
  });

  it('compares a name whole, whatever its length', () => {
    expect(may('MATCH (n) WHERE n.name = 1 RETURN n', ['nam'])).toBe(false);
    expect(may('MATCH (n) WHERE n.username = 1 RETURN n', ['username'])).toBe(true);
    expect(may('MATCH (n) WHERE n.`é` = 1 RETURN n', ['é'])).toBe(true);
    expect(may('MATCH (n) WHERE n.`é` = 1 RETURN n', ['é'])).toBe(true);
  });

  it('is no use when no property is marked, whatever the query holds', () => {
    expect(may('MATCH (n) WHERE n[$k] = keys(n) CALL x.y() \\u0000', [])).toBe(false);
  });
});

describe('a use the text does not name', () => {
  it.each([
    'MATCH (n) WHERE n[$k] = 1 RETURN n',
    "MATCH (n) WHERE n['a'] = 1 RETURN n",
    'MATCH (n) WHERE (n)[$k] = 1 RETURN n',
    'WITH [1] AS list RETURN list[0]',
    'WITH [1] AS all RETURN all[0]',
    'MATCH (in) WHERE in[$k] = 1 RETURN in',
    'MATCH (in IS L) WHERE in[$k] = 1 RETURN in',
    'MATCH (a)-[then IS T]->(b) WHERE then[$k] = 1 RETURN b',
    'MATCH (then WHERE then.id = 1) RETURN then[$k]',
    'MATCH p = (a)-->(b) WITH [then = (a)-->(b) | then[0]] AS l RETURN l',
    'WITH [1] AS l RETURN [when IN l | when[0]]',
    'MATCH (end:L) RETURN end[$k]',
    'UNWIND [1] AS then RETURN then[0]',
    'MATCH (n) WITH {in: n} AS m RETURN m.in[$k]',
    'RETURN [1, 2][0]',
    'RETURN CASE WHEN true THEN [1] END[0]',
    'MATCH (n) RETURN properties(n)[$k]',
    'MATCH (n) RETURN n {.*}',
    'MATCH (n) RETURN n {.id, .*}',
    'MATCH (n) WHERE n.\\u006eame = 1 RETURN n',
    'MATCH (n) WHERE n.\\U006eame = 1 RETURN n',
    "MATCH (n) WHERE n.id = '\\u0041' RETURN n",
    'CALL db.labels()',
    'MATCH (n) CALL { RETURN 1 } RETURN n',
    'MATCH (n) RETURN properties(n)',
    'MATCH (n) RETURN keys(n)',
    'MATCH (n) RETURN KEYS(n)',
    'MATCH (n) RETURN apoc.map.get(n, $k)',
    'MATCH (n) RETURN valueType(n)',
    'MATCH (n) RETURN isEmpty(n)',
    'MATCH (n) RETURN nullIf(n, 1)',
    'MATCH (n) RETURN date.truncate("day", n)',
    'MATCH (n) RETURN `size`(n)',
    'MATCH (n) RETURN date.`transaction`()',
    'MATCH (n) WHERE n.id = "unterminated RETURN n',
    'MATCH (n)) RETURN n',
  ])('is refused: %s', (query) => {
    expect(may(query)).toBe(true);
  });

  it.each(CONSTRUCTORS)('allows %s with nothing, one literal, one parameter or one map written out', (name) => {
    for (const argument of ['', '"2026-01-01"', '1', '$value', '{year: 2026}', '{a: n.id, b: $v}']) expect(may(`MATCH (n) RETURN ${name}(${argument})`), argument).toBe(false);
  });

  it.each(CONSTRUCTORS)('refuses %s with anything that can hold a map', (name) => {
    for (const argument of ['n', 'n.id', 'n.id, 1', '$a, $b', 'head([n])', '{a: 1} , n', '1 + n.id', '[1]']) expect(may(`MATCH (n) RETURN ${name}(${argument})`), argument).toBe(true);
  });

  it('refuses the constructor of a map taken from a node', () => {
    expect(may('MATCH (x) WITH {a: x} AS m RETURN point(m.a)')).toBe(true);
  });
});

describe('what a masked query may use', () => {
  it.each(LISTED)('allows %s, in any letter case', (name) => {
    for (const spelled of [name, name.toUpperCase()]) expect(may(`MATCH (n) RETURN ${spelled}(n.id, $v)`)).toBe(false);
  });

  it.each([
    'MATCH (n) WHERE n.id IN [1, 2] RETURN n',
    'UNWIND [1, 2] AS id RETURN id',
    'RETURN [1], [[2]], {a: [3]}',
    'MATCH (a)-[r:T]->(b)<-[:T*1..3]-(c)-[]-(d)-->(e) RETURN r',
    'MATCH (a) RETURN [(a)-->(b) | b], [x IN [a] WHERE x.id = 1 | x]',
    'MATCH p = shortestPath((a)-[*..3]->(b)) RETURN p',
    'MATCH (n) WHERE NOT (n.id = 1) AND (n.id IN ([1])) RETURN n ORDER BY (n.id)',
    'MATCH (n) RETURN CASE (n.id) WHEN (1) THEN [1] ELSE (n) END',
    'MATCH (n) WHERE EXISTS { (n)--() } AND COUNT { (n)--(m) WHERE m.id = 1 } > 0 RETURN n',
    'MATCH ((a)-->(b)){1,3} RETURN a',
    'MATCH (n) RETURN n {.id}',
    'MATCH (n) WHERE n.id = $id RETURN count(DISTINCT n), count(*)',
  ])('runs: %s', (query) => {
    expect(may(query)).toBe(false);
  });

  it('reads a query that the clause check passes', () => {
    const query = 'MATCH (n) WHERE n.id = $id RETURN n';
    expect(checkIntentQuery({ intent: 'x', query, parameters: ['id'] })).toEqual([]);
    expect(may(query)).toBe(false);
  });

  it('answers for a very long query quickly', () => {
    const started = Date.now();
    expect(may(`MATCH (n) WHERE ${'n.id = $x AND '.repeat(2000)}n.id = $x RETURN n`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

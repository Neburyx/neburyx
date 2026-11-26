import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkIntentQuery, type AskFolder, type AskIntent } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFileQueryRunner } from '../ask/file-query-run.js';
import { parseMapping } from '../mapping/load.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { PACKS, packMappingText, repoRoot, type Pack } from '../testing/pack-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { fileQueryDepsOf } from './file-query.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const parametersOf = (text: string): string[] => (text.includes('$id') ? ['id'] : []);
const intentOf = (name: string, text: string, parameters = parametersOf(text)): AskIntent => ({ name, parameters, kind: 'query', query: { text, sha256: sha(text) } });

function folderOf(sourceId: string, intents: readonly AskIntent[]): AskFolder {
  return {
    sourceIds: [sourceId],
    source: (id) => (id === sourceId ? { classification: { text: '', sha256: '' }, intents } : undefined),
    intent: (id, name) => (id === sourceId ? intents.find((intent) => intent.name === name) : undefined),
  };
}

function rig(mapping: MappingModel, sourceId: string, intents: readonly AskIntent[]) {
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [] }));
  const record = auditing();
  const folder = folderOf(sourceId, intents);
  const { gate } = testSourceGate(mapping, { executor, seams: record.seams, fileQueries: fileQueryDepsOf(() => folder) });
  const runner = createFileQueryRunner({ gate });
  const run = (intent: AskIntent, mask?: boolean): Promise<string> =>
    runner
      .run({ traceId: 'tr-m', principal: LOCAL_PRINCIPAL, sourceId, intent: intent.name, values: Object.fromEntries(intent.parameters.map((name) => [name, 'VALUE-MARKER'])), ...(mask === undefined ? {} : { mask }) })
      .then(
        () => 'ok',
        (error: { code?: string; details?: { reason?: string } }) => `${error.code}:${error.details?.reason}`,
      );
  return { run, executor, record };
}

const MASKED = 'INVALID_REQUEST:file-query-masked';

const mapping = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'person', label: 'Person', stable_id: 'id', pii: [{ property: 'name', class: 'name' }, 'Ünit'] },
      { type: 'order_line', label: 'Order Line', stable_id: 'id' },
    ],
  }),
);
const unmarked = mappingOf(sourceWith('alpha'));

const NAMED: readonly (readonly [string, string])[] = [
  ['a property in WHERE', 'MATCH (p:Person) WHERE p.name = $id RETURN p'],
  ['a sort', 'MATCH (p:Person) RETURN p ORDER BY p.name'],
  ['a returned expression that chooses', 'MATCH (p:Person) RETURN CASE WHEN p.name STARTS WITH $id THEN p ELSE null END AS q'],
  ['a backticked name', 'MATCH (p:Person) WHERE p.`name` = $id RETURN p'],
  ['whitespace around the dot', 'MATCH (p:Person) WHERE p . name = $id RETURN p'],
  ['a comment between the dot and the name', 'MATCH (p:Person) WHERE p./* a */name = $id RETURN p'],
  ['a line comment between the dot and the name', 'MATCH (p:Person) WHERE p.// a\n name = $id RETURN p'],
  ['an inline property map', 'MATCH (p:Person {name: $id}) RETURN p'],
  ['a later key of a property map', 'MATCH (p:Person {id: $id, `name`: $id}) RETURN p'],
  ['a relationship property map', 'MATCH (a)-[r:KNOWS {name: $id}]->(b) RETURN a, r, b'],
  ['a map projection', 'MATCH (p:Person) WHERE p {.name}.name = $id RETURN p'],
  ['a subquery', 'MATCH (p:Person) WHERE EXISTS { MATCH (q:Person) WHERE q.name = p.id } RETURN p'],
  ['a property of a type that does not mark it', 'MATCH (o:`Order Line`) WHERE o.name = $id RETURN o'],
  ['a decomposed spelling of a non-ASCII name', 'MATCH (p:Person) WHERE p.`U\u0308nit` = $id RETURN p'],
];

const UNTELLABLE: readonly (readonly [string, string])[] = [
  ['a subscript by a parameter', 'MATCH (p:Person) WHERE p[$id] = 1 RETURN p'],
  ['a subscript by text', "MATCH (p:Person) WHERE p['na' + 'me'] = $id RETURN p"],
  ['a subscript of a parenthesized variable', 'MATCH (p:Person) WHERE (p)[$id] = 1 RETURN p'],
  ['a subscript of a variable named like a keyword', 'MATCH (in:Person) WHERE in[$id] = 1 RETURN in'],
  ['a subscript of a property named like a keyword', 'MATCH (p:Person) WITH {in: p} AS m WHERE m.in[$id] = 1 RETURN m.in'],
  ['an integer subscript', 'MATCH (p:Person) WITH collect(p) AS all RETURN all[0]'],
  ['properties()', 'MATCH (p:Person) WHERE properties(p) = {} RETURN p'],
  ['properties in capitals', 'MATCH (p:Person) WITH PROPERTIES(p) AS m, p RETURN p'],
  ['keys()', "MATCH (p:Person) WHERE $id IN keys(p) RETURN p"],
  ['a backticked function', 'MATCH (p:Person) WHERE `keys`(p) IS NULL RETURN p'],
  ['a function that is not listed', 'MATCH (p:Person) WHERE valueType(p) = $id RETURN p'],
  ['a map projection of everything', 'MATCH (p:Person) WITH p {.*} AS m, p RETURN p'],
  ['a unicode escape in a name', 'MATCH (p:Person) WHERE p.\\u006Eame = $id RETURN p'],
  ['a unicode escape in a comment', 'MATCH (p:Person) /* \\u002A */ RETURN p'],
  ['a unicode escape in a string', "MATCH (p:Person) WHERE p.id = '\\U006E' RETURN p"],
  ['a constructor given a variable', 'MATCH (p:Person) WHERE point(p) IS NOT NULL RETURN p'],
  ['a constructor given a property that can hold a node', 'MATCH (p:Person) WITH {a: p} AS m, p WHERE point(m.a) IS NOT NULL RETURN p'],
  ['a constructor given two arguments', 'MATCH (p:Person) WHERE date($id, p) IS NOT NULL RETURN p'],
];

const ALLOWED: readonly (readonly [string, string])[] = [
  ['no property at all', 'MATCH (p:Person)-[k:KNOWS]->(q:Person) RETURN p, k, q'],
  ['a property that is not marked', 'MATCH (p:Person {id: $id}) RETURN p ORDER BY p.id'],
  ['a longer name', 'MATCH (p:Person) WHERE p.username = $id RETURN p'],
  ['another letter case', 'MATCH (p:Person {Name: $id}) WHERE p.NAME = $id RETURN p'],
  ['the name in a string and a comment', "MATCH (p:Person) /* p.name */ WHERE p.id = 'p.name' // name\n RETURN p"],
  ['the name as a label, a variable and a parameter', 'MATCH (name:name) WHERE name.id = $name RETURN name'],
  ['a label predicate in a subquery', 'MATCH (name) WHERE COUNT { (name)--(c) WHERE name:Person } > 0 RETURN name'],
  ['list literals', 'MATCH (p:Person) WHERE p.id IN [1, 2] AND p.id IN [$id] RETURN p, [p] AS list'],
  ['relationship patterns', 'MATCH (a)-[r:KNOWS]->(b)<-[:KNOWS*1..3]-(c)-[]-(d) RETURN a, r, b, c, d'],
  ['comprehensions', 'MATCH (p:Person) RETURN [(p)-->(q) | q] AS others, [x IN [p] WHERE x.id = $id | x] AS same'],
  ['parentheses after keywords', 'MATCH (p:Person) WHERE NOT (p.id = $id) AND (p.id IN ([$id])) RETURN p'],
  ['functions of the list', 'MATCH (p:Person) WHERE toLower(p.id) = $id AND size(labels(p)) > 0 AND exists(p.id) RETURN p, count(*) AS c'],
  ['constructors of literals, parameters and maps', "MATCH (p:Person) WHERE p.at > date() AND p.at < date('2026-01-01') AND p.t > datetime($id) AND p.q = point({x: 1, y: 2}) AND duration.between(p.a, p.b) IS NOT NULL RETURN p"],
];

describe('a masked file query is no way to learn a masked value', () => {
  it.each([...NAMED, ...UNTELLABLE])('refuses %s under the mask before the source is called, and runs it without', async (_name, text) => {
    const intent = intentOf('q', text);
    expect(checkIntentQuery({ intent: 'q', query: text, parameters: intent.parameters })).toEqual([]);
    const { run, executor, record } = rig(mapping, 'alpha', [intent]);
    expect(await run(intent, true)).toBe(MASKED);
    expect(executor.calls).toHaveLength(0);
    expect(record.events).toHaveLength(1);
    expect(record.events[0]).toMatchObject({ action: 'ask.file_query', result: 'refused', detail: { fileQuery: { intent: 'q', queryHash: sha(text) }, reason: 'file-query-masked' } });
    expect(JSON.stringify(record.events)).not.toMatch(/MATCH|VALUE-MARKER|name|Ünit/);
    expect(await run(intent, false)).toBe('ok');
    expect(await run(intent)).toBe('ok');
    expect(executor.calls).toHaveLength(2);
  });

  it.each(ALLOWED)('runs %s under the mask', async (_name, text) => {
    const intent = intentOf('q', text, text.includes('$name') ? ['name'] : parametersOf(text));
    expect(checkIntentQuery({ intent: 'q', query: text, parameters: intent.parameters })).toEqual([]);
    const { run, executor } = rig(mapping, 'alpha', [intent]);
    expect(await run(intent, true)).toBe('ok');
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.cypher).toBe(text);
  });

  it.each([...NAMED, ...UNTELLABLE])('refuses nothing on a source that marks no property: %s', async (_name, text) => {
    const intent = intentOf('q', text);
    const { run } = rig(unmarked, 'alpha', [intent]);
    expect(await run(intent, true)).toBe('ok');
  });

  it('says nothing of the query or of the property in the error', async () => {
    const intent = intentOf('q', 'MATCH (p:Person) WHERE p.name = $id RETURN p');
    const { gate } = testSourceGate(mapping, { fileQueries: fileQueryDepsOf(() => folderOf('alpha', [intent])) });
    const error: unknown = await gate.fileQuery({ traceId: 'tr-e', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', intent: 'q', values: { id: 'VALUE-MARKER' }, mask: true }).catch((thrown: unknown) => thrown);
    expect(JSON.stringify([error, String(error), (error as Error).message])).not.toMatch(/MATCH|VALUE-MARKER|name/);
  });
});

const intentsSchema = z.record(z.string(), z.object({ parameters: z.array(z.string()), query: z.string().optional() }));

function packOf(pack: Pack): { readonly mapping: MappingModel; readonly source: SourceModel; readonly intents: readonly AskIntent[] } {
  const parsed = parseMapping(packMappingText(pack), 'neburyx.yaml');
  const [source] = parsed.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const folder = intentsSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'domain-packs', pack, 'ask', 'intents.json'), 'utf8')));
  const intents = Object.entries(folder).flatMap(([name, entry]) => (entry.query === undefined ? [] : [intentOf(name, entry.query, entry.parameters)]));
  return { mapping: parsed, source, intents };
}

describe.each(PACKS)('on the %s pack', (pack) => {
  const { mapping: packMapping, source, intents } = packOf(pack);
  const marked = source.entities.find((entity) => entity.pii.length > 0);
  const label = marked?.label ?? '';
  const [property = ''] = marked?.pii ?? [];
  const plain = source.entities.flatMap((entity) => entity.filterable).find((key) => !source.entities.some((entity) => entity.pii.includes(key))) ?? '';

  it('has file queries, a marked property and a plain one to try', () => {
    expect(intents.length).toBeGreaterThan(0);
    expect(property).not.toBe('');
    expect(plain).not.toBe('');
  });

  it("refuses the pack's own file query, which filters by a marked property, under the mask, and runs it without", async () => {
    for (const intent of intents) {
      const { run, executor, record } = rig(packMapping, source.id, intents);
      expect(await run(intent, true)).toBe(MASKED);
      expect(executor.calls).toHaveLength(0);
      expect(record.events[0]).toMatchObject({ result: 'refused', detail: { reason: 'file-query-masked' } });
      expect(await run(intent, false)).toBe('ok');
      expect(executor.calls[0]?.cypher).toBe(intent.kind === 'query' ? intent.query.text : '');
    }
  });

  it.each([
    ['a filter', () => `MATCH (n:\`${label}\`) WHERE n.${property} = $id RETURN n`],
    ['a sort', () => `MATCH (n:\`${label}\`) RETURN n ORDER BY n.${property}`],
    ['a property map', () => `MATCH (n:\`${label}\` {${property}: $id}) RETURN n`],
    ['a dynamic access', () => `MATCH (n:\`${label}\`) WHERE n[$id] IS NOT NULL RETURN n`],
  ])('refuses %s on a marked property under the mask', async (_name, text) => {
    const intent = intentOf('q', text());
    const { run, executor } = rig(packMapping, source.id, [intent]);
    expect(await run(intent, true)).toBe(MASKED);
    expect(executor.calls).toHaveLength(0);
    expect(await run(intent, false)).toBe('ok');
  });

  it('runs a query of a property that is not marked, under the mask and without', async () => {
    const intent = intentOf('q', `MATCH (n:\`${label}\`) WHERE n.${plain} = $id RETURN n`);
    const { run, executor } = rig(packMapping, source.id, [intent]);
    expect(await run(intent, true)).toBe('ok');
    expect(await run(intent, false)).toBe('ok');
    expect(executor.calls).toHaveLength(2);
  });
});

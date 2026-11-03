import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { parseCases } from '../cases.js';
import { checkCases, type Run } from './cases.js';
import { miniDefinition, miniMapping } from './fixture.js';

const cases = parseCases(
  `
preset:
  entity: { type: widget, id: W0001 }
  case_ref: "REF-DEMO-1"
cases:
  - id: widget-gadgets
    title: A widget and its gadgets
    expect:
      - { node: { type: widget, id: W0001 }, via: HAS, direction: out, count: 2 }
      - { node: { type: gadget, id: G000 }, via: HAS, direction: in, ids: [W0001, W0002] }
`,
  miniMapping,
  miniDefinition,
);

interface Answer {
  readonly nodes?: number;
  readonly found: number;
  readonly listed?: number;
}

function graphAnswering(answers: { readonly count: Answer; readonly ids: Answer }): { run: Run; queries: { cypher: string; parameters: Record<string, string | boolean | readonly string[]> }[] } {
  const queries: { cypher: string; parameters: Record<string, string | boolean | readonly string[]> }[] = [];
  const run: Run = async (cypher, parameters) => {
    queries.push({ cypher, parameters });
    const answer = 'ids' in parameters ? answers.ids : answers.count;
    return [{ nodes: neo4j.int(answer.nodes ?? 1), found: neo4j.int(answer.found), ...(answer.listed === undefined ? {} : { listed: neo4j.int(answer.listed) }) }];
  };
  return { run, queries };
}

const MATCHING = { count: { found: 2 }, ids: { found: 2, listed: 2 } };

describe('checking cases against a graph', () => {
  it('fails an expectation whose listed stable IDs differ by one, naming the case and the expectation', async () => {
    const { run } = graphAnswering({ ...MATCHING, ids: { found: 2, listed: 1 } });
    const failures = await checkCases(cases, miniMapping, run);
    expect(failures).toEqual(['case widget-gadgets, expectation 2: 2 distinct neighbors of which 1 are among the 2 listed']);
  });

  it('fails a node with far more neighbors than are listed, and never retrieves the neighbors themselves', async () => {
    const { run, queries } = graphAnswering({ ...MATCHING, ids: { found: 100_000, listed: 2 } });
    expect(await checkCases(cases, miniMapping, run)).toEqual(['case widget-gadgets, expectation 2: 100000 distinct neighbors of which 2 are among the 2 listed']);
    for (const query of queries) expect(query.cypher).not.toMatch(/collect\(|RETURN m\b/);
  });

  it('fails an expectation whose count is off by one, naming the case and the expectation', async () => {
    const { run } = graphAnswering({ ...MATCHING, count: { found: 3 } });
    expect(await checkCases(cases, miniMapping, run)).toEqual(['case widget-gadgets, expectation 1: 3 distinct neighbors, not 2']);
  });

  it('passes when every answer matches', async () => {
    const { run } = graphAnswering(MATCHING);
    expect(await checkCases(cases, miniMapping, run)).toEqual([]);
  });

  it('builds each query from the mapping, quoting names and passing the stable ID as a parameter only', async () => {
    const { run, queries } = graphAnswering(MATCHING);
    await checkCases(cases, miniMapping, run);
    expect(queries.map((query) => query.parameters)).toEqual([{ id: 'W0001' }, { id: 'G000', ids: ['W0001', 'W0002'] }]);
    expect(queries[0]?.cypher).toBe('MATCH (n:`Widget` {`widgetId`: $id}) OPTIONAL MATCH (n)-[:`HAS`]->(m:`Gadget`) RETURN count(DISTINCT n) AS nodes, count(DISTINCT m) AS found');
    expect(queries[1]?.cypher).toBe('MATCH (n:`Gadget` {`gadgetId`: $id}) OPTIONAL MATCH (n)<-[:`HAS`]-(m:`Widget`) RETURN count(DISTINCT n) AS nodes, count(DISTINCT m) AS found, count(DISTINCT CASE WHEN m.`widgetId` IN $ids THEN m END) AS listed');
    for (const query of queries) expect(query.cypher).not.toMatch(/W0001|G000/);
  });
});

describe('checking a property and a missing node', () => {
  const propertyCases = parseCases(
    `
preset:
  entity: { type: gadget, id: G000 }
  case_ref: "REF-DEMO-2"
cases:
  - id: common-gadget
    title: A gadget on the stop list
    expect:
      - { node: { type: gadget, id: G000 }, property: isCommon, equals: true }
      - { node: { type: gadget, id: G000 }, via: HAS, direction: in, count: 0 }
`,
    miniMapping,
    miniDefinition,
  );

  function answering(property: readonly Record<string, unknown>[], neighbors: readonly Record<string, unknown>[]): Run {
    return async (cypher) => (cypher.includes('OPTIONAL MATCH') ? neighbors : property);
  }

  const ZERO_NEIGHBORS = [{ nodes: 1, found: 0 }];

  it('fails a property that differs, naming the case and the expectation', async () => {
    const failures = await checkCases(propertyCases, miniMapping, answering([{ nodes: 1, present: 1, equal: 0 }], ZERO_NEIGHBORS));
    expect(failures).toEqual(['case common-gadget, expectation 1: the property does not equal the written value']);
  });

  it('fails a property the node does not have', async () => {
    const failures = await checkCases(propertyCases, miniMapping, answering([{ nodes: 1, present: 0, equal: 0 }], ZERO_NEIGHBORS));
    expect(failures).toEqual(['case common-gadget, expectation 1: the node has no such property']);
  });

  it('fails a node that is not in the graph rather than passing on zero', async () => {
    const failures = await checkCases(propertyCases, miniMapping, answering([{ nodes: 0, present: 0, equal: 0 }], [{ nodes: 0, found: 0 }]));
    expect(failures).toEqual(['case common-gadget, expectation 1: the node is not in the graph', 'case common-gadget, expectation 2: the node is not in the graph']);
  });

  it('passes a property that equals and a count of zero on a node that exists', async () => {
    expect(await checkCases(propertyCases, miniMapping, answering([{ nodes: 1, present: 1, equal: 1 }], ZERO_NEIGHBORS))).toEqual([]);
  });

  it('passes the written value as a parameter and counts, never fetching the value', async () => {
    const seen: { cypher: string; parameters: Record<string, unknown> }[] = [];
    await checkCases(propertyCases, miniMapping, async (cypher, parameters) => {
      seen.push({ cypher, parameters });
      return cypher.includes('OPTIONAL MATCH') ? ZERO_NEIGHBORS : [{ nodes: 1, present: 1, equal: 1 }];
    });
    expect(seen[0]).toEqual({ cypher: 'MATCH (n:`Gadget` {`gadgetId`: $id}) RETURN count(n) AS nodes, count(n.`isCommon`) AS present, count(CASE WHEN n.`isCommon` = $equals THEN 1 END) AS equal', parameters: { id: 'G000', equals: true } });
  });
});

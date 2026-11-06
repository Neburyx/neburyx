import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import { searchPrefixTemplate } from '../gate/templates/search-prefix.js';
import type { Gate, IndexReader } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSearchService } from './search-service.js';

const COMMON_MATCHES = 3000;
const ENTITIES = [
  { type: 'held_by_constraint', label: 'HeldByConstraint', stable_id: 'itemId', search: ['itemId'] },
  { type: 'held_by_index', label: 'HeldByIndex', stable_id: 'itemId', search: ['itemId'] },
  { type: 'held_by_text', label: 'HeldByText', stable_id: 'textId', search: ['code'] },
  { type: 'bulk', label: 'Bulk', stable_id: 'bulkId', search: ['code', 'alt'], pii: [{ property: 'alt', class: 'text' }] },
  { type: 'common', label: 'Common', stable_id: 'commonId', search: ['code', 'alt'] },
  { type: 'slow', label: 'Slow', stable_id: 'slowId', search: ['code'] },
];

let server: RunningNeo4j;
let source: SourceModel;
let limited: SourceModel;
let gate: Gate;
let indexes: IndexReader;
let limitedGate: Gate;
let limitedIndexes: IndexReader;
let closing: () => Promise<void>;
const events: AuditEvent[] = [];
const statements: string[] = [];

const sourceWith = (id: string, budgets: Record<string, number> = {}): SourceModel => sourceFor(server, { id, entities: ENTITIES, relationships: [], ...(Object.keys(budgets).length === 0 ? {} : { budgets }) });

function assembleOver(model: SourceModel): { readonly gate: Gate; readonly indexes: IndexReader; readonly executor: Neo4jExecutor } {
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => Promise.resolve(void events.push(event)) } };
  const executor = createNeo4jExecutor({ sources: [model], env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push(call.cypher), executor.execute(call)) };
  const assembled = assembleGate({ usability: ALWAYS_USABLE, mapping: { sources: [model] }, seams, executor: recording, logger: { warn: () => undefined } });
  return { gate: assembled.gate, indexes: assembled.indexes, executor };
}

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT held_unique FOR (n:HeldByConstraint) REQUIRE n.itemId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX held_plain FOR (n:HeldByIndex) ON (n.itemId)');
  await runAdmin(server, 'CREATE TEXT INDEX held_text FOR (n:HeldByText) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX bulk_code FOR (n:Bulk) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX bulk_alt FOR (n:Bulk) ON (n.alt)');
  await runAdmin(server, 'CREATE INDEX common_code FOR (n:Common) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX common_alt FOR (n:Common) ON (n.alt)');
  await runAdmin(server, "CREATE (:HeldByConstraint {itemId: 123456}), (:HeldByConstraint {itemId: '123456X'}), (:HeldByIndex {itemId: 123456}), (:HeldByIndex {itemId: '123456X'}), (:HeldByText {textId: 't-int', code: 123456}), (:HeldByText {textId: 't-str', code: '123456X'}), (:HeldByText {textId: 't-eq', code: '123456'})");
  for (const [prefix, size] of [['pre24', 24], ['pre25', 25], ['pre26', 26], ['ten', 10], ['eleven', 11]] as const) {
    await runAdmin(server, `UNWIND range(1, ${size}) AS i CREATE (:Bulk {bulkId: 'B-${prefix}-' + i, code: '${prefix}-' + i})`);
  }
  await runAdmin(server, "CREATE (:Bulk {bulkId: 'B-X', code: 'xx', alt: 'xx-owner'}), (:Bulk {bulkId: 'B-XL', code: 'xx-long'}), (:Bulk {bulkId: 'B-P1', code: 'zz-1', alt: 'secret-ab'}), (:Bulk {bulkId: 'B-P2', code: 'secret-cd'})");
  await runAdmin(server, `UNWIND range(1, ${COMMON_MATCHES}) AS i CREATE (:Common {commonId: 'C-' + i, code: 'common-text-' + i, alt: 'common-text-' + i})`);
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  source = sourceWith('graph');
  limited = sourceWith('graph10', { max_page: 10, default_page: 10 });
  const full = assembleOver(source);
  const small = assembleOver(limited);
  ({ gate, indexes } = full);
  ({ gate: limitedGate, indexes: limitedIndexes } = small);
  closing = async () => {
    await runAll([() => full.executor.close(), () => small.executor.close()]);
  };
}, 600_000);

afterAll(async () => {
  await runAll([() => closing?.(), () => server?.stop()]);
});

const service = (over: SourceModel = source) =>
  createSearchService({ gate: over === source ? gate : limitedGate, indexes: over === source ? indexes : limitedIndexes, mapping: { sources: [over] }, access: communityAccess({ sources: [over] }) });
const typeahead = (text: string, options: { readonly mask?: boolean; readonly over?: SourceModel } = {}) =>
  service(options.over).search({ traceId: 'tr-typeahead', principal: LOCAL_PRINCIPAL, sourceId: (options.over ?? source).id, text, mask: options.mask === true, typeahead: true });
const prefixIds = async (text: string, entityType?: string): Promise<string[]> =>
  ((await typeahead(text)).startsWith?.nodes ?? []).filter((node) => entityType === undefined || node.ref.entityType === entityType).map((node) => node.ref.stableId);
const namingLabel = (label: string, from = 0): number => statements.slice(from).filter((statement) => statement.includes(`\`${label}\``)).length;

interface Operator {
  readonly name: string;
  readonly rows: number;
  readonly dbHits: number;
}

function flatten(node: unknown): Operator[] {
  if (typeof node !== 'object' || node === null || !('operatorType' in node) || !('children' in node) || !Array.isArray(node.children)) return [];
  const own = { name: String(node.operatorType).replace(/@.*$/, ''), rows: 'rows' in node ? Number(node.rows) : 0, dbHits: 'dbHits' in node ? Number(node.dbHits) : 0 };
  return [own, ...node.children.flatMap(flatten)];
}

async function planOf(text: string, targets: readonly object[]): Promise<{ readonly operators: readonly Operator[]; readonly rows: number }> {
  const template = createTemplateCatalog({ templates: [searchPrefixTemplate] }).find('entity-search-prefix');
  if (template === undefined) throw new Error('no template');
  const rendered = renderTemplate(template, template.paramsSchema.parse({ text, targets }), allowlistFromMapping(source), 25);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters(rendered.parameters, []));
    return { operators: flatten(result.summary.profile), rows: result.records.length };
  } finally {
    await session.close();
  }
}

const SEEKS = /IndexSeek/;
const SCANS = /NodeByLabelScan|AllNodesScan|NodeIndexScan|IndexContainsScan|IndexEndsWithScan/;

describe(`the prefix read of a type-ahead search, planned on ${NEO4J_SERIES}`, () => {
  const targets = [
    { entityType: 'held_by_constraint', property: 'itemId', match: 'value' },
    { entityType: 'held_by_index', property: 'itemId', match: 'value' },
    { entityType: 'held_by_text', property: 'code', match: 'value' },
    { entityType: 'bulk', property: 'code', match: 'value' },
    { entityType: 'bulk', property: 'alt', match: 'value' },
  ];

  it.each(['1234', 'pre2', 'xx', 'a text that matches nothing'])('seeks the index of every branch, under a constraint, a plain RANGE index and a TEXT-only index, for %s, with no scan', async (text) => {
    const { operators } = await planOf(text, targets);
    const names = operators.map((operator) => operator.name).join(' > ');
    expect(operators.filter((operator) => SEEKS.test(operator.name)), names).toHaveLength(targets.length);
    expect(operators.some((operator) => SCANS.test(operator.name)), names).toBe(false);
  });

  it('reads no more than the limit plus one in any branch and in all, when thousands of entities share the prefix, by the rows of the operators and with the database hits shown beside them', async () => {
    const { operators, rows } = await planOf('common-text', [
      { entityType: 'common', property: 'code', match: 'value' },
      { entityType: 'common', property: 'alt', match: 'value' },
    ]);
    const names = operators.map((operator) => `${operator.name}(rows ${operator.rows}, hits ${operator.dbHits})`).join(' > ');
    expect(rows, names).toBe(26);
    expect(operators.filter((operator) => operator.name === 'Limit').every((operator) => operator.rows <= 26), names).toBe(true);
    expect(operators.filter((operator) => SEEKS.test(operator.name)).every((operator) => operator.rows <= 27), names).toBe(true);
    expect(operators.reduce((sum, operator) => sum + operator.dbHits, 0), names).toBeLessThan(COMMON_MATCHES / 3);
  });
});

describe(`the cap and the count of the startsWith group on ${NEO4J_SERIES}`, () => {
  it.each([
    ['pre24', 24, 'exact'],
    ['pre25', 25, 'exact'],
    ['pre26', 25, 'lowerBound'],
  ])('shows the matches of %s as %i hits and an %s count', async (prefix, shown, quality) => {
    const result = await typeahead(`${prefix}-`);
    expect(result.startsWith?.nodes).toHaveLength(shown);
    expect(result.startsWith?.count).toMatchObject({ value: shown, quality });
    expect(result.cap).toBe(25);
  });

  it.each([
    ['ten', 10, 'exact'],
    ['eleven', 10, 'lowerBound'],
  ])('shows the matches of %s as %i hits and an %s count for a source whose max_page is 10', async (prefix, shown, quality) => {
    const result = await typeahead(`${prefix}-`, { over: limited });
    expect(result.startsWith?.nodes).toHaveLength(shown);
    expect(result.startsWith?.count).toMatchObject({ value: shown, quality });
    expect(result.cap).toBe(10);
  });

  it('shows a prefix that thousands of entities carry as 25 and a lower bound of 25', async () => {
    const result = await typeahead('common-text');
    expect(result.startsWith?.nodes).toHaveLength(25);
    expect(result.startsWith?.count).toMatchObject({ value: 25, quality: 'lowerBound' });
  });

  it('puts an entity whose value is the whole text in the exact group only, and shows an entity that matches the prefix through another property once', async () => {
    const result = await typeahead('xx');
    expect(result.exact.map((node) => node.ref.stableId)).toEqual(['B-X']);
    expect((result.startsWith?.nodes ?? []).map((node) => node.ref.stableId)).toEqual(['B-XL']);
  });
});

describe(`integers and the prefix read on ${NEO4J_SERIES}`, () => {
  it('never finds a stored integer by a prefix of its digits, under a constraint, a plain RANGE index and a TEXT-only index, and finds the strings that start with them (the TEXT-indexed property holds a string \'123456\' too)', async () => {
    const result = await typeahead('1234');
    expect((result.startsWith?.nodes ?? []).map((node) => `${node.ref.entityType}:${node.ref.stableId}`).sort()).toEqual(['held_by_constraint:123456X', 'held_by_index:123456X', 'held_by_text:t-eq', 'held_by_text:t-str']);
  });

  it('finds the whole integer by the exact group under a constraint and under a RANGE index, and not under a TEXT-only index, and finds the text of a TEXT-indexed property', async () => {
    const result = await typeahead('123456');
    const found = result.exact.map((node) => `${node.ref.entityType}:${node.ref.stableId}`).sort();
    expect(found).toEqual(['held_by_constraint:123456', 'held_by_index:123456', 'held_by_text:t-eq']);
    expect((result.startsWith?.nodes ?? []).map((node) => `${node.ref.entityType}:${node.ref.stableId}`).sort()).toEqual(['held_by_constraint:123456X', 'held_by_index:123456X', 'held_by_text:t-str']);
  });
});

describe(`masking in a type-ahead search on ${NEO4J_SERIES}`, () => {
  it('leaves a personal-data property out while masked, so an entity is found only through an eligible property, and never shows the value of the property that was left out', async () => {
    const masked = await typeahead('secret-', { mask: true });
    expect((masked.startsWith?.nodes ?? []).map((node) => node.ref.stableId)).toEqual(['B-P2']);
    expect(JSON.stringify(masked)).not.toContain('secret-ab');
    const plain = await typeahead('secret-');
    expect((plain.startsWith?.nodes ?? []).map((node) => node.ref.stableId).sort()).toEqual(['B-P1', 'B-P2']);
  });
});

describe(`an index that is gone since the check, in a type-ahead search on ${NEO4J_SERIES}`, () => {
  it('is left out of both groups with its message, and no statement of the request names the label, so no label scan can have run', async () => {
    expect(await prefixIds('pre24-', 'bulk')).toHaveLength(24);
    await runAdmin(server, 'DROP INDEX bulk_code');
    const from = statements.length;
    const result = await typeahead('pre24-');
    expect(result.disabledTypes.map((disabled) => disabled.entityType)).toContain('bulk');
    expect(result.startsWith?.nodes.filter((node) => node.ref.entityType === 'bulk')).toEqual([]);
    expect(namingLabel('Bulk', from)).toBe(0);
    await runAdmin(server, 'CREATE INDEX bulk_code FOR (n:Bulk) ON (n.code)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    expect(await prefixIds('pre24-', 'bulk')).toHaveLength(24);
  });

  it('is left out of both groups while it is being built, and searched again when it is online', async () => {
    await runAdmin(server, 'UNWIND range(1, 200000) AS i CREATE (:Slow {slowId: toString(i), code: toString(i)})');
    await runAdmin(server, 'CREATE INDEX slow_code FOR (n:Slow) ON (n.code)');
    const from = statements.length;
    const during = await typeahead('77');
    const stillBuilding = during.disabledTypes.some((disabled) => disabled.entityType === 'slow');
    if (stillBuilding) expect(namingLabel('Slow', from)).toBe(0);
    expect(stillBuilding, 'the index of 200,000 nodes was online before the search ran').toBe(true);
    await runAdmin(server, 'CALL db.awaitIndexes(300)');
    expect((await prefixIds('77', 'slow')).length).toBeGreaterThan(0);
  }, 300_000);
});

describe(`a login that may not list indexes, in a type-ahead search on ${NEO4J_SERIES}`, () => {
  it('disables no type and searches unguarded, the one case the guard cannot protect', async () => {
    const session = server.admin.session({ database: 'system' });
    try {
      const roles = await session.run('SHOW USERS YIELD user, roles WHERE user = $user RETURN roles', { user: server.reader.user });
      const held: unknown = roles.records[0]?.get('roles');
      const owned = Array.isArray(held) ? held.find((role): role is string => typeof role === 'string' && role.startsWith('nbx_test_')) : undefined;
      if (owned === undefined) throw new Error('the login of this run has no role of this run');
      await session.run(`REVOKE GRANT SHOW INDEX ON DATABASE \`${server.database}\` FROM \`${owned}\``);
      await session.run(`REVOKE GRANT SHOW CONSTRAINT ON DATABASE \`${server.database}\` FROM \`${owned}\``);
    } finally {
      await session.close();
    }
    const result = await typeahead('pre24-');
    expect(result.disabledTypes).toEqual([]);
    expect(result.startsWith?.nodes).toHaveLength(24);
  });
});

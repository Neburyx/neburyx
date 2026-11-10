import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAPPING_CHECK_SEVERITY, UNVERIFIED_CHECKS, type MappingChecks, type MappingFinding, type SourceTestReport } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import type { IndexEntry } from '../gate/templates/schema-indexes.js';
import type { SourceGateOptions } from '../gate/source-gate.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { fakeProbeDriver } from '../testing/fake-probe-driver.js';
import { fakeDrivers, neo4jError, type FakeBehaviour } from '../testing/fake-source-driver.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { guideTable, guideText, unticked } from '../testing/guide.js';
import { baseSource, fileOf, firstSource, load } from '../testing/mapping.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { reportLines, runTestSourceCommand, type TestSourceIo } from './command.js';
import { judgeIndexes, judgeScan, judgeTokens, refusedFinding, unreadableFinding, type SchemaReads } from './mapping-checks.js';
import { FAILURE_SENTENCES, LOGIN_CAN_WRITE_REASON, PRIVILEGES_UNREADABLE_REASON, UNSUPPORTED_VERSION_REASON } from './reasons.js';
import { reportFromServer } from './report.js';

const folder = mkdtempSync(join(tmpdir(), 'mapping-guide-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const AT = '2026-11-02T10:00:00.000Z';
const SERVER = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const AUTH = { kind: 'basic', username_env: 'GUIDE_USER', password_env: 'GUIDE_PASSWORD' };
const ENV = { GUIDE_USER: 'user', GUIDE_PASSWORD: 'password' };
const DATABASE_URL = 'postgres://app_user:password@db.example.test:5432/neburyx';

let counter = 0;
function mappingFile(entities?: readonly Record<string, unknown>[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, fileOf(sourceWith('alpha', { uri: 'neo4j+s://graph.example.test:7687', auth: AUTH, ...(entities === undefined ? {} : { entities, relationships: [] }) })));
  return file;
}

async function run(args: readonly string[], behaviour: FakeBehaviour = { rows: [SERVER_ROW] }, overrides: Partial<TestSourceIo> = {}, entities?: readonly Record<string, unknown>[]) {
  let out = '';
  let err = '';
  const fake = fakeDrivers(behaviour);
  const store = memoryAppStore();
  const code = await runTestSourceCommand(args, { DATABASE_URL, NEBURYX_CONFIG: mappingFile(entities), ...ENV }, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    clock: () => Date.UTC(2026, 10, 2, 10, 0, 0),
    openStore: () => store,
    openSourceGate: (options: SourceGateOptions) => {
      const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: options.env, logger: options.logger, createDriver: fake.factory });
      const defaults = communitySeams();
      const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
      return { ...parts, close: () => executor.close() };
    },
    ...overrides,
  });
  return { code, out, err };
}

const labelsOf = (text: string): string[] => text.split('\n').flatMap((line) => (/^[A-Z][A-Za-z -]*:/.test(line) ? [line.slice(0, line.indexOf(':'))] : []));

describe('the exit codes the guide gives', () => {
  it('say 0 for pass and warn, 1 for fail and for any error, 2 for a usage error or an unknown source', async () => {
    expect(guideText()).toContain('It exits `0` for pass and warn; `1` for fail and for any configuration, mapping, database or run error; and `2` for a usage error or a source name that is not configured.');
    expect((await run(['--name', 'alpha'])).code).toBe(0);
    expect((await run(['--name', 'alpha'], { beginError: neo4jError('ServiceUnavailable') })).code).toBe(1);
    expect((await run([])).code).toBe(2);
    expect((await run(['--name', 'nobody'])).code).toBe(2);
  });
});

describe('the report lines in the guide', () => {
  it('are the labels the printer writes, in its order', async () => {
    const keyed = [{ type: 'person', label: 'Person', stable_id: 'phone', pii: [{ property: 'phone', class: 'phone' }] }];
    const probed = await run(['--name', 'alpha', '--write-probe'], { rows: [SERVER_ROW], privileges: [] }, { openProbeDriver: fakeProbeDriver({}).factory }, keyed);
    const printed = labelsOf(probed.out);
    const source = firstSource(load(baseSource()));
    const withReason = reportFromServer(source, SERVER, true, AT, {});
    const lines = labelsOf(reportLines(withReason));
    expect(lines.indexOf('Reason')).toBe(lines.indexOf('State') + 1);
    const expected = [...printed];
    if (!expected.includes('Reason')) expected.splice(expected.indexOf('State') + 1, 0, 'Reason');
    expect(guideTable('report-lines').map((row) => unticked(row[0] ?? ''))).toEqual(expected);
    expect(printed).toContain('Keyed references');
    expect(printed.at(-1)).toBe('Write probe');
  });
});

describe('the read-only words in the guide', () => {
  const source = firstSource(load(baseSource()));
  const base: SourceTestReport = reportFromServer(source, SERVER, null, AT, {});

  it('are the words the printer writes for each outcome, and a Community server prints not verified', () => {
    expect(reportLines(base)).toContain('Read-only: not verified\nLogin can write: unknown\n');
    expect(reportLines(reportFromServer(source, SERVER, false, AT, {}))).toContain('Read-only: privileges inspected\nLogin can write: no\n');
    expect(reportLines(reportFromServer(source, SERVER, false, AT, { probed: true }))).toContain('Read-only: write probe\n');
    const text = guideText();
    for (const words of ['Privileges inspected', 'Write probe', 'Not verified', '`Read-only: not verified`', '`Login can write: unknown`']) expect(text).toContain(words);
  });
});

describe('the reasons in the guide', () => {
  it('are the sentences of the product, in its order', () => {
    const sentences = [...Object.values(FAILURE_SENTENCES), UNSUPPORTED_VERSION_REASON, PRIVILEGES_UNREADABLE_REASON, LOGIN_CAN_WRITE_REASON];
    expect(guideTable('reasons').map((row) => row[0])).toEqual(sentences);
  });

  it('give the three forms of a mapping reason', () => {
    const source = firstSource(load(baseSource()));
    const fail = (message: string): MappingFinding => ({ severity: 'fail', check: 'label', message });
    const checks = (mapping: MappingChecks) => reportFromServer(source, SERVER, false, AT, { mapping }).stateReason ?? '';
    const template = (reason: string): string => reason.replace('first', '<message>').replace('(and 1 more)', '(and <n> more)');
    const forms = guideTable('reasons: mapping').map((row) => unticked(row[0] ?? ''));
    expect(forms).toEqual([
      template(checks({ status: 'fail', findings: [fail('first'), fail('second')] })),
      template(checks({ status: 'not-verified', findings: [{ severity: 'warn', check: 'schema-refused', message: 'first' }] })),
      template(checks({ status: 'warn', findings: [{ severity: 'warn', check: 'sort-index', message: 'first' }] })),
    ]);
  });
});

describe('the checks in the guide', () => {
  it('list every check with the severity the contract gives it', () => {
    const rows = guideTable('checks');
    expect(Object.fromEntries(rows.map((row) => [unticked(row[0] ?? ''), row[1]]))).toEqual(MAPPING_CHECK_SEVERITY);
    expect(rows).toHaveLength(Object.keys(MAPPING_CHECK_SEVERITY).length);
  });

  it('name the checks that mean not verified', () => {
    expect([...UNVERIFIED_CHECKS].sort()).toEqual(['schema-refused', 'schema-unreadable', 'stable-id-unverified']);
    for (const check of UNVERIFIED_CHECKS) expect(guideText()).toContain(`\`${check}\``);
    expect(guideText()).toContain('the result is **not verified**');
  });
});

describe('the messages in the guide', () => {
  const source = firstSource(
    load(
      baseSource({
        entities: [
          { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'title'], reference: ['extRef'] },
          { type: 'person', label: 'Person', stable_id: 'personId' },
        ],
        relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }],
      }),
    ),
  );
  const node = (name: string, property: string, overrides: Partial<IndexEntry> = {}): IndexEntry => ({ type: 'RANGE', entityType: 'NODE', name, property, single: true, state: 'ONLINE', constrained: false, ...overrides });
  const edge = (name: string, property: string, overrides: Partial<IndexEntry> = {}): IndexEntry => ({ ...node(name, property), entityType: 'RELATIONSHIP', ...overrides });
  const FITTING: readonly IndexEntry[] = [
    node('Gadget', 'gadgetId', { constrained: true }),
    node('Gadget', 'title'),
    node('Gadget', 'extRef'),
    node('Person', 'personId', { constrained: true }),
    edge('MADE_BY', 'linkId', { constrained: true }),
    edge('MADE_BY', 'madeAt'),
    edge('MADE_BY', 'recordId'),
  ];
  const reads = (indexes: readonly IndexEntry[], labels: readonly string[] = ['Gadget', 'Person'], types: readonly string[] = ['MADE_BY']): SchemaReads => ({ labels: new Set(labels), types: new Set(types), indexes });
  const without = (drop: (entry: IndexEntry) => boolean, extra: readonly IndexEntry[] = []): IndexEntry[] => [...FITTING.filter((entry) => !drop(entry)), ...extra];
  const gadget = source.entities[0];

  const byCheck = (found: readonly MappingFinding[], check: string): MappingFinding => {
    const one = found.find((entry) => entry.check === check);
    if (one === undefined) throw new Error(`no ${check} finding`);
    return one;
  };

  const templateOf = (finding: MappingFinding): string => {
    let text = finding.message;
    const quote = (value: string | undefined, name: string): void => {
      if (value !== undefined) text = text.replace(`"${value}"`, `"<${name}>"`);
    };
    if (finding.relationshipType !== undefined) {
      quote(finding.relationshipType, 'relationship type');
      text = text.replace(`from "${finding.from ?? ''}"`, 'from "<from>"').replace(`to "${finding.to ?? ''}"`, 'to "<to>"');
    } else {
      quote(finding.entityType, 'entity type');
      text = text.replace('(label "Gadget")', '(label "<label>")');
    }
    quote(finding.property, 'property');
    return text;
  };

  const kindOf = (text: string): string => text.replace(/the index on the (stable id|search|reference|evidence|sort) property/, 'the index on the <kind> property');

  const produced = (): string[] => {
    if (gadget === undefined) throw new Error('no entity');
    const some = (found: readonly MappingFinding[], check: string): MappingFinding[] => found.filter((entry) => entry.check === check);
    const missing = (property: string, extra: readonly IndexEntry[] = []): readonly MappingFinding[] => judgeIndexes(source, reads(without((entry) => entry.property === property, extra)));
    const unindexed = judgeIndexes(source, reads(without((entry) => entry.name === 'Gadget' && entry.property === 'gadgetId')));
    const building = [...missing('title', [node('Gadget', 'title', { state: 'POPULATING' })]), ...missing('recordId', [edge('MADE_BY', 'recordId', { state: 'POPULATING' })]), ...judgeIndexes(source, reads(without((entry) => entry.name === 'Gadget' && entry.property === 'gadgetId', [node('Gadget', 'gadgetId', { state: 'POPULATING' })])))];
    const failed = [...missing('title', [node('Gadget', 'title', { state: 'FAILED' })]), ...missing('madeAt', [edge('MADE_BY', 'madeAt', { state: 'FAILED' })])];
    const relUnindexed = judgeIndexes(source, reads(without((entry) => entry.name === 'MADE_BY' && entry.property === 'linkId')));
    const relUnconstrained = judgeIndexes(source, reads(without((entry) => entry.name === 'MADE_BY' && entry.property === 'linkId', [edge('MADE_BY', 'linkId')])));
    const tokens = judgeTokens(source, reads([], ['Person'], []));
    const found: MappingFinding[] = [
      ...some(tokens, 'label'),
      ...some(tokens, 'relationship-type'),
      ...some(missing('title'), 'search-index'),
      ...some(missing('extRef'), 'reference-index'),
      ...some(missing('recordId'), 'evidence-index'),
      ...some(missing('madeAt'), 'sort-index'),
      ...some(building, 'index-building'),
      ...some(failed, 'index-failed'),
      ...some(unindexed, 'stable-id-unindexed'),
      ...judgeScan(gadget, { duplicated: 3 }),
      ...judgeScan(gadget, { duplicated: 1 }),
      ...judgeScan(gadget, { duplicated: 0 }),
      ...judgeScan(gadget, 'unverified'),
      ...some(relUnindexed, 'rel-stable-id-unindexed'),
      ...some(relUnconstrained, 'rel-stable-id-unconstrained'),
    ];
    const rows = found.map((finding) => `${finding.check}|${kindOf(templateOf(finding)).replace(/: \d+ values occur/, ': <n> values occur')}`);
    const refused = (['indexes', 'tokens', 'scan'] as const).map((read) => `schema-refused|${refusedFinding(read).message}`);
    const unreadable = (['tokens', 'indexes', 'scan'] as const).map((read) => `schema-unreadable|${unreadableFinding(read).message.replace(/its (labels and relationship types|indexes|stable ids) could/, 'its <labels and relationship types, indexes or stable ids> could')}`);
    return [...new Set([...rows, ...refused, ...unreadable])].sort();
  };

  it('are the messages the product produces, in every variant, for every check', () => {
    const rows = guideTable('messages').map((row) => `${unticked(row[0] ?? '')}|${unticked(row[1] ?? '')}`).sort();
    expect(rows).toEqual(produced());
    expect(new Set(rows.map((row) => row.split('|')[0]))).toEqual(new Set(Object.keys(MAPPING_CHECK_SEVERITY)));
    expect(guideText()).toContain('`<kind>` is `search`, `reference` or `stable id` for an entity type, and `evidence` or `sort` for a relationship type');
  });

  it('are the three forms of the schema-unreadable message', () => {
    for (const read of ['tokens', 'indexes', 'scan'] as const) expect(unreadableFinding(read).message).toMatch(/^The answer of the source about its (labels and relationship types|indexes|stable ids) could not be read/);
  });
});

describe('the failing finding the worked example quotes', () => {
  it('is what the product prints for a label the graph does not have', () => {
    const quoted = /^ {2}fail: (Entity type "(.+)" \(label "(.+)"\): no node carries the label)$/m.exec(guideText());
    expect(quoted).not.toBeNull();
    const [, message = '', type = '', label = ''] = quoted ?? [];
    const source = firstSource(load(baseSource({ entities: [{ type, label, stable_id: 'id' }], relationships: [] })));
    expect(judgeTokens(source, { labels: new Set(), types: new Set() }).map((found) => found.message)).toEqual([message]);
  });
});

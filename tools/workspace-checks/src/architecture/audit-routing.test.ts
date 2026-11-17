import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { AUDIT_INVENTORY_PATH, AUDIT_ROUTING_SCAN_ROOTS, checkAuditRouting, readInventory } from './audit-routing.js';
import { loadTree } from './tree.js';
import { formatViolations } from './violations.js';

const INVENTORY = [
  '| Event | Result | Path | Written in | Why |',
  '|---|---|---|---|---|',
  '| `graph.expand` | any | queued | `services/api/src/gate/templates/a.ts` | a read |',
  '| `export.create` | success | privileged | `services/api/src/exports/export-service.ts` | privileged |',
].join('\n');

const WRITER = "export const a = { auditAction: 'graph.expand' };";
const EXPORT_WRITER = "const EXPORT_CREATE_AUDIT_ACTION = 'export.create';\nawait deps.audit.record(event, { transaction });";
const base = [
  { path: 'services/api/src/gate/templates/a.ts', text: WRITER },
  { path: 'services/api/src/exports/export-service.ts', text: EXPORT_WRITER },
];
const check = (extra: { path: string; text: string }[] = [], inventory = INVENTORY) => checkAuditRouting([...base, ...extra], inventory);

describe('the audit inventory', () => {
  it('is read as rows of an action, a path and the files that write it', () => {
    expect(readInventory(INVENTORY)).toEqual([
      { action: 'graph.expand', result: 'any', path: 'queued', files: ['services/api/src/gate/templates/a.ts'] },
      { action: 'export.create', result: 'success', path: 'privileged', files: ['services/api/src/exports/export-service.ts'] },
    ]);
  });

  it('is complete for a tree that matches it', () => {
    expect(check()).toEqual([]);
  });
});

describe('where an audit sink or a queue may be built', () => {
  it.each(['createAuditSink', 'createStdoutSink', 'createAuditQueue', 'createEventQueue'])('reports %s built in a route', (name) => {
    expect(check([{ path: 'services/api/src/graph/route.ts', text: `const sink = ${name}(options);` }])).toMatchObject([{ rule: 'audit-routing', file: 'services/api/src/graph/route.ts', line: 1, specifier: name }]);
  });

  it('does not report the audit module, the start-up module, the extension factory or the sink package, nor a test or the test support folder', () => {
    for (const path of ['services/api/src/audit/wiring.ts', 'services/api/src/start.ts', 'ee/ask/src/index.ts', 'ee/audit/src/sink.ts', 'services/api/src/graph/a.test.ts', 'services/api/src/testing/queued.ts']) {
      expect(check([{ path, text: 'const sink = createAuditQueue(options);' }]), path).toEqual([]);
    }
  });
});

describe('a use of the sink the store mounted', () => {
  it.each(['await mounted.sink.record(event);', 'await mountedAudit?.sink.record(event);', 'const alias = mountedAudit.sink;\nawait alias.record(event);', 'hand(mounted.sink);'])('is reported, called or only named: %s', (text) => {
    expect(check([{ path: 'services/api/src/graph/route.ts', text }])).toMatchObject([{ rule: 'audit-routing', specifier: 'mounted.sink' }]);
  });

  it('does not report the wiring, the start-up module or the extension factory, nor a queue handle or an audit handle the application supplies', () => {
    for (const path of ['services/api/src/audit/wiring.ts', 'services/api/src/start.ts', 'ee/ask/src/index.ts']) expect(check([{ path, text: 'const sink = mounted.sink;' }]), path).toEqual([]);
    expect(check([{ path: 'services/api/src/audit/queue.ts', text: 'await entry.sink.record(event);' }])).toEqual([]);
    expect(check([{ path: 'services/api/src/start.ts', text: 'void records.sink.record(job);' }])).toEqual([]);
    expect(check([{ path: 'services/api/src/graph/route.ts', text: 'await deps.audit.record(event); await request.audit.record(event);' }])).toEqual([]);
  });
});

describe('an event that is in the code and not in the inventory', () => {
  it.each([
    ["const x = { action: 'entity.load' };", 'entity.load'],
    ["const FOO_AUDIT_ACTION = 'edge.load';", 'edge.load'],
    ["  auditAction: 'source.test',", 'source.test'],
  ])('is reported: %s', (text, action) => {
    expect(check([{ path: 'services/api/src/graph/b.ts', text }])).toMatchObject([{ rule: 'audit-routing', file: 'services/api/src/graph/b.ts', specifier: action }]);
  });

  it('is reported when a listed event is written in a file the row does not name', () => {
    expect(check([{ path: 'services/api/src/graph/b.ts', text: "const x = { action: 'graph.expand' };" }])).toMatchObject([{ file: 'services/api/src/graph/b.ts', specifier: 'graph.expand' }]);
  });

  it('is found in the two files that name their actions otherwise', () => {
    expect(check([{ path: 'services/api/src/patterns/pattern-events.ts', text: "export const MAP = { saved: 'pattern.save' };" }])).toMatchObject([{ specifier: 'pattern.save' }]);
    expect(check([{ path: 'services/api/src/investigations/status-change.ts', text: "return 'investigation.close';" }])).toMatchObject([{ specifier: 'investigation.close' }]);
  });

  it('is not found in a test file, a string that is not an event name, or a word with no dot', () => {
    expect(check([{ path: 'services/api/src/graph/b.test.ts', text: "const x = { action: 'entity.load' };" }])).toEqual([]);
    expect(check([{ path: 'services/api/src/graph/b.ts', text: "const x = { action: 'saved' }; const y = { action: 'Not.An.Event' };" }])).toEqual([]);
  });
});

describe('a row of the inventory that has no writer', () => {
  it('is reported when its event is no longer written in the file it names', () => {
    expect(check([], `${INVENTORY}\n| \`gone.event\` | any | queued | \`services/api/src/graph/gone.ts\` | removed |`)).toMatchObject([{ file: AUDIT_INVENTORY_PATH, specifier: 'gone.event' }]);
  });

  it.each(['await deps.audit.record(event);', '// the transaction of the change\nawait deps.audit.record(event, transaction);', 'const transaction = 1;\nawait deps.audit.record(event);'])('is reported for a privileged event whose writer does not pass the transaction on as an option, even when the word is there: %s', (call) => {
    const files = [{ path: 'services/api/src/exports/export-service.ts', text: `const EXPORT_CREATE_AUDIT_ACTION = 'export.create';\n${call}` }];
    expect(checkAuditRouting([base[0] ?? { path: '', text: '' }, ...files], INVENTORY)).toMatchObject([{ file: 'services/api/src/exports/export-service.ts', specifier: 'export.create', reason: expect.stringContaining('transaction') }]);
  });

  it('accepts a privileged writer whose folder holds a file that hands the transaction on', () => {
    const files = [
      { path: 'services/api/src/investigations/status-change.ts', text: "return 'investigation.close';" },
      { path: 'services/api/src/investigations/investigation-service.ts', text: 'await deps.audit.record(event, { transaction });' },
    ];
    const inventory = `${INVENTORY}\n| \`investigation.close\` | success | privileged | \`services/api/src/investigations/status-change.ts\` | status |`;
    expect(checkAuditRouting([...base, ...files], inventory)).toEqual([]);
  });
});

describe('the call that records a privileged event', () => {
  const inventory = INVENTORY;
  const withCalls = (calls: string) => checkAuditRouting([base[0] ?? { path: '', text: '' }, { path: 'services/api/src/exports/export-service.ts', text: `const EXPORT_CREATE_AUDIT_ACTION = 'export.create';\n${calls}` }], inventory);

  it('is reported when it does not pass the transaction as its options, even beside an unrelated object that holds one', () => {
    expect(withCalls('const other = { transaction };\nawait deps.audit.record(event);')).toMatchObject([{ specifier: 'export.create', reason: expect.stringContaining('passes `{ transaction }`') }]);
    expect(withCalls('await seams.audit.record(event); await deps.audit.record(event, { transaction });')).toMatchObject([{ specifier: 'export.create' }]);
  });

  it('is accepted when every call on the audit handle passes it, when a call goes to the queued refusal member, and when it records a failed attempt', () => {
    expect(withCalls('await deps.audit.record(event, { transaction });\nawait deps.refusalAudit.record(refused);\nawait deps.audit.record({ ...event, result: \'failed\' });')).toEqual([]);
    expect(withCalls('await deps.audit.record(event, transaction === undefined ? undefined : { transaction });')).toEqual([]);
  });

  it('needs the queued member for a row about refusals, and reports a refusal row whose writer has no such call', () => {
    const refusal = `${INVENTORY}\n| \`export.create\` | refused | queued | \`services/api/src/exports/export-service.ts\` | a refusal |`;
    const files = [base[0] ?? { path: '', text: '' }, { path: 'services/api/src/exports/export-service.ts', text: EXPORT_WRITER }];
    expect(checkAuditRouting(files, refusal)).toMatchObject([{ specifier: 'export.create', reason: expect.stringContaining('refusalAudit') }]);
    expect(checkAuditRouting([files[0] ?? { path: '', text: '' }, { path: 'services/api/src/exports/export-service.ts', text: `${EXPORT_WRITER}\nawait deps.refusalAudit.record(refused);` }], refusal)).toEqual([]);
  });
});

describe('the repository', () => {
  it('writes every audit event on the path the inventory says, builds sinks and queues only where it may, and calls no sink', () => {
    const files = loadTree(repoRoot, { include: AUDIT_ROUTING_SCAN_ROOTS });
    expect(files.length).toBeGreaterThan(100);
    expect(formatViolations(checkAuditRouting(files, readFileSync(join(repoRoot, AUDIT_INVENTORY_PATH), 'utf8')))).toBe('');
  });
});

describe('the documentation of the check', () => {
  it('names the check, the files it scans and what it reports', () => {
    const text = readFileSync(join(repoRoot, 'docs/architecture-checks.md'), 'utf8');
    const section = text.slice(text.indexOf('## Audit routing'));
    expect(section).toContain('tools/workspace-checks/src/architecture/audit-routing.ts');
    for (const word of ['`services/`', '`createAuditSink`', '`mounted.sink`', '`docs/audit-events.md`', 'transaction']) expect(section).toContain(word);
    expect(text).toContain('A sixth, [audit routing](#audit-routing)');
  });
});

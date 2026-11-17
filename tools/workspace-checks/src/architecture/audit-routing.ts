import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const AUDIT_ROUTING_SCAN_ROOTS: readonly string[] = ['services', 'ee', 'packages'];
export const AUDIT_INVENTORY_PATH = 'docs/audit-events.md';

/** Where an audit sink or a queue may be built: the audit module, the start-up module that wires it, the extension's delegated factory and the sink's own package. */
const CONSTRUCTION_ALLOWED: ReadonlySet<string> = new Set([
  'services/api/src/audit/queue.ts',
  'services/api/src/audit/wiring.ts',
  'services/api/src/audit/stdout-sink.ts',
  'services/api/src/start.ts',
  'ee/ask/src/index.ts',
  'ee/audit/src/sink.ts',
  'ee/audit/src/index.ts',
]);


const CONSTRUCTION = /\b(createAuditSink|createStdoutSink|createAuditQueue|createEventQueue)\s*\(/g;
/** Any use of the sink the store mounted, called or only named (an alias would hide the call): the wiring hands it to the queue and to the privileged member, and nothing else holds it. */
const MOUNTED_SINK = /\bmounted\w*\??\.sink\b/g;

const DOTTED = String.raw`([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)`;
const ACTION_LITERALS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:action|auditAction)\s*:\s*'${DOTTED}'`, 'g'),
  new RegExp(String.raw`\b[A-Z][A-Z0-9_]*ACTION[A-Z0-9_]*\s*=\s*'${DOTTED}'`, 'g'),
];
/** Two files name their actions in a way the general patterns do not see: a table of the pattern events, and the function that says which event a close, an archive or a reopen is. */
const FILE_PATTERNS: Readonly<Record<string, RegExp>> = {
  'services/api/src/patterns/pattern-events.ts': new RegExp(String.raw`:\s*'(pattern\.[a-z]+)'`, 'g'),
  'services/api/src/investigations/status-change.ts': new RegExp(String.raw`'(investigation\.[a-z]+)'`, 'g'),
};

function isExempt(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || path.includes('/testing/') || path.endsWith('.d.ts');
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export interface InventoryRow {
  readonly action: string;
  /** What the event records: `any`, or the result a row is about (an export that was refused is queued, one that was made is privileged). */
  readonly result: string;
  readonly path: 'queued' | 'privileged';
  readonly files: readonly string[];
}

const ROW = /^\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|\s*(queued|privileged)\s*\|\s*([^|]*)\|/;

/** The rows of the table in the inventory document: the action, the result, the path and the files that write it. */
export function readInventory(text: string): readonly InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const line of text.split('\n')) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const [, action, result, path, cell] = match;
    if (action === undefined || result === undefined || (path !== 'queued' && path !== 'privileged') || cell === undefined) continue;
    rows.push({ action, result, path, files: [...cell.matchAll(/`([^`]+)`/g)].flatMap((file) => (file[1] === undefined ? [] : [file[1]])) });
  }
  return rows;
}

function actionsOf(file: SourceFile): readonly { readonly action: string; readonly line: number }[] {
  const found: { action: string; line: number }[] = [];
  const extra = FILE_PATTERNS[file.path];
  const patterns = extra === undefined ? ACTION_LITERALS : [...ACTION_LITERALS, extra];
  for (const pattern of patterns) {
    for (const match of file.text.matchAll(pattern)) {
      if (match[1] !== undefined && match.index !== undefined) found.push({ action: match[1], line: lineOf(file.text, match.index) });
    }
  }
  return found;
}

interface RecordCall {
  readonly index: number;
  readonly passesTransaction: boolean;
  /** A call on a queued handle, or one that records a failed attempt: neither is the privileged success. */
  readonly exempt: boolean;
}

/** The calls of `.record(`, with their arguments read to the matching parenthesis. */
function recordCalls(text: string): readonly RecordCall[] {
  const calls: RecordCall[] = [];
  for (const match of text.matchAll(/([A-Za-z_.?]*)\.record\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      const char = text[end];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += 1;
    }
    const args = text.slice(start, end);
    calls.push({ index: match.index ?? 0, passesTransaction: /\{\s*transaction\s*\}/.test(args), exempt: /refusal/i.test(match[1] ?? '') || /result:\s*'failed'/.test(args) });
  }
  return calls;
}

/** Whether a file of the folder of the writer passes the transaction of its change to the sink as the options of a record call. */
function writesInTransaction(product: readonly SourceFile[], path: string): boolean {
  const folder = path.slice(0, path.lastIndexOf('/') + 1);
  return product.some((file) => file.path.startsWith(folder) && !file.path.slice(folder.length).includes('/') && /\{\s*transaction\s*\}/.test(file.text));
}

export function checkAuditRouting(files: readonly SourceFile[], inventoryText: string): Violation[] {
  const violations: Violation[] = [];
  const report = (file: string, line: number, specifier: string, reason: string): void => void violations.push({ rule: 'audit-routing', file, line, specifier, reason });
  const product = files.filter((file) => !isExempt(file.path));
  for (const file of product) {
    if (!CONSTRUCTION_ALLOWED.has(file.path)) {
      for (const match of file.text.matchAll(CONSTRUCTION)) report(file.path, lineOf(file.text, match.index ?? 0), match[1] ?? '', 'an audit sink or queue is built only in the audit module, the start-up module and the extension\'s own factory');
    }
    if (!CONSTRUCTION_ALLOWED.has(file.path)) {
      for (const match of file.text.matchAll(MOUNTED_SINK)) report(file.path, lineOf(file.text, match.index ?? 0), 'mounted.sink', 'the sink the store mounted is held only by the wiring: an event is recorded through the queued or the privileged member of the seams');
    }
  }

  const inventory = readInventory(inventoryText);
  const byAction = new Map<string, InventoryRow[]>();
  for (const row of inventory) byAction.set(row.action, [...(byAction.get(row.action) ?? []), row]);
  const byPath = new Map(product.map((file) => [file.path, file]));
  for (const file of product) {
    for (const { action, line } of actionsOf(file)) {
      const rows = byAction.get(action);
      if (rows === undefined) report(file.path, line, action, `the event is not in ${AUDIT_INVENTORY_PATH}: say whether it is queued or privileged, and why`);
      else if (!rows.some((row) => row.files.includes(file.path))) report(file.path, line, action, `the file is not among the writers of this event in ${AUDIT_INVENTORY_PATH}`);
    }
  }
  for (const row of inventory) {
    for (const path of row.files) {
      const file = byPath.get(path);
      const found = file !== undefined && actionsOf(file).some((entry) => entry.action === row.action);
      if (!found) report(AUDIT_INVENTORY_PATH, 1, row.action, `no longer written in ${path}: remove it from the inventory`);
      else if (row.path === 'privileged') {
        const calls = recordCalls(file.text);
        const bad = calls.find((call) => !call.exempt && !call.passesTransaction);
        if (bad !== undefined) report(path, lineOf(file.text, bad.index), row.action, 'a call that records an event of a privileged writer passes `{ transaction }` as its options (a queued refusal goes through `refusalAudit`, a failed attempt carries `result: \'failed\'`)');
        else if (calls.length === 0 && !writesInTransaction(product, path)) report(path, 1, row.action, 'a privileged event is written through the transaction of its change');
      } else if (row.result === 'refused' && !/\brefusalAudit\.record\(/.test(file?.text ?? '')) report(path, 1, row.action, 'a refusal is recorded through the queued member `refusalAudit`');
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.specifier.localeCompare(b.specifier));
}

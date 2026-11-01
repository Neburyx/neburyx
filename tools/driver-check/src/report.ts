import type { CallEnd, CloseEnd, Sample, Transition } from './readings.js';
import { TIMEOUT_GRACE_MS } from './readings.js';
import { assertNever } from './probe.js';
import { CLOSE_TIMEOUT_MS, NODE_COUNT, READ_TIMEOUT_MS, SETTLE_LIMIT_MS, TAIL_MS } from './settings.js';
import type { CloseResult, Findings, QuickResult, Reuse } from './types.js';

export const NOT_TESTED = [
  'Terminating a transaction as a read-only principal (TERMINATE TRANSACTION): Neo4j Community has no role-based access control, so what a read-only principal may do is not tested.',
  'Whether a write sent in a read-access session is refused.',
  'Behaviour behind a proxy or load balancer, on AuraDB, or in a cluster.',
];

const ms = (value: number): string => `${Math.round(value)} ms`;

function describeEnd(end: CallEnd): string {
  switch (end.kind) {
    case 'raised':
      return `raised ${end.errorClass} ${end.code} after ${ms(end.atMs)}`;
    case 'returned':
      return `returned ${end.rows} row(s) after ${ms(end.atMs)}`;
    case 'unsettled':
      return `did not settle within ${ms(SETTLE_LIMIT_MS)}`;
    default:
      return assertNever(end);
  }
}

function describeClose(end: CloseEnd): string {
  const called = `called at ${ms(end.calledAtMs)}`;
  switch (end.kind) {
    case 'returned':
      return `returned after ${ms(end.atMs - end.calledAtMs)} (${called})`;
    case 'raised':
      return `raised ${end.errorClass} ${end.code} after ${ms(end.atMs - end.calledAtMs)} (${called})`;
    case 'unsettled':
      return `did not settle within ${ms(SETTLE_LIMIT_MS)} (${called})`;
    default:
      return assertNever(end);
  }
}

const describeReuse = (reuse: Reuse): string => (reuse.ok ? 'yes' : `no (${reuse.what})`);

function describeTransition(transition: Transition): string {
  const last = transition.lastRunningMs === undefined ? 'never' : ms(transition.lastRunningMs);
  const gone = transition.firstGoneMs === undefined ? 'never' : ms(transition.firstGoneMs);
  return `a look answered at ${last} was the last to find the query running; a look answered at ${gone} was the first to find the transaction gone`;
}

export function describeQuick(quick: QuickResult): string {
  if (!quick.returned) return `did not return (${quick.what ?? 'unknown'}) after ${ms(quick.elapsedMs)}`;
  const timing = quick.elapsedMs <= READ_TIMEOUT_MS ? 'inside' : 'after';
  return `returned ${quick.rows} row(s) after ${ms(quick.elapsedMs)}, ${timing} its timeout of ${ms(READ_TIMEOUT_MS)}`;
}

function listSamples(samples: readonly Sample[]): string[] {
  const cells = samples.map((s) => {
    const slow = s.atMs - s.sentMs >= 100 ? ` (sent ${Math.round(s.sentMs)})` : '';
    return `${Math.round(s.atMs)}:${s.state}${slow}`;
  });
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += 6) lines.push(`      ${cells.slice(i, i + 6).join('  ')}`);
  return lines;
}

function closeLines(result: CloseResult): string[] {
  const { reading } = result;
  return [
    `  Close the ${result.target} while the read runs (transaction timeout ${ms(CLOSE_TIMEOUT_MS)})`,
    `    seen running before the close: ${reading.seenRunningBeforeClose ? 'yes' : 'no'}; the call had already ended before the close: ${reading.callEndedBeforeClose ? 'yes' : 'no'}`,
    `    the pending call: ${describeEnd(result.end)}`,
    `    the close: ${describeClose(result.closeEnd)}`,
    `    server state 5 s after the close: ${reading.after5s}`,
    `    server state 15 s after the close: ${reading.after15s}`,
    `    server state at the ${ms(CLOSE_TIMEOUT_MS)} timeout: ${reading.atTimeout}`,
    `    server state ${ms(TIMEOUT_GRACE_MS)} after the timeout (the server enforces it late): ${reading.atTimeoutPlusGrace}`,
    `    ${describeTransition(reading)}`,
    `    the same driver can run another read: ${describeReuse(result.driverReuse)}`,
    `    finding: ${reading.verdict}`,
    '    samples of the transaction list (ms since the query started, when the answer arrived: state):',
    ...listSamples(result.samples),
  ];
}

export function inconclusiveFindings(all: readonly Findings[]): string[] {
  return all
    .flatMap((findings) => [
      { name: `${findings.facts.image} read timeout`, verdict: findings.timeout.reading.verdict },
      ...findings.closes.map((c) => ({ name: `${findings.facts.image} close ${c.target}`, verdict: c.reading.verdict })),
    ])
    .filter(({ verdict }) => verdict === 'inconclusive')
    .map(({ name }) => name);
}

export function renderReport(all: readonly Findings[], containerProblems: readonly string[] = []): string {
  const lines: string[] = [];
  for (const findings of all) {
    const { facts, timeout, quick } = findings;
    const { reading } = timeout;
    lines.push(
      `== ${facts.image}: Neo4j ${facts.serverVersion} ${facts.edition}, neo4j-driver ${facts.driverVersion} ==`,
      `  Data: ${NODE_COUNT} generated Item nodes; the slow read is a three-way cross product.`,
      '',
      `  Read timeout (read-access explicit transaction, timeout ${ms(READ_TIMEOUT_MS)})`,
      `    the pending call: ${describeEnd(timeout.end)}, against a timeout of ${ms(READ_TIMEOUT_MS)}`,
      `    seen running before the timeout: ${reading.seenRunningBeforeTimeout ? 'yes' : 'no'}`,
      `    server state at the end of the call: ${reading.atCallEnd}`,
      `    server state ${TAIL_MS / 1000} s later (at ${ms(reading.tailAtMs)}): ${reading.afterTail}`,
      `    ${describeTransition(reading)}`,
      `    the same session can run another read: ${describeReuse(timeout.sessionReuse)}`,
      `    finding: ${reading.verdict}`,
      '    samples of the transaction list (ms since the query started, when the answer arrived: state):',
      ...listSamples(timeout.samples),
      '',
      `  A read that finishes inside its timeout: ${describeQuick(quick)}`,
      '',
    );
    for (const result of findings.closes) lines.push(...closeLines(result), '');
    if (findings.cleanupFailures.length > 0) {
      lines.push('  Cleanup problems:', ...findings.cleanupFailures.map((failure) => `    - ${failure}`), '');
    }
  }
  if (containerProblems.length > 0) {
    lines.push('  Container cleanup problems:', ...containerProblems.map((problem) => `    - ${problem}`), '');
  }
  const open = inconclusiveFindings(all);
  lines.push(
    'Not tested:',
    ...NOT_TESTED.map((line) => `  - ${line}`),
    '',
    open.length === 0 ? 'Inconclusive findings: none' : `Inconclusive findings: ${open.join('; ')}`,
  );
  return lines.join('\n');
}

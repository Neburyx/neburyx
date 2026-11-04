import type { LastTest, SourceSummary, SourceTestReport } from '@neburyx/contracts';
import { COPY, READ_ONLY_WORDS } from './copy.js';

export type LastTestView =
  | { readonly kind: 'never' }
  | { readonly kind: 'other-configuration'; readonly checkedAt: string }
  | { readonly kind: 'tested'; readonly test: LastTest };

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export type DegreeNotice = { readonly kind: 'warnings'; readonly warnings: readonly string[] } | { readonly kind: 'not-run' };

const UTC_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatUtc(iso: string): string {
  return `${UTC_FORMAT.format(new Date(iso))} UTC`;
}

export function lastTestOfReport(report: SourceTestReport): LastTest {
  return {
    checkedAt: report.checkedAt,
    outcome: report.outcome,
    server: report.server === null ? null : { product: report.server.product, version: report.server.version },
    versionSupported: report.versionSupported,
    readOnlyCheck: report.readOnlyCheck,
    loginCanWrite: report.loginCanWrite,
    degreeStatus: report.degreeChecks.status,
    degreeWarnings: [...report.degreeChecks.warnings],
  };
}

/** The one check that the facts, the degree warnings and the last-test time all belong to: a held report of a test run in this visit while it is strictly newer than the stored last test, otherwise the stored one. */
export function lastTestView(summary: Pick<SourceSummary, 'lastTestAt' | 'lastTest'>, held?: LastTest): LastTestView {
  if (held !== undefined && (summary.lastTest === null || Date.parse(held.checkedAt) > Date.parse(summary.lastTest.checkedAt))) return { kind: 'tested', test: held };
  if (summary.lastTest !== null) return { kind: 'tested', test: summary.lastTest };
  return summary.lastTestAt === null ? { kind: 'never' } : { kind: 'other-configuration', checkedAt: summary.lastTestAt };
}

export function degreeNotice(view: LastTestView): DegreeNotice | undefined {
  if (view.kind !== 'tested') return undefined;
  if (view.test.degreeStatus === 'not-run') return { kind: 'not-run' };
  return view.test.degreeWarnings.length === 0 ? undefined : { kind: 'warnings', warnings: view.test.degreeWarnings };
}

export function mappingText(summary: SourceSummary['mappingSummary']): string {
  return [COPY.entityTypes(summary.entityTypes), COPY.relationshipTypes(summary.relationshipTypes), COPY.derivedRules(summary.derivedRules)].join(' · ');
}

function connectionText(test: LastTest): string {
  if (test.server === null) return COPY.notReached;
  const text = `${test.server.product} ${test.server.version}`.trim();
  return test.versionSupported === false ? `${text} · ${COPY.unsupportedVersion}` : text;
}

function readOnlyText(test: LastTest): string {
  const text = READ_ONLY_WORDS[test.readOnlyCheck];
  return test.loginCanWrite === true ? `${text} · ${COPY.loginCanWrite}` : text;
}

export function healthFacts(summary: SourceSummary, view: LastTestView): readonly Fact[] {
  const { labels } = COPY;
  const mapping: Fact = { label: labels.mappingValid, value: mappingText(summary.mappingSummary) };
  switch (view.kind) {
    case 'never':
      return [{ label: labels.lastTest, value: COPY.neverTested }, { label: labels.connection, value: COPY.notTestedYet }, { label: labels.readOnlyVerified, value: COPY.notTestedYet }, mapping];
    case 'other-configuration':
      return [
        { label: labels.lastTest, value: formatUtc(view.checkedAt) },
        { label: labels.connection, value: COPY.notTestedForConfiguration },
        { label: labels.readOnlyVerified, value: COPY.notTestedForConfiguration },
        mapping,
      ];
    case 'tested':
      return [
        { label: labels.lastTest, value: formatUtc(view.test.checkedAt) },
        { label: labels.connection, value: connectionText(view.test) },
        { label: labels.readOnlyVerified, value: readOnlyText(view.test) },
        mapping,
      ];
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

import { UNVERIFIED_CHECKS, type MappingChecks, type SourceTestReport } from '@neburyx/contracts';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';
import type { SourceModel } from '../mapping/model.js';
import { mappingSummaryOf } from '../registry/summary.js';
import { NOT_RUN } from './mapping-checks.js';
import { FAILURE_SENTENCES, FIX_THE_SOURCE, LOGIN_CAN_WRITE_REASON, PRIVILEGES_UNREADABLE_REASON, UNSUPPORTED_VERSION_REASON, type FailureReason } from './reasons.js';

/** How the verdict on the login came about: `probed` when the write probe gave it, `unreadable` when the server listed privileges the check could not read. */
export interface ReadOnlyFound {
  readonly probed?: boolean;
  readonly unreadable?: boolean;
  /** What the mapping checks found; absent, they were not run. */
  readonly mapping?: MappingChecks;
}

/** The reason a mapping check puts on the state: the first failing message and how many more there are, then what to do. */
function mappingReason(mapping: MappingChecks): string | null {
  const failing = mapping.findings.filter((entry) => entry.severity === 'fail');
  const [first] = failing;
  if (first !== undefined) {
    const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : '';
    return `The mapping does not fit the source: ${first.message}${more}. ${FIX_THE_SOURCE}`;
  }
  // when something was not verified, the reason is the first finding that says so, not a plain warning that happens to come first
  const leading = mapping.status === 'not-verified' ? mapping.findings.find((entry) => UNVERIFIED_CHECKS.includes(entry.check)) : mapping.findings[0];
  if (leading === undefined) return null;
  return mapping.status === 'not-verified' ? `The mapping could not be fully checked: ${leading.message}` : `The mapping has warnings: ${leading.message}`;
}

/** The report of a source that answered: `pass` on a supported server and a login that cannot write, `warn` on any other server or a login that can write; `loginCanWrite` null is `not-verified`, and `found.probed` says the answer is the write probe's. */
export function reportFromServer(source: SourceModel, server: CapabilitiesItem, loginCanWrite: boolean | null, checkedAt: string, found: ReadOnlyFound = {}): SourceTestReport {
  const supported = server.versionSupported;
  const unreadable = found.unreadable === true;
  const mapping = found.mapping ?? NOT_RUN;
  const mappingFailed = mapping.status === 'fail';
  const healthy = supported && loginCanWrite !== true && !unreadable && (mapping.status === 'pass' || mapping.status === 'not-run');
  return {
    schemaVersion: 1,
    sourceId: source.id,
    checkedAt,
    outcome: mappingFailed ? 'fail' : healthy ? 'pass' : 'warn',
    state: mappingFailed ? 'unavailable' : healthy ? 'connected' : 'degraded',
    stateReason: mappingFailed ? mappingReason(mapping) : loginCanWrite === true ? LOGIN_CAN_WRITE_REASON : !supported ? UNSUPPORTED_VERSION_REASON : unreadable ? PRIVILEGES_UNREADABLE_REASON : mappingReason(mapping),
    server: { product: server.product, version: server.version, edition: server.edition },
    versionSupported: supported,
    operations: [...server.operations],
    readOnlyCheck: loginCanWrite === null ? 'not-verified' : found.probed === true ? 'write-probe' : 'privileges-inspected',
    loginCanWrite,
    mappingChecks: mapping,
    mappingSummary: mappingSummaryOf(source),
  };
}

/** The report of a source that did not answer: `fail`, with nothing known about the server. */
export function reportFromFailure(source: SourceModel, reason: FailureReason, checkedAt: string): SourceTestReport {
  return {
    schemaVersion: 1,
    sourceId: source.id,
    checkedAt,
    outcome: 'fail',
    state: 'unavailable',
    stateReason: FAILURE_SENTENCES[reason],
    server: null,
    versionSupported: null,
    operations: [],
    readOnlyCheck: 'not-verified',
    loginCanWrite: null,
    mappingChecks: NOT_RUN,
    mappingSummary: mappingSummaryOf(source),
  };
}

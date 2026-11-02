import type { SourceTestReport } from '@neburyx/contracts';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';
import type { SourceModel } from '../mapping/model.js';
import { mappingSummaryOf } from '../registry/summary.js';
import { FAILURE_SENTENCES, LOGIN_CAN_WRITE_REASON, PRIVILEGES_UNREADABLE_REASON, UNSUPPORTED_VERSION_REASON, type FailureReason } from './reasons.js';

/** How the verdict on the login came about: `probed` when the write probe gave it, `unreadable` when the server listed privileges the check could not read. */
export interface ReadOnlyFound {
  readonly probed?: boolean;
  readonly unreadable?: boolean;
}

/** The report of a source that answered: `pass` on a supported server and a login that cannot write, `warn` on any other server or a login that can write; `loginCanWrite` null is `not-verified`, and `found.probed` says the answer is the write probe's. */
export function reportFromServer(source: SourceModel, server: CapabilitiesItem, loginCanWrite: boolean | null, checkedAt: string, found: ReadOnlyFound = {}): SourceTestReport {
  const supported = server.versionSupported;
  const unreadable = found.unreadable === true;
  const healthy = supported && loginCanWrite !== true && !unreadable;
  return {
    schemaVersion: 1,
    sourceId: source.id,
    checkedAt,
    outcome: healthy ? 'pass' : 'warn',
    state: healthy ? 'connected' : 'degraded',
    stateReason: loginCanWrite === true ? LOGIN_CAN_WRITE_REASON : !supported ? UNSUPPORTED_VERSION_REASON : unreadable ? PRIVILEGES_UNREADABLE_REASON : null,
    server: { product: server.product, version: server.version, edition: server.edition },
    versionSupported: supported,
    operations: [...server.operations],
    readOnlyCheck: loginCanWrite === null ? 'not-verified' : found.probed === true ? 'write-probe' : 'privileges-inspected',
    loginCanWrite,
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
    mappingSummary: mappingSummaryOf(source),
  };
}

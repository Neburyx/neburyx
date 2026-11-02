import type { SourceTestReport } from '@neburyx/contracts';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';
import type { SourceModel } from '../mapping/model.js';
import { mappingSummaryOf } from '../registry/summary.js';
import { FAILURE_SENTENCES, UNSUPPORTED_VERSION_REASON, type FailureReason } from './reasons.js';

/** The report of a source that answered: `pass` on a supported server, `warn` on any other. */
export function reportFromServer(source: SourceModel, server: CapabilitiesItem, checkedAt: string): SourceTestReport {
  const supported = server.versionSupported;
  return {
    schemaVersion: 1,
    sourceId: source.id,
    checkedAt,
    outcome: supported ? 'pass' : 'warn',
    state: supported ? 'connected' : 'degraded',
    stateReason: supported ? null : UNSUPPORTED_VERSION_REASON,
    server: { product: server.product, version: server.version, edition: server.edition },
    versionSupported: supported,
    operations: [...server.operations],
    readOnlyCheck: 'not-verified',
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
    mappingSummary: mappingSummaryOf(source),
  };
}

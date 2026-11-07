import type { LastTest, SourceSummary, SourceTestReport } from '@neburyx/contracts';
import type { SourceRow } from '../db/sources-repository.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { makeToken } from '../reference/token.js';
import { isKeyed, type MappingModel, type SourceModel } from '../mapping/model.js';

export function mappingSummaryOf(source: SourceModel): SourceSummary['mappingSummary'] {
  return { entityTypes: source.entities.length, relationshipTypes: source.relationships.length, derivedRules: source.derived.length, ...(source.entities.some(isKeyed) ? { keyedEntityTypes: source.entities.filter(isKeyed).length } : {}) };
}

/** A fixed list of fields of a report, so nothing else of it can reach the sources answer. */
export function lastTestOf(report: SourceTestReport): LastTest {
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

/** The demo case a source names; its starting entity carries the token of a keyed type, never the value. */
function demoCaseOf(source: SourceModel, references: ReferenceKeys | undefined): SourceSummary['demoCase'] {
  const demo = source.demoCase;
  if (demo === undefined) return null;
  const type = source.entities.find((entity) => entity.type === demo.entityType);
  if (type === undefined || !isKeyed(type)) return demo;
  if (references === undefined) throw new Error('the keyed references need the reference keys');
  return { ...demo, stableId: makeToken(references, { sourceId: source.id, entityType: demo.entityType }, demo.stableId) };
}

export function summariesOf(rows: readonly SourceRow[], mapping: MappingModel, latest: ReadonlyMap<string, SourceTestReport> = new Map(), references?: ReferenceKeys): SourceSummary[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).flatMap((row) => {
    const source = mapping.sources.find((candidate) => candidate.id === row.id);
    if (source === undefined) return [];
    const report = latest.get(row.id);
    return [
      {
        id: row.id,
        alias: row.alias,
        state: row.state,
        stateReason: row.stateReason,
        readOnly: true,
        synthetic: row.synthetic,
        lastTestAt: row.lastTestAt,
        lastTest: report === undefined ? null : lastTestOf(report),
        mappingSummary: mappingSummaryOf(source),
        demoCase: demoCaseOf(source, references),
      },
    ];
  });
}

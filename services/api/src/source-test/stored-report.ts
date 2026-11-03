import { sourceTestReportSchema, type SourceTestReport } from '@neburyx/contracts';

const NOT_RUN = { status: 'not-run', findings: [] };
const NOT_RUN_DEGREES = { status: 'not-run', foundOn: null, types: [], warnings: [] };

/** A report stored by an earlier version lacks the fields added since: no mapping checks and no degree checks were made (`not-run`) and no verdict on the login was recorded (null). */
function withDefaults(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored;
  return { loginCanWrite: null, mappingChecks: NOT_RUN, degreeChecks: NOT_RUN_DEGREES, ...stored };
}

/** Reads a report as it is stored in `source_checks.report`, whichever version of the product wrote it. */
export function readStoredReport(stored: unknown): SourceTestReport {
  return sourceTestReportSchema.parse(withDefaults(stored));
}

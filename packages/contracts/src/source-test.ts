import { z } from 'zod';
import { mappingSummarySchema, sourceStateSchema } from './sources.js';

export const TEST_OUTCOMES = ['pass', 'warn', 'fail'] as const;
export const READ_ONLY_CHECKS = ['privileges-inspected', 'write-probe', 'not-verified'] as const;
export const OPERATION_STATUSES = ['supported', 'by-template', 'unsupported'] as const;

export const MAPPING_CHECK_STATUSES = ['pass', 'warn', 'fail', 'not-run', 'not-verified'] as const;

/** Every check a finding can name, with the severity it always has. */
export const MAPPING_CHECK_SEVERITY = {
  label: 'fail',
  'relationship-type': 'fail',
  'search-index': 'fail',
  'reference-index': 'fail',
  'evidence-index': 'fail',
  'index-failed': 'fail',
  'stable-id-unindexed': 'fail',
  'stable-id-unique': 'fail',
  'sort-index': 'warn',
  'index-building': 'warn',
  'stable-id-unenforced': 'warn',
  'rel-stable-id-unindexed': 'warn',
  'schema-refused': 'warn',
  'schema-unreadable': 'warn',
  'stable-id-unverified': 'warn',
} as const;

export type MappingCheck = keyof typeof MAPPING_CHECK_SEVERITY;

/** The checks that say a part of the mapping could not be read against the source. */
export const UNVERIFIED_CHECKS: readonly MappingCheck[] = ['schema-refused', 'schema-unreadable', 'stable-id-unverified'];

export const testOutcomeSchema = z.enum(TEST_OUTCOMES);
export const readOnlyCheckSchema = z.enum(READ_ONLY_CHECKS);

const text = z.string().min(1);

export const serverInfoSchema = z.strictObject({
  product: text,
  version: z.string(),
  edition: text,
});

export const operationSchema = z.strictObject({
  name: text,
  status: z.enum(OPERATION_STATUSES),
});

const checkNames = Object.keys(MAPPING_CHECK_SEVERITY) as [MappingCheck, ...MappingCheck[]];

export const mappingFindingSchema = z
  .strictObject({
    severity: z.enum(['fail', 'warn']),
    check: z.enum(checkNames),
    entityType: text.optional(),
    relationshipType: text.optional(),
    from: text.optional(),
    to: text.optional(),
    property: text.optional(),
    message: text,
  })
  .refine((finding) => MAPPING_CHECK_SEVERITY[finding.check] === finding.severity, { message: 'a check always has the same severity', path: ['severity'] });

/** The strongest of the findings: fail, then not-verified, then warn, then pass; not-run when the mapping was not checked against the source. */
export const mappingChecksSchema = z
  .strictObject({ status: z.enum(MAPPING_CHECK_STATUSES), findings: z.array(mappingFindingSchema) })
  .refine(
    ({ status, findings }) => {
      const fails = findings.filter((finding) => finding.severity === 'fail');
      const unverified = findings.filter((finding) => UNVERIFIED_CHECKS.includes(finding.check));
      const plainWarnings = findings.filter((finding) => finding.severity === 'warn' && !UNVERIFIED_CHECKS.includes(finding.check));
      switch (status) {
        case 'pass':
        case 'not-run':
          return findings.length === 0;
        case 'fail':
          return fails.length > 0;
        case 'not-verified':
          return fails.length === 0 && unverified.length > 0;
        case 'warn':
          return fails.length === 0 && unverified.length === 0 && plainWarnings.length > 0;
        default:
          return false;
      }
    },
    { message: 'the status is the strongest of the findings', path: ['status'] },
  );

export type MappingChecks = z.infer<typeof mappingChecksSchema>;
export type MappingFinding = z.infer<typeof mappingFindingSchema>;

export const sourceTestReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sourceId: text,
    checkedAt: z.iso.datetime(),
    outcome: testOutcomeSchema,
    state: sourceStateSchema.exclude(['unknown']),
    stateReason: text.nullable(),
    server: serverInfoSchema.nullable(),
    versionSupported: z.boolean().nullable(),
    operations: z.array(operationSchema),
    readOnlyCheck: readOnlyCheckSchema,
    loginCanWrite: z.boolean().nullable(),
    mappingChecks: mappingChecksSchema,
    mappingSummary: mappingSummarySchema,
  })
  .refine((report) => (report.loginCanWrite === null) === (report.readOnlyCheck === 'not-verified'), {
    message: 'loginCanWrite is null if and only if readOnlyCheck is not-verified',
    path: ['loginCanWrite'],
  })
  .refine((report) => report.mappingChecks.status !== 'fail' || (report.outcome === 'fail' && report.state === 'unavailable'), {
    message: 'a failed mapping check makes the outcome fail and the state unavailable',
    path: ['mappingChecks'],
  });

export type SourceTestReport = z.infer<typeof sourceTestReportSchema>;
export type TestOutcome = z.infer<typeof testOutcomeSchema>;

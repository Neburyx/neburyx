import type { LastTest, SourceState } from '@neburyx/contracts';

export const STATE_WORDS: Readonly<Record<SourceState, string>> = {
  connected: 'Connected',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

export const READ_ONLY_WORDS: Readonly<Record<LastTest['readOnlyCheck'], string>> = {
  'privileges-inspected': 'Privileges inspected',
  'write-probe': 'Write probe, rolled back',
  'not-verified': 'Not verified',
};

export const COPY = {
  title: 'Sources',
  description: 'Sources are defined in a config file. This page shows their health. It never edits them.',
  listLabel: 'Configured sources',
  footnote: 'Health is independent of source access permissions.',
  readOnly: 'Read-only',
  loadingSources: 'Loading sources…',
  couldNotRead: 'The sources could not be read.',
  tryAgain: 'Try again',
  noSources: 'No sources are configured.',
  testSource: 'Test source',
  testing: 'Testing…',
  schemaNote: 'Schema inventory, not individual graph relationships.',
  degreeNotRun: 'Degree counts were not checked in this test.',
  mappingExample: 'Mapping example',
  mappingLabel: 'YAML · read-only · not a query',
  loadingMapping: 'Loading the mapping…',
  noExcerpt: 'The mapping has no excerpt to show.',
  diagnosticsBundle: 'Diagnostics bundle',
  comingLater: 'Coming later',
  neverTested: 'Never tested',
  notTestedYet: 'Not tested yet',
  notTestedForConfiguration: 'Not tested with the current configuration',
  notReached: 'Not reached',
  unsupportedVersion: 'unsupported version',
  loginCanWrite: 'the login can write',
  labels: { lastTest: 'Last test', connection: 'Connection', readOnlyVerified: 'Read-only verified', mappingValid: 'Mapping valid' },
  detailLabel: (alias: string): string => `${alias} health`,
  testFinished: (state: SourceState): string => `Test finished: ${state}`,
  entityTypes: (count: number): string => `${count} ${count === 1 ? 'entity type' : 'entity types'}`,
  relationshipTypes: (count: number): string => `${count} ${count === 1 ? 'relationship type' : 'relationship types'}`,
  derivedRules: (count: number): string => `${count} ${count === 1 ? 'derived rule' : 'derived rules'}`,
} as const;

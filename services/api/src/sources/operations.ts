export type OperationStatus = 'supported' | 'by-template' | 'unsupported';

export const OPERATIONS = {
  execute: 'supported',
  searchEntities: 'by-template',
  getEntity: 'by-template',
  getRelationship: 'by-template',
  previewExpansion: 'by-template',
  expandNeighbors: 'by-template',
  findBoundedPaths: 'by-template',
  runTemplate: 'by-template',
  capabilities: 'unsupported',
  cancel: 'unsupported',
} as const satisfies Readonly<Record<string, OperationStatus>>;

export interface CancelResult {
  readonly status: 'unsupported';
}

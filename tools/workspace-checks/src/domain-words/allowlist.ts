export interface AllowlistEntry {
  readonly word: string;
  readonly reason: string;
}

export const ALLOWLIST: readonly AllowlistEntry[] = [
  { word: 'name', reason: 'an ordinary property name in schemas and test data' },
  { word: 'status', reason: 'an ordinary property name in response schemas, error handling and test data' },
  { word: 'number', reason: 'the JavaScript type name that `typeof` checks compare against' },
  { word: 'model', reason: 'the key under which the mapping builder returns a loaded model' },
  { word: 'policy', reason: 'the policy seam of the gate, which decides authorization' },
  { word: 'network', reason: 'a key of the product\'s fixed icon set' },
];

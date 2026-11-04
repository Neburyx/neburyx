export type Rule = 'adapter-access' | 'community-imports-ee' | 'demo-graph-isolated' | 'system-principal' | 'source-gate' | 'write-probe' | 'test-source-command' | 'container-start';

export interface Violation {
  readonly rule: Rule;
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `${v.file}:${v.line} imports '${v.specifier}': ${v.reason} [${v.rule}]`).join('\n');
}

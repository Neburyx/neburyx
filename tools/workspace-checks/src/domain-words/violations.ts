export interface WordViolation {
  readonly file: string;
  readonly line: number;
  readonly word: string;
  readonly uses: readonly string[];
}

export function formatWordViolations(violations: readonly WordViolation[]): string {
  const lines = violations.map((v) => `${v.file}:${v.line} '${v.word}' is ${v.uses.join(' and ')} [domain-words]`);
  if (violations.length > 0) lines.push('Rename it, move the word into a pack, or add it to the allowlist with a reason (docs/architecture-checks.md).');
  return lines.join('\n');
}

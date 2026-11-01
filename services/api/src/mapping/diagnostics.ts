export interface MappingIssue {
  readonly path: string;
  readonly context?: string;
  readonly reason: string;
  readonly line?: number;
  readonly column?: number;
}

const MAX_REPORTED_ISSUES = 10;

export class MappingError extends Error {
  readonly issues: readonly MappingIssue[];

  constructor(file: string, issues: readonly MappingIssue[]) {
    super(formatMappingError(file, issues));
    this.issues = issues;
  }
}

function describeLocation(issue: MappingIssue): string {
  const place = issue.line === undefined ? '' : ` (line ${issue.line}${issue.column === undefined ? '' : `, column ${issue.column}`})`;
  const named = issue.context === undefined ? issue.path : `${issue.path} (${issue.context})`;
  return named === '' ? place.trim() : `${named}${place}`;
}

function formatMappingError(file: string, issues: readonly MappingIssue[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const location = describeLocation(issue);
    return location === '' ? `${issue.reason}` : `${location}: ${issue.reason}`;
  });
  const hidden = issues.length - shown.length;
  const more = hidden > 0 ? [`and ${hidden} more`] : [];
  return [`invalid mapping ${file}:`, ...shown.map((line) => `  ${line}`), ...more.map((line) => `  ${line}`)].join('\n');
}

export function pathOf(segments: readonly (string | number)[]): string {
  return segments.reduce<string>((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;
    return path === '' ? segment : `${path}.${segment}`;
  }, '');
}

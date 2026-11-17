import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface UpgradeCheck {
  readonly name: string;
  readonly passed: boolean;
  /** Why a check is failed without having run. */
  readonly note?: string;
}

/** Every expected check in order: one that did not run (a filtered run, a failed set-up) is a failed check, never a missing one. */
export function withExpected(expected: readonly string[], ran: readonly UpgradeCheck[]): readonly UpgradeCheck[] {
  const known = expected.map((name) => ran.find((check) => check.name === name) ?? { name, passed: false, note: 'not run' });
  return [...known, ...ran.filter((check) => !expected.includes(check.name))];
}

/** A tree with uncommitted changes cannot be the commit a record names, so it is refused unless the run is marked as one that does not count. */
export function dirtyTreeRefusal(dirty: boolean, dryRun: boolean): string | undefined {
  return dirty && !dryRun ? 'the working tree has uncommitted changes: commit them, or set NEBURYX_UPGRADE_DRY_RUN for a run that does not count' : undefined;
}

export interface UpgradeRecord {
  readonly startedAt: Date;
  readonly commit: string;
  readonly dirty: boolean;
  readonly dryRun: boolean;
  readonly previous: { readonly reference: string; readonly digest: string | undefined; readonly imageId: string | undefined; readonly migrations: readonly string[] };
  /** The build has no registry digest until a release publishes it, so its image ID stands in for one. */
  readonly build: { readonly reference: string; readonly imageId: string | undefined; readonly migrations: readonly string[] };
  /** The migrations the database held before the upgrade and after it. */
  readonly applied: { readonly before: readonly string[]; readonly after: readonly string[] };
  readonly checks: readonly UpgradeCheck[];
}

export interface RenderedRecord {
  readonly name: string;
  readonly json: string;
  readonly markdown: string;
  readonly result: 'PASS' | 'FAIL';
}

const stamp = (date: Date): string => date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** The result is PASS only when at least one check ran and every check passed. */
export function resultOf(checks: readonly UpgradeCheck[]): 'PASS' | 'FAIL' {
  return checks.length > 0 && checks.every((check) => check.passed) ? 'PASS' : 'FAIL';
}

/** The record of one run, named as the release checks name theirs: `<UTC date-time>-<short commit>[-dry-run]`. */
export function renderRecord(record: UpgradeRecord): RenderedRecord {
  const result = resultOf(record.checks);
  const name = `${stamp(record.startedAt)}-${record.commit.slice(0, 7)}${record.dryRun ? '-dry-run' : ''}`;
  const shown = (value: string | undefined): string => value ?? 'not available';
  const json = JSON.stringify({ startedAt: record.startedAt.toISOString(), commit: record.commit, uncommittedChanges: record.dirty, dryRun: record.dryRun, result, previous: record.previous, build: record.build, applied: record.applied, checks: record.checks }, null, 2) + '\n';
  const markdown = [
    record.dryRun ? 'Dry run: does not count.' : 'This run counts toward the release.',
    '',
    '# Upgrade from the previous published image',
    '',
    `Commit: ${record.commit}`,
    `Result: ${result}`,
    ...(record.dirty ? ['', 'The working tree had uncommitted changes.'] : []),
    '',
    '| | Reference | Digest | Image ID | Migrations shipped |',
    '|---|---|---|---|---|',
    `| Previous | ${record.previous.reference} | ${shown(record.previous.digest)} | ${shown(record.previous.imageId)} | ${record.previous.migrations.length} |`,
    `| Build under test | ${record.build.reference} | not published (the image ID stands in) | ${shown(record.build.imageId)} | ${record.build.migrations.length} |`,
    '',
    `Migrations the build adds: ${record.build.migrations.filter((migration) => !record.previous.migrations.includes(migration)).join(', ') || 'none'}`,
    '',
    `Migrations applied before the upgrade: ${record.applied.before.length}; after: ${record.applied.after.length}`,
    '',
    '| Check | Result |',
    '|---|---|',
    ...record.checks.map((check) => `| ${check.name} | ${check.passed ? 'passed' : `failed${check.note === undefined ? '' : ` (${check.note})`}`} |`),
    '',
  ].join('\n');
  return { name, json, markdown, result };
}

/** Refuses a folder inside the repository: a record names images and commits and is kept outside it. */
export function recordFolder(folder: string, repository: string): string {
  const resolved = resolve(folder);
  const inside = relative(resolve(repository), resolved);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error(`NEBURYX_UPGRADE_RECORD_DIR must be outside the repository (got ${folder})`);
  return resolved;
}

export function writeRecord(folder: string, rendered: RenderedRecord): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${rendered.name}.json`), rendered.json);
  writeFileSync(join(folder, `${rendered.name}.md`), rendered.markdown);
}

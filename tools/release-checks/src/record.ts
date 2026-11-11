import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, RunRecord } from './types.js';

export const DRY_RUN_LINE = 'Dry run: does not count.';
const SHORT_COMMIT_LENGTH = 7;

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function recordBaseName(startedAt: Date, commit: string, dryRun: boolean): string {
  return `${stamp(startedAt)}-${commit.slice(0, SHORT_COMMIT_LENGTH)}${dryRun ? '-dry-run' : ''}`;
}

export function logsFolderName(base: string): string {
  return `${base}.logs`;
}

function row(result: CheckResult): string {
  const exit = result.exitCode === null ? 'none' : String(result.exitCode);
  const cells = [result.id, result.status, exit, String(result.durationMs), result.detail, result.log === '' ? '' : result.log];
  return `| ${cells.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
}

function figures(result: CheckResult): readonly string[] {
  return result.data === undefined ? [] : [`## ${result.id}`, '', '```json', JSON.stringify(result.data, null, 2), '```', ''];
}

export function renderMarkdown(record: RunRecord): string {
  const failed = record.checks.filter((check) => check.status === 'failed');
  const lines = [
    ...(record.dryRun ? [DRY_RUN_LINE, ''] : []),
    '# Release checks',
    '',
    `Commit: ${record.commit}`,
    `Result: ${failed.length === 0 ? 'PASS' : 'FAIL'}`,
    '',
    '| | |',
    '|---|---|',
    `| Working tree | ${record.treeClean ? 'clean' : 'not clean'} |`,
    `| Started (UTC) | ${record.startedAt} |`,
    `| Finished (UTC) | ${record.finishedAt} |`,
    `| Node | ${record.environment.node} |`,
    `| pnpm | ${record.environment.pnpm} |`,
    `| Docker | ${record.environment.docker} |`,
    `| Failed checks | ${failed.length === 0 ? 'none' : failed.map((check) => check.id).join(', ')} |`,
    '',
    '| Check | Status | Exit code | Duration (ms) | Detail | Log |',
    '|---|---|---|---|---|---|',
    ...record.checks.map(row),
    '',
    ...record.checks.flatMap(figures),
  ];
  return lines.join('\n');
}

export interface WrittenRecord {
  readonly json: string;
  readonly markdown: string;
}

export async function writeRecord(directory: string, base: string, record: RunRecord): Promise<WrittenRecord> {
  await mkdir(directory, { recursive: true });
  const json = join(directory, `${base}.json`);
  const markdown = join(directory, `${base}.md`);
  await writeFile(json, `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(markdown, renderMarkdown(record));
  return { json, markdown };
}

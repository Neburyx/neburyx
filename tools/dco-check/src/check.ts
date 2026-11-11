import { execFileSync } from 'node:child_process';
import { hasSignOff } from './sign-off.js';

export type CheckResult =
  | { readonly status: 'pass'; readonly checked: number }
  | { readonly status: 'unsigned'; readonly checked: number; readonly unsigned: readonly string[] }
  | { readonly status: 'usage'; readonly reason: string };

const FIELD = '\u001f';
const RECORD = '\u001e';
const MAX_LOG_BYTES = 256 * 1024 * 1024;

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_LOG_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
}

function isRepository(cwd: string): boolean {
  try {
    git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

function exists(revision: string, cwd: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export function checkRange(args: readonly string[], cwd: string = process.cwd()): CheckResult {
  const [base, head, ...extra] = args;
  if (base === undefined || head === undefined || extra.length > 0) {
    return { status: 'usage', reason: 'expected two arguments: <base> <head>' };
  }
  if (!isRepository(cwd)) return { status: 'usage', reason: `git failed: ${cwd} is not a git repository` };
  if (!exists(base, cwd)) return { status: 'usage', reason: `base does not exist: ${base}` };
  if (!exists(head, cwd)) return { status: 'usage', reason: `head does not exist: ${head}` };

  let log: string;
  try {
    log = git(['log', '--no-merges', `--format=%h${FIELD}%s${FIELD}%B${RECORD}`, `${base}..${head}`], cwd);
  } catch (error) {
    return { status: 'usage', reason: `git failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
  const commits = log.split(RECORD).filter((record) => record.trim() !== '');
  if (commits.length === 0) return { status: 'usage', reason: `no commits in ${base}..${head}` };

  const unsigned = commits.flatMap((record) => {
    const [hash, subject, message] = record.trim().split(FIELD);
    return hasSignOff(message ?? '') ? [] : [`${hash ?? ''} ${subject ?? ''}`];
  });
  return unsigned.length === 0
    ? { status: 'pass', checked: commits.length }
    : { status: 'unsigned', checked: commits.length, unsigned };
}

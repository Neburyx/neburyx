import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRange } from './check.js';
import { run } from './run.js';

let repo: string;

const sealedEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
};

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: sealedEnv, encoding: 'utf8' });
}

let counter = 0;
function commit(message: string, signOff = false, file = 'file.txt'): void {
  counter += 1;
  writeFileSync(join(repo, file), `${counter}\n`);
  git('add', file);
  git('commit', '--allow-empty-message', ...(signOff ? ['-s'] : []), '-m', message);
}

const runCheck = (base: string, head = 'HEAD') => checkRange([base, head], repo);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dco-check-'));
  git('init', '--quiet', '--initial-branch=main');
  commit('Base commit', true);
  git('tag', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the DCO check', () => {
  it('passes a range of commits made with git commit -s and counts them', () => {
    commit('First change', true);
    commit('Second change', true);
    expect(runCheck('base')).toEqual({ status: 'pass', checked: 2 });
  });

  it('names a commit made without a sign-off', () => {
    commit('Signed change', true);
    commit('Unsigned change');
    const result = runCheck('base');
    expect(result.status).toBe('unsigned');
    expect(result).toMatchObject({ checked: 2, unsigned: [expect.stringMatching(/^[0-9a-f]+ Unsigned change$/)] });
  });

  it('does not accept the line in the subject only', () => {
    commit('Signed-off-by: Test Author <author@example.test>');
    expect(runCheck('base').status).toBe('unsigned');
  });

  it('does not accept the line in a paragraph that is not the last one', () => {
    commit('Change\n\nSigned-off-by: Test Author <author@example.test>\n\nMore text after it');
    expect(runCheck('base').status).toBe('unsigned');
  });

  it('does not accept a line without an email part', () => {
    commit('Change\n\nSigned-off-by: Test Author');
    expect(runCheck('base').status).toBe('unsigned');
  });

  it('accepts the line among other trailers', () => {
    commit('Change\n\nReviewed-by: Someone <someone@example.test>\nSigned-off-by: Test Author <author@example.test>');
    expect(runCheck('base')).toEqual({ status: 'pass', checked: 1 });
  });

  it('skips the merge commit and checks the commits it brings in', () => {
    git('checkout', '--quiet', '-b', 'side');
    commit('Side change', false, 'side.txt');
    git('checkout', '--quiet', 'main');
    commit('Main change', true);
    git('merge', '--quiet', '--no-ff', '--no-edit', 'side');
    const result = runCheck('base');
    expect(result.status).toBe('unsigned');
    expect(result).toMatchObject({ checked: 2, unsigned: [expect.stringContaining('Side change')] });
  });

  it('refuses an empty range', () => {
    expect(runCheck('base', 'base')).toEqual({ status: 'usage', reason: 'no commits in base..base' });
  });

  it('refuses a base that does not exist', () => {
    expect(runCheck('nowhere')).toEqual({ status: 'usage', reason: 'base does not exist: nowhere' });
  });

  it('refuses a head that does not exist', () => {
    expect(runCheck('base', 'nowhere')).toEqual({ status: 'usage', reason: 'head does not exist: nowhere' });
  });

  it('refuses a call without both arguments', () => {
    expect(checkRange([])).toMatchObject({ status: 'usage' });
    expect(checkRange(['base'])).toMatchObject({ status: 'usage' });
  });

  it('refuses a folder that is not a git repository, saying that git failed', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dco-plain-'));
    try {
      expect(checkRange(['base', 'HEAD'], plain)).toMatchObject({ status: 'usage', reason: expect.stringContaining('git failed') });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('the command', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, output: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) } };
  };

  it('exits 0 and prints the number of commits checked', () => {
    commit('Change', true);
    const { out, err, output } = capture();
    expect(run(['base', 'HEAD'], repo, output)).toBe(0);
    expect(out.join('')).toContain('1 commit(s) checked');
    expect(err).toEqual([]);
  });

  it('exits 1 and prints the short hash and subject of each unsigned commit', () => {
    commit('Unsigned one');
    commit('Unsigned two');
    const { err, output } = capture();
    expect(run(['base', 'HEAD'], repo, output)).toBe(1);
    const text = err.join('');
    expect(text).toContain('2 of 2 commits');
    expect(text).toMatch(/[0-9a-f]+ Unsigned one/);
    expect(text).toMatch(/[0-9a-f]+ Unsigned two/);
  });

  it('exits 2 and says why for an empty range', () => {
    const { err, output } = capture();
    expect(run(['base', 'base'], repo, output)).toBe(2);
    expect(err.join('')).toContain('no commits in base..base');
  });
});

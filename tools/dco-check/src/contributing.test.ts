import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkRange } from './check.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const contributing = read('CONTRIBUTING.md');
const prose = contributing.replace(/\s+/g, ' ');
const certificate = readFileSync(new URL('./fixtures/dco-1.1.txt', import.meta.url), 'utf8');
const blocks = [...contributing.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((match) => ({ language: match[1] ?? '', text: match[2] ?? '' }));
const commands = blocks.filter((block) => block.language === 'bash').flatMap((block) => block.text.trim().split('\n'));

describe('CONTRIBUTING.md', () => {
  it('holds the whole Developer Certificate of Origin 1.1 and says there is no agreement to sign', () => {
    expect(blocks.some((block) => block.text === certificate)).toBe(true);
    expect(prose).toContain('no contributor licence agreement');
  });

  it('names the command and the job that exist', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['check:dco']).toBeDefined();
    expect(prose).toContain('`pnpm check:dco <base> <head>`');
    const jobs = Object.keys((parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, unknown> }).jobs);
    expect(jobs).toContain('dco');
    expect(prose).toContain('pull-request job `dco`');
    expect(prose).toContain('does not verify who you are');
  });

  it('links files that exist', () => {
    const links = [...contributing.matchAll(/\]\(([^)#]+)\)/g)].map((match) => match[1] ?? '');
    expect(links).toEqual(['SECURITY.md', 'LICENSE', 'README.md', 'docs/coding-guidelines.md']);
    for (const link of links) expect(() => readFileSync(join(root, link))).not.toThrow();
    expect(contributing).toContain('Apache-2.0');
  });

  it('holds no date, address or link outside the certificate, and none of the excluded items', () => {
    const outside = contributing.replace(certificate, '').replaceAll('you@example.com', '');
    expect(outside).not.toMatch(/https?:|@[\w-]+\.|\b(19|20)\d{2}\b/);
    expect(outside).not.toMatch(/code of conduct|bounty|issue template|pull request template/i);
  });

  it('documents only commands that are run here or listed as not runnable', () => {
    const notRunnable = ['git push --force-with-lease'];
    const run = ['git commit -s -m "Describe the change"', 'git commit --amend -s --no-edit', 'git rebase --signoff origin/main'];
    expect(commands.sort()).toEqual([...run].sort());
    expect(contributing).toContain(`\`${notRunnable[0]}\``);
  });
});

describe('the documented fixes', () => {
  let repo: string;
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.test',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.test',
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.editor=true', ...args], { cwd: repo, env, encoding: 'utf8' });
  const commit = (name: string, extra: string[] = []) => {
    writeFileSync(join(repo, name), 'x\n');
    git('add', name);
    git('commit', ...extra, '-m', name);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dco-doc-'));
    git('init', '--quiet', '--initial-branch=main');
    commit('base', ['-s']);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('turns an unsigned commit into a passing range with git commit --amend -s --no-edit', () => {
    commit('one');
    expect(checkRange(['origin/main', 'HEAD'], repo).status).toBe('unsigned');
    git('commit', '--amend', '-s', '--no-edit');
    expect(checkRange(['origin/main', 'HEAD'], repo)).toEqual({ status: 'pass', checked: 1 });
  });

  it('turns two unsigned commits into a passing range with git rebase --signoff', () => {
    commit('one');
    commit('two');
    expect(checkRange(['origin/main', 'HEAD'], repo)).toMatchObject({ status: 'unsigned', checked: 2 });
    git('rebase', '--signoff', 'origin/main');
    expect(checkRange(['origin/main', 'HEAD'], repo)).toEqual({ status: 'pass', checked: 2 });
  });

  it('signs a commit made with the documented git commit -s -m command', () => {
    writeFileSync(join(repo, 'f'), 'x\n');
    git('add', 'f');
    git('commit', '-s', '-m', 'Describe the change');
    expect(checkRange(['origin/main', 'HEAD'], repo)).toEqual({ status: 'pass', checked: 1 });
  });
});

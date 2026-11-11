import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { neutralityCheck } from './neutrality.js';
import { execResult, fakeExec } from './testing.js';
import type { CheckContext, ExecRequest, ExecResult } from './types.js';

const COMPOSE = [
  'passes, prints the read-only line as not verified, the mapping summary and the degree lines, and starts no loader',
  'fails and names the entity type and its stable ID property when the stable ID constraint is dropped, and passes again when it is recreated',
];
const SAVED_MEMORY = 'shows a placeholder at the saved place for each unmapped item, names the dropped property filter, raises no error and reads nothing for a placeholder';
const SAVED_PG = 'shows the placeholders and the dropped-filter notice with no error, and the next write stores the new mapping hash';

interface Setup {
  readonly packs?: readonly string[];
  readonly dockerUp?: boolean;
  readonly titles?: Record<string, readonly string[]>;
  readonly exits?: Record<string, number>;
  readonly image?: boolean;
  readonly buildExit?: number;
  readonly untagOnly?: boolean;
}

function setup(options: Setup = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'neutral-repo-'));
  const workDir = mkdtempSync(join(tmpdir(), 'neutral-work-'));
  mkdirSync(join(repoRoot, 'domain-packs'), { recursive: true });
  for (const pack of options.packs ?? ['alpha', 'beta']) {
    mkdirSync(join(repoRoot, 'domain-packs', pack), { recursive: true });
    writeFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), '');
  }
  writeFileSync(join(repoRoot, 'domain-packs', 'README.md'), '');
  const packCount = (options.packs ?? ['alpha', 'beta']).length;
  const defaults: Record<string, readonly string[]> = {
    domains: ['holds no pack identifier as a string literal in the product directories, and more'],
    packs: ['a pack test'],
    'demo-compose': Array.from({ length: packCount }, () => COMPOSE).flat(),
    'saved-view-memory': [SAVED_MEMORY],
    'saved-view-postgres': [SAVED_PG],
  };
  const titles = { ...defaults, ...options.titles };
  const answers = (request: ExecRequest): ExecResult => {
    if (request.command === 'docker' && request.args[0] === 'info') return execResult({ exitCode: options.dockerUp === false ? 1 : 0 });
    if (request.command === 'docker' && request.args[0] === 'events') {
      return execResult({ output: options.image === false ? '' : `{"Type":"image","Action":"${options.untagOnly === true ? 'untag' : 'tag'}","Actor":{"ID":"sha256:abc123","Attributes":{"name":"neburyx-demo-test:d-1a2b3c"}}}\n` });
    }
    if (request.args.includes('build')) return execResult({ exitCode: options.buildExit ?? 0 });
    const report = request.args.find((arg) => arg.startsWith('--outputFile.json='));
    if (report === undefined) return execResult();
    const label = report.slice(report.lastIndexOf('/') + 1, -'.json'.length);
    writeFileSync(report.slice('--outputFile.json='.length), JSON.stringify({ testResults: [{ assertionResults: (titles[label] ?? []).map((title) => ({ title, fullName: title, status: 'passed' })) }] }));
    return execResult({ exitCode: options.exits?.[label] ?? 0 });
  };
  const fake = fakeExec(answers);
  const context: CheckContext = { exec: fake.exec, signal: new AbortController().signal, repoRoot, commit: 'abcdef0', monotonicNowMs: () => 0, workDir, env: {} };
  return { fake, run: () => neutralityCheck(() => new Date(Date.UTC(2026, 10, 11, 9, 0, 0))).run(context) };
}

const ranLabels = (requests: readonly ExecRequest[]): string[] => requests.flatMap((request) => request.args.filter((arg) => arg.startsWith('--outputFile.json=')).map((arg) => arg.slice(arg.lastIndexOf('/') + 1, -'.json'.length)));

describe('neutralityCheck', () => {
  it('fails when one part fails, names it, and still runs the other three', async () => {
    const { fake, run } = setup({ exits: { packs: 1 } });
    const outcome = await run();
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.detail).toContain('packs: packs: exited with code 1');
    expect(ranLabels(fake.requests)).toEqual(['domains', 'packs', 'demo-compose', 'saved-view-memory', 'saved-view-postgres']);
  });

  it('fails a part whose run reports no tests', async () => {
    const outcome = await setup({ titles: { domains: [] } }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('domains: domains: no tests ran');
  });

  it('fails the domains part when the scan of the real repository is not among the passed tests', async () => {
    const outcome = await setup({ titles: { domains: ['a fixture test'] } }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('holds no pack identifier as a string literal in the product directories');
  });

  it('fails a part whose required test is not found, naming it', async () => {
    const outcome = await setup({ titles: { 'saved-view-memory': ['some other test'] } }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('required test not found 1 time(s), found 0: shows a placeholder at the saved place');
  });

  it('needs the per-pack compose tests once for every pack found in the packs folder', async () => {
    const outcome = await setup({ packs: ['a', 'b', 'c'], titles: { 'demo-compose': [...COMPOSE, ...COMPOSE] } }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('required test not found 3 time(s), found 2');
  });

  it('fails the Docker parts and starts no Docker when Docker is not reachable, and runs the rest', async () => {
    const { fake, run } = setup({ dockerUp: false });
    const outcome = await run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('Docker is not reachable');
    expect(ranLabels(fake.requests)).toEqual(['domains', 'packs', 'saved-view-memory']);
    expect(fake.requests.filter((request) => request.command === 'docker').map((request) => request.args[0])).toEqual(['info']);
  });

  it('finds the suite image from the untag event of its removal when no tag event was sent', async () => {
    const { run } = setup({ untagOnly: true });
    expect((await run()).data).toMatchObject({ suiteImage: { tag: 'neburyx-demo-test:d-1a2b3c', id: 'sha256:abc123' } });
  });

  it('fails when the image the compose suite built cannot be found', async () => {
    const outcome = await setup({ image: false }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('suite image not found in Docker events');
  });

  it('passes with the four parts, the packs it found, the outcomes the saved-view part asserts and the suite image apart from the image under test', async () => {
    const outcome = await setup().run();
    expect(outcome).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(outcome.data).toMatchObject({
      packs: ['alpha', 'beta'],
      suiteImage: { tag: 'neburyx-demo-test:d-1a2b3c', id: 'sha256:abc123' },
      savedViewAsserts: ['placeholders at the saved places', 'the dropped-filter notice', 'no error'],
    });
    expect((outcome.data as { parts: { id: string }[] }).parts.map((part) => part.id)).toEqual(['domains', 'packs', 'demo-compose', 'saved-view']);
  });

  it('fails when the pre-build fails, before any part runs', async () => {
    const { fake, run } = setup({ buildExit: 1 });
    const outcome = await run();
    expect(outcome).toMatchObject({ status: 'failed', detail: 'build: exited with code 1' });
    expect(ranLabels(fake.requests)).toEqual([]);
  });

  it('fails when no domain pack is found', async () => {
    expect(await setup({ packs: [] }).run()).toMatchObject({ status: 'failed', detail: 'no domain packs found' });
  });
});

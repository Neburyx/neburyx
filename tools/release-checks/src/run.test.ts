import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_PASSED, EXIT_USAGE, runRelease, type RunDeps } from './run.js';
import { execResult, fakeCheck, fakeExec } from './testing.js';
import type { Check, ExecRequest, ExecResult } from './types.js';

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

function git(dirty: boolean): (request: ExecRequest) => ExecResult {
  return (request) => {
    if (request.command === 'git' && request.args[0] === 'rev-parse') return execResult({ output: `${COMMIT}\n` });
    if (request.command === 'git') return execResult({ output: dirty ? ' M file.ts\n' : '' });
    if (request.command === 'docker') return execResult({ exitCode: 1 });
    return execResult({ output: '12.0.0\n' });
  };
}

function setup(checks: readonly Check[], options: { dirty?: boolean; controller?: AbortController } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const recordDir = mkdtempSync(join(tmpdir(), 'release-record-'));
  const controller = options.controller ?? new AbortController();
  let tick = 0;
  const deps: RunDeps = {
    exec: fakeExec(git(options.dirty === true)).exec,
    signal: controller.signal,
    repoRoot: '/some/checkout',
    env: { NBX_EE_PASSWORD: 'pw-value-123' },
    clock: () => new Date(Date.UTC(2026, 10, 11, 8, 0, tick++)),
    monotonicNowMs: () => tick * 100,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    catalogue: () => checks,
  };
  const records = () => readdirSync(recordDir).filter((name) => name.endsWith('.json'));
  const readJson = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(recordDir, name), 'utf8'));
  return { deps, out, err, recordDir, records, readJson };
}

describe('runRelease usage errors', () => {
  it('exits 2 with no record folder and names the problem', async () => {
    const { deps, err } = setup([fakeCheck('a')]);
    expect(await runRelease([], deps)).toBe(EXIT_USAGE);
    expect(err.join('')).toContain('--record-dir is required');
  });

  it('exits 2 for an unknown option', async () => {
    const { deps, err } = setup([fakeCheck('a')]);
    expect(await runRelease(['--record-dir', '/tmp/x', '--quick'], deps)).toBe(EXIT_USAGE);
    expect(err.join('')).toContain('unknown option --quick');
  });

  it('exits 2 for a record folder inside the checkout and writes nothing', async () => {
    const { deps, err } = setup([fakeCheck('a')]);
    expect(await runRelease(['--record-dir', '/some/checkout/results'], deps)).toBe(EXIT_USAGE);
    expect(err.join('')).toContain('outside this repository');
    expect(existsSync('/some/checkout')).toBe(false);
  });

  it('exits 2 before any check starts when the tree is not clean and the run is not a dry run', async () => {
    let started = false;
    const { deps, recordDir, records } = setup([fakeCheck('a', {}, () => (started = true))], { dirty: true });
    expect(await runRelease(['--record-dir', recordDir], deps)).toBe(EXIT_USAGE);
    expect(started).toBe(false);
    expect(records()).toEqual([]);
  });
});

describe('runRelease', () => {
  it('writes the json and markdown records of a passing run and exits 0', async () => {
    const { deps, recordDir, records, readJson } = setup([fakeCheck('a'), fakeCheck('b')]);
    expect(await runRelease(['--record-dir', recordDir], deps)).toBe(EXIT_PASSED);
    const [name] = records();
    expect(name).toBe('20261111T080000Z-abcdef0.json');
    const record = readJson(name ?? '');
    expect(record).toMatchObject({ dryRun: false, commit: COMMIT, treeClean: true });
    expect((record['checks'] as { id: string; status: string }[]).map((check) => `${check.id}:${check.status}`)).toEqual(['a:passed', 'b:passed']);
    expect(readFileSync(join(recordDir, (name ?? '').replace('.json', '.md')), 'utf8')).not.toContain('Dry run');
  });

  it('runs every check after a failure, exits 1 and names the failed check', async () => {
    const { deps, recordDir, err, records, readJson } = setup([fakeCheck('a', { status: 'failed', detail: 'exited with code 1', exitCode: 1 }), fakeCheck('b')]);
    expect(await runRelease(['--record-dir', recordDir], deps)).toBe(EXIT_FAILED);
    expect(err.join('')).toContain('failed: a');
    expect((readJson(records()[0] ?? '')['checks'] as unknown[]).length).toBe(2);
  });

  it('labels a dry run in the file name, the json and the first line of the markdown, and runs on a dirty tree', async () => {
    const { deps, recordDir, records, readJson } = setup([fakeCheck('a')], { dirty: true });
    expect(await runRelease(['--record-dir', recordDir, '--dry-run'], deps)).toBe(EXIT_PASSED);
    const [name] = records();
    expect(name).toMatch(/-abcdef0-dry-run\.json$/);
    expect(readJson(name ?? '')).toMatchObject({ dryRun: true, treeClean: false });
    expect(readFileSync(join(recordDir, (name ?? '').replace('.json', '.md')), 'utf8').split('\n')[0]).toBe('Dry run: does not count.');
  });

  it('saves each check log next to the record and keeps the connection values out of every file', async () => {
    const { deps, recordDir, records } = setup([fakeCheck('a', { output: 'connect with pw-value-123' })]);
    await runRelease(['--record-dir', recordDir], deps);
    const logs = join(recordDir, (records()[0] ?? '').replace('.json', '.logs'));
    expect(readFileSync(join(logs, 'a.log'), 'utf8')).toBe('connect with ***');
    for (const file of [...readdirSync(recordDir).filter((name) => !name.endsWith('.logs')).map((name) => join(recordDir, name)), join(logs, 'a.log')]) {
      expect(readFileSync(file, 'utf8')).not.toContain('pw-value-123');
    }
  });

  it('still writes the record after an interrupt, listing the later checks as not run, and exits 1', async () => {
    const controller = new AbortController();
    const { deps, recordDir, records, readJson } = setup([fakeCheck('a', {}, () => controller.abort()), fakeCheck('b')], { controller });
    expect(await runRelease(['--record-dir', recordDir], deps)).toBe(EXIT_FAILED);
    const checks = readJson(records()[0] ?? '')['checks'] as { id: string; detail: string }[];
    expect(checks.map((check) => check.detail)).toEqual(['interrupted', 'not run: interrupted']);
  });
});

describe('runRelease details', () => {
  it('keeps the commands of the record whole when the login name is a common word, and still masks the password', async () => {
    const check = fakeCheck('a', { command: 'pnpm --filter @neburyx/test-neo4j build', output: 'neo4j pw-value-123', detail: 'neo4j ok', data: { baseImages: [{ name: 'neo4j:5.26' }], leaked: 'pw-value-123' } });
    const { deps, recordDir, records, readJson } = setup([check]);
    await runRelease(['--record-dir', recordDir], { ...deps, env: { NBX_EE_USER: 'neo4j', NBX_EE_PASSWORD: 'pw-value-123' } });
    const checks = readJson(records()[0] ?? '')['checks'] as { command: string }[];
    expect(checks[0]?.command).toBe('pnpm --filter @neburyx/test-neo4j build');
    const logs = join(recordDir, (records()[0] ?? '').replace('.json', '.logs'));
    expect(readFileSync(join(logs, 'a.log'), 'utf8')).toBe('*** ***');
    const record = readFileSync(join(recordDir, records()[0] ?? ''), 'utf8');
    expect(record).toContain('neo4j:5.26');
    expect(record).not.toContain('pw-value-123');
    expect(record).toContain('*** ok');
  });

  it('resolves a relative record folder against the folder the command was run from, as pnpm reports it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'release-cwd-'));
    const { deps, records } = setup([fakeCheck('a')]);
    expect(await runRelease(['--record-dir', 'out'], { ...deps, env: { INIT_CWD: parent } })).toBe(EXIT_PASSED);
    expect(readdirSync(join(parent, 'out')).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    void records;
  });

  it('shows the figures a check recorded under the checks table, as the person reads the record', async () => {
    const { deps, recordDir, records } = setup([fakeCheck('a', { data: { elapsedMs: 123, clock: 'starts here, stops there' } })]);
    await runRelease(['--record-dir', recordDir], deps);
    const markdown = readFileSync(join(recordDir, (records()[0] ?? '').replace('.json', '.md')), 'utf8');
    expect(markdown).toContain('## a');
    expect(markdown).toContain('"elapsedMs": 123');
    expect(markdown).toContain('starts here, stops there');
  });
});

describe('runRelease secrets', () => {
  it('masks the connection values read from the settings file, which are not in the environment', async () => {
    const { deps, recordDir, records } = setup([fakeCheck('a', { output: 'login file-secret-77' })]);
    await runRelease(['--record-dir', recordDir], { ...deps, extraSecrets: ['file-secret-77'] });
    const logs = join(recordDir, (records()[0] ?? '').replace('.json', '.logs'));
    expect(readFileSync(join(logs, 'a.log'), 'utf8')).toBe('login ***');
  });
});

describe('runRelease record lines', () => {
  it('writes exactly one Commit line with the full 40-character commit and one Result line, PASS or FAIL', async () => {
    for (const [checks, expected] of [[[fakeCheck('a')], 'PASS'], [[fakeCheck('a', { status: 'failed', detail: 'x', exitCode: 1 })], 'FAIL']] as const) {
      const { deps, recordDir, records } = setup(checks);
      await runRelease(['--record-dir', recordDir], deps);
      const markdown = readFileSync(join(recordDir, (records()[0] ?? '').replace('.json', '.md')), 'utf8');
      expect(markdown.match(/^Commit: .*$/gm)).toEqual([`Commit: ${COMMIT}`]);
      expect(markdown.match(/^Result: .*$/gm)).toEqual([`Result: ${expected}`]);
      expect(readFileSync(join(recordDir, records()[0] ?? ''), 'utf8')).toContain(`"result": "${expected}"`);
    }
  });

  it('exits 2 when the commit cannot be read as 40 hexadecimal characters', async () => {
    const { deps, recordDir, err } = setup([fakeCheck('a')]);
    const broken = { ...deps, exec: fakeExec((request) => (request.args[0] === 'rev-parse' ? execResult({ exitCode: 128 }) : execResult())).exec };
    expect(await runRelease(['--record-dir', recordDir, '--dry-run'], broken)).toBe(EXIT_USAGE);
    expect(err.join('')).toContain('cannot read the commit');
  });
});

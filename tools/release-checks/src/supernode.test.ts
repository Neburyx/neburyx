import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuzzRealServerCheck, supernodeSuiteCheck } from './supernode.js';
import { execResult, fakeExec } from './testing.js';
import type { CheckContext, ExecRequest, ExecResult } from './types.js';

const NO_FILE = join(tmpdir(), 'no-such-settings-file.env');
const CONNECTION = { NBX_EE_URI: 'bolt://neo4j.example:7687', NBX_EE_USER: 'reader', NBX_EE_PASSWORD: 'pw-for-test' };

function context(exec: CheckContext['exec'], env: Record<string, string> = CONNECTION): CheckContext & { readonly repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'super-repo-'));
  return { exec, signal: new AbortController().signal, repoRoot, commit: 'abcdef0', monotonicNowMs: () => 0, workDir: mkdtempSync(join(tmpdir(), 'super-work-')), env };
}

describe('the Neo4j checks without a connection', () => {
  const noConnection = fakeExec(() => execResult());
  for (const [name, check] of [
    ['supernode-suite', supernodeSuiteCheck(NO_FILE)],
    ['fuzz-real-server', fuzzRealServerCheck('/repo', NO_FILE)],
  ] as const) {
    it(`fails ${name} naming the missing settings and never a value, and starts nothing`, async () => {
      const outcome = await check.run(context(noConnection.exec, { NBX_EE_URI: 'bolt://x:7687' }));
      expect(outcome).toMatchObject({ status: 'failed', detail: 'Neo4j connection not set: NBX_EE_USER, NBX_EE_PASSWORD' });
      expect(outcome.output).not.toContain('bolt://x');
      expect(noConnection.requests).toEqual([]);
    });
  }
});

describe('supernodeSuiteCheck', () => {
  const summary = ' Test Files  1 passed (1)\n      Tests  6 passed (6)\n';
  const run = (answer: (request: ExecRequest) => ExecResult) => {
    const fake = fakeExec(answer);
    const ctx = context(fake.exec);
    return { fake, ctx, outcome: () => supernodeSuiteCheck(NO_FILE).run(ctx) };
  };

  it('passes the record file to the suite and passes when the suite exits 0 and wrote it', async () => {
    const { fake, ctx, outcome } = run((request) => {
      const file = request.env?.['NBX_SUPERNODE_RECORD'];
      if (file !== undefined) writeFileSync(file, '[]');
      return execResult({ output: summary });
    });
    expect(await outcome()).toMatchObject({ status: 'passed' });
    expect(fake.requests[0]?.env?.['NBX_SUPERNODE_RECORD']).toBe(join(ctx.workDir, 'supernode-suite-record.json'));
  });

  it('fails when the suite exits 0 but wrote no record', async () => {
    expect(await run(() => execResult({ output: summary })).outcome()).toMatchObject({ status: 'failed', detail: 'no suite record written' });
  });

  it('fails when the suite exits non-zero', async () => {
    expect(await run(() => execResult({ exitCode: 1 })).outcome()).toMatchObject({ status: 'failed', detail: 'exited with code 1' });
  });
});

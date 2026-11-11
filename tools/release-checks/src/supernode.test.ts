import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fuzzRealServerCheck, judgeBenchmark, supernodeBenchmarkCheck, supernodeSuiteCheck, type BenchmarkReport } from './supernode.js';
import { execResult, fakeExec } from './testing.js';
import type { CheckContext, ExecRequest, ExecResult } from './types.js';

const NO_FILE = join(tmpdir(), 'no-such-settings-file.env');
const CONNECTION = { NBX_EE_URI: 'bolt://neo4j.example:7687', NBX_EE_USER: 'reader', NBX_EE_PASSWORD: 'pw-for-test' };

const cell = (overrides: Partial<BenchmarkReport['cells'][number]> = {}): BenchmarkReport['cells'][number] => ({ size: 100_000, readSet: 'dated', position: 'first', samples: 30, failures: 0, p95: 1000, ...overrides });
const report = (cells: BenchmarkReport['cells'], stopped: BenchmarkReport['stopped'] = []): BenchmarkReport => ({ date: '2026-11-11', commit: 'abc1234', neo4j: { version: '5.26.0', edition: 'enterprise' }, cells, stopped });

function context(exec: CheckContext['exec'], env: Record<string, string> = CONNECTION): CheckContext & { readonly repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'super-repo-'));
  mkdirSync(join(repoRoot, 'docs', 'benchmarks'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs', 'benchmarks', 'supernode.json'), '{"committed":true}');
  return { exec, signal: new AbortController().signal, repoRoot, commit: 'abcdef0', monotonicNowMs: () => 0, workDir: mkdtempSync(join(tmpdir(), 'super-work-')), env };
}

const verdictFixtures = z
  .array(
    z.object({
      name: z.string(),
      cells: z.array(z.object({ size: z.number(), readSet: z.string(), position: z.string(), samples: z.number(), failures: z.number(), p95: z.number() })),
      stopped: z.array(z.object({ size: z.number(), readSet: z.string() })),
      expected: z.object({ met: z.boolean(), worstP95: z.number(), overLimit: z.array(z.string()).optional(), lowerBound: z.array(z.string()).optional(), stopped: z.array(z.string()).optional() }),
    }),
  )
  .parse(JSON.parse(readFileSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'fixtures', 'benchmark-verdicts.json'), 'utf8')));

describe('judgeBenchmark against the fixtures the benchmark record code is also tested with', () => {
  for (const fixture of verdictFixtures) {
    it(fixture.name, () => {
      const verdict = judgeBenchmark(report(fixture.cells, fixture.stopped));
      expect(verdict?.met).toBe(fixture.expected.met);
      expect(verdict?.worstP95Ms).toBe(fixture.expected.worstP95);
      expect(verdict?.overLimit.map((cell) => `${cell.readSet}/${cell.position}`)).toEqual(fixture.expected.overLimit ?? []);
      expect(verdict?.lowerBound.map((cell) => `${cell.readSet}/${cell.position}`)).toEqual(fixture.expected.lowerBound ?? []);
      expect(verdict?.stopped).toEqual(fixture.expected.stopped ?? []);
    });
  }
});

describe('judgeBenchmark', () => {
  it('is met when every cell at 100,000 is under the limit', () => {
    expect(judgeBenchmark(report([cell({ p95: 2999 })]))).toMatchObject({ met: true, worstP95Ms: 2999 });
  });

  it('is not met at exactly the limit, because the limit is "under 3,000 ms"', () => {
    expect(judgeBenchmark(report([cell({ p95: 3000 })]))).toMatchObject({ met: false, overLimit: [{ readSet: 'dated', position: 'first', p95: 3000 }] });
  });

  it('names the worst cell among several, and ignores smaller sizes', () => {
    const verdict = judgeBenchmark(report([cell({ p95: 500 }), cell({ readSet: 'all', position: '90%', p95: 2000 }), cell({ size: 1000, p95: 9000 })]));
    expect(verdict).toMatchObject({ met: true, worstP95Ms: 2000, worst: { readSet: 'all', position: '90%' } });
  });

  it('is not met when a cell rests on failed calls, more than one in twenty samples', () => {
    expect(judgeBenchmark(report([cell({ failures: 2, samples: 30 })]))).toMatchObject({ met: false, lowerBound: [{ readSet: 'dated', position: 'first' }] });
    expect(judgeBenchmark(report([cell({ failures: 1, samples: 20 })]))?.met).toBe(true);
  });

  it('is not met when a walk at 100,000 stopped early', () => {
    expect(judgeBenchmark(report([cell()], [{ size: 100_000, readSet: 'plain' }]))).toMatchObject({ met: false, stopped: ['plain'] });
  });

  it('has no verdict when the run holds no cell at 100,000', () => {
    expect(judgeBenchmark(report([cell({ size: 1000 })]))).toBeUndefined();
  });

  it('gives the verdict the committed benchmark record states', () => {
    const file = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'docs', 'benchmarks', 'supernode.json');
    const verdict = judgeBenchmark(JSON.parse(readFileSync(file, 'utf8')));
    expect(verdict?.met).toBe(true);
    expect(Math.round(verdict?.worstP95Ms ?? 0)).toBe(1480);
  });
});

describe('the Neo4j checks without a connection', () => {
  const noConnection = fakeExec(() => execResult());
  for (const [name, check] of [
    ['supernode-suite', supernodeSuiteCheck(NO_FILE)],
    ['fuzz-real-server', fuzzRealServerCheck('/repo', NO_FILE)],
    ['supernode-benchmark', supernodeBenchmarkCheck(NO_FILE)],
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

describe('supernodeBenchmarkCheck', () => {
  const write = (request: ExecRequest, content: unknown): void => {
    const dir = request.env?.['NBX_BENCH_RECORD_DIR'];
    if (dir === undefined) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'supernode.json'), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const outcomeOf = (answer: (request: ExecRequest) => ExecResult) => supernodeBenchmarkCheck(NO_FILE).run(context(fakeExec(answer).exec));

  it('passes under the limit, and records the figures, the server, the commit and the date', async () => {
    const outcome = await outcomeOf((request) => {
      write(request, report([cell({ p95: 1480 })]));
      return execResult();
    });
    expect(outcome).toMatchObject({ status: 'passed', detail: 'worst p95 1480 ms (dated, first), limit 3000 ms' });
    expect(outcome.data).toMatchObject({ worstP95Ms: 1480, neo4j: { version: '5.26.0' }, commit: 'abc1234', date: '2026-11-11', committedRecordUnchanged: true });
  });

  it('fails over the limit, names the cells, and still records the figures', async () => {
    const outcome = await outcomeOf((request) => {
      write(request, report([cell({ p95: 4100 })]));
      return execResult();
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('over the limit: dated, first, 4100 ms');
    expect(outcome.data).toMatchObject({ worstP95Ms: 4100, met: false });
  });

  it('fails with no benchmark record when the file is missing, unparseable or not the data of a run', async () => {
    for (const content of [undefined, 'not json', { cells: [] }]) {
      const outcome = await outcomeOf((request) => {
        if (content !== undefined) write(request, content);
        return execResult();
      });
      expect(outcome).toMatchObject({ status: 'failed', detail: 'no benchmark record' });
    }
  });

  it('fails when the committed benchmark files change during the run', async () => {
    const fake = fakeExec(() => execResult());
    const ctx = context(fake.exec);
    const changing = { ...ctx, exec: (request: ExecRequest) => {
      write(request, report([cell()]));
      writeFileSync(join(ctx.repoRoot, 'docs', 'benchmarks', 'supernode.json'), '{"changed":true}');
      return Promise.resolve(execResult());
    } };
    expect(await supernodeBenchmarkCheck(NO_FILE).run(changing)).toMatchObject({ status: 'failed', detail: 'the files of docs/benchmarks changed during the run' });
  });

  it('fails when the benchmark exits non-zero, keeping any figures it wrote', async () => {
    const outcome = await outcomeOf((request) => {
      write(request, report([cell()]));
      return execResult({ exitCode: 1 });
    });
    expect(outcome).toMatchObject({ status: 'failed', detail: 'exited with code 1' });
  });
});

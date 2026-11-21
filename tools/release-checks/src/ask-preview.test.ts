import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_PREVIEW_CHECK_IDS, askAccuracyCheck, askPreviewCatalogue, askPreviewCriteria, assistantRouteAccuracyCheck } from './ask-preview.js';
import type { Files } from './files.js';
import { CHECK_IDS, catalogueFor, releaseCatalogue } from './catalogue.js';
import { runRelease, type RunDeps } from './run.js';
import { execResult, fakeExec, testContext } from './testing.js';
import type { ExecRequest, ExecResult } from './types.js';

const ASK = { model: 'claude-haiku-5-5', refusals: { total: 7, refused: 7 }, plans: { total: 28, right: 28, allowedMisses: 2 }, scripted: false, targetsMet: true };
const ASSISTANT = (model: string, right: number) => ({ model, refusals: { total: 27, refused: 27 }, plans: { total: 159, right, allowedMisses: 12 }, scripted: false, targetsMet: true });
const baseline = (model: string, refusals: number, plans: number): string => JSON.stringify({ replay: { model, questions: 'a'.repeat(64), refusals, plans } });
const BUILD = 'tools/ask-eval build$ tsc -p tsconfig.build.json\ntools/ask-eval build: Done\n';
const reply = (score: unknown): ExecResult => execResult({ output: `${BUILD}${JSON.stringify(score)}\n` });

/** The files of a checkout that holds Ask's baseline and the assistant's, by path. */
function files(held: Record<string, string>, models: readonly string[] = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'scripted']): Files {
  return {
    readText: (path) => (path in held ? Promise.resolve(held[path] ?? '') : Promise.reject(new Error('no such file'))),
    folders: () => Promise.resolve(models),
  };
}
const ASK_BASELINE = '/repo/tools/ask-eval/data/baseline.json';
const ASSISTANT_BASELINE = (model: string) => `/repo/tools/ask-eval/data/assistant/${model}/baseline.json`;

describe('the check of Ask’s accuracy (C1)', () => {
  const run = (score: ExecResult, held: Record<string, string>) => askAccuracyCheck(files(held)).run(testContext(fakeExec(() => score).exec));

  it('passes a score that meets the targets and the baseline, and holds its figures and the baseline’s', async () => {
    const outcome = await run(reply(ASK), { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) });
    expect(outcome.status).toBe('passed');
    expect(outcome.data).toMatchObject({ model: 'claude-haiku-5-5', refusals: { refused: 7, total: 7 }, plans: { right: 28, total: 28 }, baseline: { refusals: 7, plans: 28 } });
    expect((outcome.data as { figure: string }).figure).toContain('plans 28 of 28 (100.0%), at most 2 may miss; baseline refusals 7, plans 28');
  });

  it('fails when the tool says the targets are not met, with its figures', async () => {
    const outcome = await run(reply({ ...ASK, plans: { total: 28, right: 20, allowedMisses: 2 }, targetsMet: false }), { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('the targets of the evaluation tool are not met');
  });

  it('fails when the counts are below the baseline although the targets are met', async () => {
    const outcome = await run(reply({ ...ASK, plans: { total: 28, right: 27, allowedMisses: 2 } }), { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.detail).toContain('below the baseline');
  });

  it('fails with the tool’s reason when it refuses the replay, as for another classification text', async () => {
    const outcome = await run(execResult({ exitCode: 2, output: `${BUILD}the replay was recorded for another classification text of banking-demo\n` }), { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('another classification text');
  });

  it('fails when the baseline holds no value, as a file of `{}` does, and when it is not there or is made for another model', async () => {
    expect((await run(reply(ASK), { [ASK_BASELINE]: '{}' })).detail).toContain('the baseline holds no value');
    expect((await run(reply(ASK), {})).detail).toContain('no baseline file');
    expect((await run(reply(ASK), { [ASK_BASELINE]: baseline('another-model', 7, 28) })).detail).toContain('made for another-model');
  });

  it('fails a scripted replay, which is no measurement', async () => {
    const outcome = await run(reply({ ...ASK, scripted: true }), { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('scripted');
  });
});

describe('the check of the assistant’s route accuracy (C5)', () => {
  const scoring = (scores: Record<string, unknown>) => (request: ExecRequest) => {
    const model = request.args[request.args.indexOf('--replay') + 1]?.split('/').at(-2) ?? '';
    return reply(scores[model]);
  };
  const run = (scores: Record<string, unknown>, held: Record<string, string>, models?: readonly string[]) => assistantRouteAccuracyCheck(files(held, models)).run(testContext(fakeExec(scoring(scores)).exec));
  const held = { [ASSISTANT_BASELINE('claude-haiku-5-5')]: baseline('claude-haiku-5-5', 27, 148), [ASSISTANT_BASELINE('claude-sonnet-5-5')]: baseline('claude-sonnet-5-5', 27, 156) };
  const scores = { 'claude-haiku-5-5': ASSISTANT('claude-haiku-5-5', 148), 'claude-sonnet-5-5': ASSISTANT('claude-sonnet-5-5', 156) };

  it('runs each model folder but the scripted one and passes when each meets its baseline, with the figures of each model', async () => {
    const outcome = await run(scores, held);
    expect(outcome.status).toBe('passed');
    expect(outcome.data).toMatchObject({ models: [{ model: 'claude-haiku-5-5' }, { model: 'claude-sonnet-5-5' }] });
    expect((outcome.data as { figure: string }).figure).toContain('claude-haiku-5-5: refusals 27 of 27, plans 148 of 159 (93.1%)');
  });

  it('fails when one model is below its baseline, naming it', async () => {
    const outcome = await run({ ...scores, 'claude-sonnet-5-5': ASSISTANT('claude-sonnet-5-5', 150) }, held);
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('claude-sonnet-5-5: the counts are below the baseline');
  });

  it('fails a model folder with no baseline and one whose baseline holds no value', async () => {
    expect((await run(scores, { [ASSISTANT_BASELINE('claude-haiku-5-5')]: held[ASSISTANT_BASELINE('claude-haiku-5-5')] ?? '' })).detail).toContain('claude-sonnet-5-5: no baseline file');
    expect((await run(scores, { ...held, [ASSISTANT_BASELINE('claude-sonnet-5-5')]: '{}' })).detail).toContain('claude-sonnet-5-5: the baseline holds no value');
  });

  it('fails when no model replay is committed', async () => {
    expect((await run(scores, held, ['scripted'])).detail).toContain('no model replay');
  });
});

describe('the gate-2 catalogue and its record', () => {
  it('is the gate-2 one for `ask-preview`, with gate 1 unchanged', () => {
    expect(catalogueFor('ask-preview', '/repo').map((check) => check.id)).toEqual([...ASK_PREVIEW_CHECK_IDS]);
    expect(catalogueFor('v0.1', '/repo').map((check) => check.id)).toEqual([...CHECK_IDS]);
    expect(releaseCatalogue('/repo').map((check) => check.id)).toEqual([...CHECK_IDS]);
  });

  it('writes a record with a criteria table whose rows hold the status and the figure, and a Result line judged on the checks', async () => {
    const held = { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28), [ASSISTANT_BASELINE('claude-haiku-5-5')]: baseline('claude-haiku-5-5', 27, 148) };
    const answers = (request: ExecRequest): ExecResult => {
      if (request.command === 'git' && request.args[0] === 'rev-parse') return execResult({ output: `${'a'.repeat(40)}\n` });
      if (request.command === 'git') return execResult({ output: '' });
      if (request.command === 'pnpm' && request.args[0] === 'ask-eval') return reply(request.args[1] === 'assistant' ? ASSISTANT('claude-haiku-5-5', 148) : ASK);
      return execResult({ output: '1.0.0\n' });
    };
    const recordDir = mkdtempSync(join(tmpdir(), 'gate-two-'));
    const out: string[] = [];
    const deps: RunDeps = {
      exec: fakeExec(answers).exec,
      signal: new AbortController().signal,
      repoRoot: '/repo',
      env: {},
      clock: () => new Date(Date.UTC(2026, 10, 21, 8, 0, 0)),
      monotonicNowMs: () => 0,
      out: (text) => out.push(text),
      err: () => undefined,
      catalogue: () => [askAccuracyCheck(files(held)), assistantRouteAccuracyCheck(files(held, ['claude-haiku-5-5']))],
      criteria: (_gate, results) => askPreviewCriteria(results),
    };
    expect(await runRelease(['--record-dir', recordDir, '--gate', 'ask-preview', '--dry-run'], deps)).toBe(0);
    const markdown = readFileSync(join(recordDir, readdirSync(recordDir).find((name) => name.endsWith('.md')) ?? ''), 'utf8');
    expect(markdown).toContain('# Release checks (ask-preview)');
    expect(markdown).toContain('Result: PASS');
    expect(markdown).toMatch(/\| C1 \| Ask meets the targets .* \| passed \| Ask \(claude-haiku-5-5\): refusals 7 of 7, plans 28 of 28 \(100\.0%\)/);
    expect(markdown).toMatch(/\| C5 \| Assistant route accuracy meets its baseline \| passed \| /);
    const json = JSON.parse(readFileSync(join(recordDir, readdirSync(recordDir).find((name) => name.endsWith('.json')) ?? ''), 'utf8')) as { criteria: { id: string; status: string }[]; gate: string };
    expect(json.gate).toBe('ask-preview');
    expect(json.criteria.map((criterion) => [criterion.id, criterion.status])).toEqual([['C1', 'passed'], ['C5', 'passed']]);
  });

  it('shows a criterion as failed when a check it rests on failed, and says so in the Result line', async () => {
    const criteria = askPreviewCriteria([{ id: 'ask-accuracy', name: 'x', command: 'c', status: 'failed', exitCode: 1, durationMs: 1, detail: 'Ask: the targets of the evaluation tool are not met', log: '' }, { id: 'assistant-route-accuracy', name: 'y', command: 'c', status: 'passed', exitCode: 0, durationMs: 1, detail: 'ok', log: '', data: { figure: 'f' } }]);
    expect(criteria.map((criterion) => [criterion.id, criterion.status])).toEqual([['C1', 'failed'], ['C5', 'passed']]);
    expect(criteria[0]?.figure).toContain('not met');
  });
});

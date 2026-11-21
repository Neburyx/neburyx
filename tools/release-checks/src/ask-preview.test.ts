import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  it('names every check id of the gate in the tool guide', () => {
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../README.md'), 'utf8');
    for (const id of ASK_PREVIEW_CHECK_IDS) expect(guide, id).toContain(`\`${id}\``);
  });

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

describe('a cut feature drops its criteria', () => {
  const result = (id: string, status: 'passed' | 'failed' = 'passed') => ({ id, name: id, command: 'c', status, exitCode: 0, durationMs: 1, detail: 'ok', log: '', data: { figure: `figure of ${id}` } });
  const ALL = ['ask-accuracy', 'ask-safety', 'ask-safety-read-transaction', 'ask-cited-summary', 'summary-suites', 'assistant-replies', 'assistant-route-accuracy', 'any-source'];
  const ids = (cut: readonly ('summary' | 'assistant')[]) => askPreviewCatalogue(undefined, undefined, cut).map((check) => check.id);
  const shown = (cut: readonly ('summary' | 'assistant')[]) => askPreviewCriteria(ids(cut).map((id) => result(id)), cut).map((criterion) => [criterion.id, criterion.status]);

  it('runs every check and states every criterion when no feature is cut', () => {
    expect(ids([])).toEqual(ALL);
    expect(shown([])).toEqual([['C1', 'passed'], ['C2', 'passed'], ['C3', 'passed'], ['C4', 'passed'], ['C5', 'passed'], ['C6', 'passed']]);
    expect(askPreviewCriteria(ALL.map((id) => result(id))).some((criterion) => criterion.dropped !== undefined)).toBe(false);
  });

  it('drops the summary part of C4 and keeps the criterion on its assistant part, naming what was dropped', () => {
    expect(ids(['summary'])).toEqual(ALL.filter((id) => id !== 'summary-suites'));
    const c4 = askPreviewCriteria(ids(['summary']).map((id) => result(id)), ['summary']).find((criterion) => criterion.id === 'C4');
    expect(c4).toMatchObject({ status: 'passed', checks: ['assistant-replies'], dropped: ['the AI case summary part: the feature is cut'] });
    expect(c4?.figure).toContain('dropped: the AI case summary part: the feature is cut');
  });

  it('drops C5 and the assistant part of C4 when the assistant is cut, and C4 and C5 both when both are cut, leaving C1, C2, C3 and C6 as they were', () => {
    expect(ids(['assistant'])).toEqual(ALL.filter((id) => id !== 'assistant-replies' && id !== 'assistant-route-accuracy'));
    expect(shown(['assistant'])).toEqual([['C1', 'passed'], ['C2', 'passed'], ['C3', 'passed'], ['C4', 'passed'], ['C5', 'dropped'], ['C6', 'passed']]);
    expect(ids(['summary', 'assistant'])).toEqual(['ask-accuracy', 'ask-safety', 'ask-safety-read-transaction', 'ask-cited-summary', 'any-source']);
    expect(shown(['summary', 'assistant'])).toEqual([['C1', 'passed'], ['C2', 'passed'], ['C3', 'passed'], ['C4', 'dropped'], ['C5', 'dropped'], ['C6', 'passed']]);
  });

  it('never counts a dropped criterion as passed, and judges what remains: a failed check of a kept criterion fails it', () => {
    const results = ids(['assistant']).map((id) => result(id, id === 'any-source' ? 'failed' : 'passed'));
    expect(askPreviewCriteria(results, ['assistant']).map((criterion) => [criterion.id, criterion.status])).toEqual([['C1', 'passed'], ['C2', 'passed'], ['C3', 'passed'], ['C4', 'passed'], ['C5', 'dropped'], ['C6', 'failed']]);
  });

  it('says in the first lines of the record that no criterion was dropped, or which were, and a Result that does not count them', async () => {
    const held = { [ASK_BASELINE]: baseline('claude-haiku-5-5', 7, 28) };
    const recordFor = async (cut: readonly string[]) => {
      const recordDir = mkdtempSync(join(tmpdir(), 'gate-cut-'));
      const deps: RunDeps = {
        exec: fakeExec((request) => (request.command === 'git' && request.args[0] === 'rev-parse' ? execResult({ output: `${'a'.repeat(40)}\n` }) : request.command === 'git' ? execResult({ output: '' }) : request.command === 'pnpm' && request.args[0] === 'ask-eval' ? reply(ASK) : execResult({ output: '1.0.0\n' }))).exec,
        signal: new AbortController().signal,
        repoRoot: '/repo',
        env: {},
        clock: () => new Date(Date.UTC(2026, 10, 21, 8, 0, 0)),
        monotonicNowMs: () => 0,
        out: () => undefined,
        err: () => undefined,
        catalogue: () => [askAccuracyCheck(files(held))],
        criteria: (_gate, results, kept) => askPreviewCriteria(results, kept),
      };
      expect(await runRelease(['--record-dir', recordDir, '--gate', 'ask-preview', '--dry-run', ...cut.flatMap((feature) => ['--cut', feature])], deps)).toBe(0);
      return readFileSync(join(recordDir, readdirSync(recordDir).find((name) => name.endsWith('.md')) ?? ''), 'utf8');
    };
    const none = await recordFor([]);
    expect(none.split('\n').slice(0, 9).join('\n')).toContain('No criterion was dropped.');
    const both = await recordFor(['summary', 'assistant']);
    const first = both.split('\n').slice(0, 9).join('\n');
    expect(first).toContain('Result: PASS');
    expect(first).toContain('Dropped criteria: C4 (the AI case summary part: the feature is cut, the assistant part: the feature is cut); C5 (the assistant part: the feature is cut). A dropped criterion is not counted as passed.');
    expect(both).toMatch(/\| C5 \| .* \| dropped \| dropped: the feature is cut \|/);
    const private_ = [['E', 'P-'], ['D', 'W'], ['G', '2'], ['fou', 'nder'], ['orchest', 'rator']].map((parts) => parts.join(''));
    for (const text of [none, both]) for (const word of private_) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
  });
});


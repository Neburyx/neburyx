import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLedger, createRecorder } from '../../../ee/ask/dist/eval/record.js';
import { COMMON_WORDS_VERSION } from '../../../ee/ask/src/allowlist/index.js';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { BUILT_IN_PROMPTS, buildPromptRegistry } from '../../../ee/ask/src/prompts.js';
import { createFixtureProvider, replyKey, type FixtureReply, type FixtureReplySource } from '../../../ee/ask/src/testing/fixture.js';
import { EXIT_MISS, EXIT_OK, EXIT_USAGE, runCli } from './cli.js';
import type { PlannerModule } from './types.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MAPPING = join(ROOT, 'domain-packs', 'banking-fraud', 'neburyx.yaml');
const dirs: string[] = [];

const planReply = JSON.stringify({ kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'account', stableId: '‹account#1›' } }, rationale: 'It names one.' });
const refusalReply = JSON.stringify({ kind: 'unsupported', family: 'judgement', reason: 'No.' });

const QUESTIONS = `questions:
  - id: show-entity
    wording: Show me ‹account#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }
  - id: judgement
    wording: Is ‹account#1› fraudulent?
    expect: { kind: unsupported }
  - id: blocked-one
    wording: Show me zzxqvk about ‹account#1›.
    expect: { kind: blocked }
`;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-record-'));
  dirs.push(dir);
  return dir;
}

function questionFile(): string {
  const path = join(folder(), 'questions.yaml');
  writeFileSync(path, QUESTIONS);
  return path;
}

async function moduleOver(plan: FixtureReplySource, repair: FixtureReplySource = plan) {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new Error('prompts');
  const provider = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', BUILT_IN_PROMPTS['ask.plan'].version)]: plan, [replyKey('ask.plan.repair', BUILT_IN_PROMPTS['ask.plan.repair'].version)]: repair } });
  const module: PlannerModule = { createEvalPlanner, recording: { createLedger, createRecorder: (options) => createRecorder(options as never), provider: async () => ({ provider, model: 'fixture-model' }) } };
  return { module, provider };
}

async function cli(args: readonly string[], module: PlannerModule) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args], { out: (line) => void out.push(line), err: (line) => void err.push(line) }, module);
  return { code, out, err };
}

const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 3, outputTokens: 2 } });
const args = (questions: string, extra: readonly string[]) => ['record', '--questions', questions, '--mapping', MAPPING, ...extra];

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('ask-eval record', () => {
  it('records the replies of an external file, writes the replay with mode 0600 outside the checkout, and the replay scores with the runner', async () => {
    const byQuestion = (request: { readonly parameters: Readonly<Record<string, string | number>> }): FixtureReply => ok(String(request.parameters['question']).includes('fraudulent') ? refusalReply : planReply);
    const { module, provider } = await moduleOver(byQuestion);
    const questions = questionFile();
    const out = folder();
    const answered = await cli(args(questions, ['--budget', '5', '--out', out]), module);
    expect(answered.code).toBe(EXIT_OK);
    expect(answered.out.slice(0, 2)).toEqual(['recorded: 2 of 2 questions', 'calls: 2 of 5']);
    expect(answered.out.slice(2)).toEqual(['model: fixture-model', `prompts: ask.plan@${BUILT_IN_PROMPTS['ask.plan'].version}`, `list: ${COMMON_WORDS_VERSION}`, 'tokens: in 6, out 4, cache read 0, cache write 0, calls without counts 0']);
    expect(provider.calls).toHaveLength(2);
    const file = join(out, 'recording.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toHaveLength(2);
    const scored = await cli(['--questions', questions, '--replay', file, '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '1'], module);
    expect(scored.out.slice(0, 2)).toEqual(['refusals: 1 of 1 refused', 'plans: 1 of 1 right (at most 1 may miss)']);
  });

  it.each([
    ['no budget', ['--out', '$OUT']],
    ['a budget of zero', ['--budget', '0', '--out', '$OUT']],
    ['a budget that is not a number', ['--budget', 'many', '--out', '$OUT']],
    ['a budget with a decimal', ['--budget', '2.5', '--out', '$OUT']],
    ['no out folder', ['--budget', '3']],
    ['an out folder inside the checkout', ['--budget', '3', '--out', join(ROOT, 'tools', 'ask-eval', 'out')]],
  ])('refuses %s with exit 2 before any call', async (_name, extra) => {
    const { module, provider } = await moduleOver(ok(planReply));
    const out = folder();
    const result = await cli(args(questionFile(), extra.map((part) => (part === '$OUT' ? out : part))), module);
    expect(result.code).toBe(EXIT_USAGE);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses a question file inside the checkout other than the demo file', async () => {
    const { module, provider } = await moduleOver(ok(planReply));
    const inside = join(ROOT, 'tools', 'ask-eval', 'questions-not-allowed.yaml');
    const result = await cli(args(inside, ['--budget', '3', '--out', folder()]), module);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join(' ')).toContain('inside the checkout');
    expect(provider.calls).toHaveLength(0);
  });

  it('stops before the call that would pass the budget, says so, exits 1, and records only the questions fully answered', async () => {
    const { module, provider } = await moduleOver(ok('not a plan'));
    const out = folder();
    const result = await cli(args(questionFile(), ['--budget', '3', '--out', out]), module);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out.slice(0, 3)).toEqual(['recorded: 1 of 2 questions', 'calls: 3 of 3', 'stopped: the call budget was reached']);
    expect(provider.calls).toHaveLength(3);
    expect(Object.keys(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')))).toHaveLength(1);
  });

  it('counts a failed call, does not retry it, and names the question and the code only', async () => {
    const { module, provider } = await moduleOver({ kind: 'failed', code: 'rate-limited' });
    const result = await cli(args(questionFile(), ['--budget', '10', '--out', folder()]), module);
    expect(result.code).toBe(EXIT_MISS);
    expect(provider.calls).toHaveLength(2);
    expect(result.out.slice(0, 4)).toEqual(['recorded: 0 of 2 questions', 'calls: 2 of 10', 'failed: show-entity (rate-limited)', 'failed: judgement (rate-limited)']);
  });

  it('records a refusal of the model, and it scores as a refusal when the replay is scored', async () => {
    const { module } = await moduleOver({ kind: 'refused', usage: { kind: 'unknown' } });
    const questions = questionFile();
    const out = folder();
    const result = await cli(args(questions, ['--budget', '10', '--out', out]), module);
    expect(result.out[0]).toBe('recorded: 2 of 2 questions');
    const scored = await cli(['--questions', questions, '--replay', join(out, 'recording.json'), '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '1'], module);
    expect(scored.out[0]).toBe('refusals: 1 of 1 refused');
  });

  it('prints no wording and no reply, for the failure case or the passing one', async () => {
    for (const reply of [ok(planReply), { kind: 'failed', code: 'bad-reply' } as FixtureReply]) {
      const { module } = await moduleOver(reply);
      const result = await cli(args(questionFile(), ['--budget', '10', '--out', folder()]), module);
      const text = [...result.out, ...result.err].join('\n');
      for (const word of ['Show me', 'fraudulent', 'account#1', 'rationale', 'templateId']) expect(text).not.toContain(word);
    }
  });

  it('refuses to replace an existing recording without --force, and replaces it with --force', async () => {
    const { module } = await moduleOver(ok(planReply));
    const questions = questionFile();
    const out = folder();
    expect((await cli(args(questions, ['--budget', '5', '--out', out]), module)).code).toBe(EXIT_OK);
    const again = await cli(args(questions, ['--budget', '5', '--out', out]), module);
    expect(again.code).toBe(EXIT_USAGE);
    expect(again.err.join(' ')).toContain('--force');
    expect((await cli(args(questions, ['--budget', '5', '--out', out, '--force']), module)).code).toBe(EXIT_OK);
  });

  it('hands an ai settings file to the provider, and refuses one inside the checkout', async () => {
    const { module } = await moduleOver(ok(planReply));
    const seen: unknown[] = [];
    const inner = module.recording;
    if (inner === undefined) throw new Error('no recording module');
    const wrapped: PlannerModule = { ...module, recording: { ...inner, provider: async (options) => (seen.push(options), inner.provider(options)) } };
    const ai = join(folder(), 'ai.yaml');
    writeFileSync(ai, 'ai:\n  provider: anthropic\n');
    expect((await cli(args(questionFile(), ['--budget', '5', '--out', folder(), '--ai', ai]), wrapped)).code).toBe(EXIT_OK);
    expect(seen).toEqual([{ mapping: MAPPING, ai, model: undefined }]);
    const inside = await cli(args(questionFile(), ['--budget', '5', '--out', folder(), '--ai', join(ROOT, 'tools', 'ask-eval', 'ai.yaml')]), wrapped);
    expect(inside.code).toBe(EXIT_USAGE);
  });

  it('writes the recording and the run record, and exits 1, when a call ends the run with an unexpected error', async () => {
    let calls = 0;
    const { module } = await moduleOver(() => {
      calls += 1;
      if (calls > 1) throw new Error('the provider broke');
      return ok(planReply);
    });
    const out = folder();
    const result = await cli(args(questionFile(), ['--budget', '10', '--out', out]), module);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out[0]).toBe('recorded: 1 of 2 questions');
    expect(result.err.join(' ')).toContain('unexpected error');
    expect(result.err.join(' ')).not.toContain('the provider broke');
    expect(Object.keys(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')))).toHaveLength(1);
  });

  it('names a question that is asked but blocked by the allowlist', async () => {
    const { module, provider } = await moduleOver(ok(planReply));
    const path = join(folder(), 'questions.yaml');
    writeFileSync(path, `questions:\n  - id: show-entity\n    wording: Show me zzxqvk about ‹account#1›.\n    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }\n`);
    const result = await cli(args(path, ['--budget', '5', '--out', folder()]), module);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out).toContain('blocked: show-entity');
    expect(provider.calls).toHaveLength(0);
  });

  it('scores a recording that the budget stopped, with the questions left out as misses', async () => {
    const { module } = await moduleOver(ok('not a plan'));
    const questions = questionFile();
    const out = folder();
    await cli(args(questions, ['--budget', '3', '--out', out]), module);
    const scored = await cli(['--questions', questions, '--replay', join(out, 'recording.json'), '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '1'], module);
    expect(scored.out.some((line) => line.startsWith('no-reply:'))).toBe(true);
    expect(scored.code).toBe(EXIT_MISS);
  });

  it('records the demo set across both packs with one provider and one budget', async () => {
    const { module, provider } = await moduleOver(ok(planReply));
    const out = folder();
    const demo = join(ROOT, 'services', 'api', 'tests', 'ask', 'questions.yaml');
    const result = await cli(['record', '--questions', demo, '--packs', join(ROOT, 'domain-packs'), '--budget', '100', '--out', out], module);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.slice(0, 2)).toEqual(['recorded: 33 of 33 questions', `calls: ${provider.calls.length} of 100`]);
    expect(provider.calls.length).toBeGreaterThanOrEqual(33);
    expect(provider.calls.length).toBeLessThanOrEqual(66);
  });

  it('with --dry-run makes no call and prints the questions to ask and the worst case', async () => {
    const { module, provider } = await moduleOver(ok(planReply));
    const result = await cli(['record', '--questions', questionFile(), '--mapping', MAPPING, '--dry-run'], module);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual(['questions to ask: 2', 'expected blocked, not asked: 1', 'worst case calls: 4']);
    expect(provider.calls).toHaveLength(0);
  });
});

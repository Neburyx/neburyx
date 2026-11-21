import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loopCostLines, summarizeLoopCost, type LoopCostRow } from './assistant-loop-cost.js';
import { unitsOf } from './assistant-questions.js';
import { loadAssistantSets } from './assistant-run.js';
import { runCli } from './cli.js';
import type { LoopCostRun } from './hooks.js';
import { cleanUp, hooksWith, io, scratch } from './testing/hooks.js';
import { cleanUpTemporary } from './sets.js';

afterAll(() => {
  cleanUp();
  cleanUpTemporary();
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKS = join(ROOT, 'domain-packs');

const run = (route: string, router: number, other: number, ms = 10): LoopCostRun => ({ route, calls: other === 0 ? { 'assistant.route': router } : { 'assistant.route': router, 'assistant.step': other }, total: router + other, inputTokens: 100 * (router + other), outputTokens: 10 * (router + other), ms, stepCalls: other, steps: other, maxInputTokens: 100, maxOutputTokens: 10, rows: 1 });
const row = (name: string, off: LoopCostRun, on: LoopCostRun): LoopCostRow => ({ name, off, on });

describe('the summary of the loop\'s cost', () => {
  it('gives, for each route, the calls, tokens and time with the loop off and on, the extra per routed message, and the router\'s calls apart from the others', () => {
    const summary = summarizeLoopCost([
      row('a/one', run('answered ask', 1, 0, 100), run('answered ask', 1, 1, 300)),
      row('a/two', run('answered ask', 1, 0, 200), run('answered ask', 1, 2, 600)),
      row('a/three', run('answered ask', 1, 0, 300), run('answered ask', 1, 3, 1000)),
      row('b/four', run('answered view', 1, 1), run('answered view', 1, 1)),
    ]);
    const ask = summary.routes.find((entry) => entry.route === 'answered ask');
    expect(ask).toMatchObject({ messages: 3, off: { calls: { mean: 1, median: 1, max: 1 } }, on: { calls: { mean: 3, median: 3, max: 4 }, routerCalls: { mean: 1, max: 1 }, otherCalls: { mean: 2, median: 2, max: 3 } }, extra: { calls: { mean: 2, median: 2, max: 3 }, ms: { median: 400, max: 700 } } });
    expect(ask?.extra.ms.mean).toBeCloseTo(433.33, 1);
    expect(ask?.extra.inputTokens).toMatchObject({ mean: 200, max: 300 });
    expect(summary.routes.find((entry) => entry.route === 'answered view')?.extra.calls).toMatchObject({ mean: 0, max: 0 });
  });

  it('reports a message that the two runs routed differently apart and leaves it out of the extras', () => {
    const summary = summarizeLoopCost([row('a/one', run('answered ask', 1, 0), run('answered ask', 1, 1)), row('a/two', run('answered ask', 1, 0), run('answered view', 1, 1))]);
    expect(summary.differently).toEqual(['a/two']);
    expect(summary.routes).toHaveLength(1);
    expect(summary.routes[0]).toMatchObject({ messages: 1 });
    expect(loopCostLines(summary, 4).join('\n')).toContain('routed differently in the two runs: a/two');
  });

  it('says that the reads are a stand-in and which tools were offered, and holds no wording', () => {
    const text = loopCostLines(summarizeLoopCost([row('a/one', run('answered ask', 1, 0), run('answered ask', 1, 1))]), 4).join('\n');
    expect(text).toContain('the reads are a stand-in');
    expect(text).toContain('tools offered: the intents of the folder and the view read');
  });
});

/** A fixture model for the whole set: each message gets the route its label says, the loop's step ends at once, and a view answer cites its first element. */
async function scriptedModel() {
  const sets = await loadAssistantSets(PACKS, hooksWith(() => ({ failure: 'timeout' })));
  const routes = new Map<string, string>();
  for (const unit of unitsOf(sets)) {
    const { expect: label } = unit;
    routes.set(unit.message, label.route === 'ask' ? JSON.stringify({ route: 'ask', intent: label.intent, entities: label.entities }) : label.route === 'view' ? '{"route":"view"}' : JSON.stringify({ route: 'refuse', cause: 'unplaced' }));
  }
  return (values: string, promptId: string) => {
    if (promptId === 'assistant.route') return { reply: routes.get(/^Message:\n(.*)$/m.exec(values)?.[1] ?? '') ?? '{"route":"refuse","cause":"unplaced"}' };
    if (promptId === 'assistant.step') return { reply: '{"done":true}' };
    return { reply: '{"sentences":[]}' };
  };
}

const flags = (out: string) => ['assistant', 'loop-cost', '--packs', PACKS, '--budget', '450', '--out', out];

describe('the loop-cost command', () => {
  it('prints, in a dry run, the messages, the runs and the most calls it would make, needs no key and makes no call', async () => {
    const given = hooksWith(() => ({ failure: 'timeout' }));
    const out = io();
    expect(await runCli(['assistant', 'loop-cost', '--packs', PACKS, '--dry-run'], out.io, given)).toBe(0);
    expect(out.out.join('\n')).toContain('messages to run: 45, each with the loop off and on (90 runs)');
    expect(out.out.join('\n')).toContain('calls: at most 450 (5 for each run)');
    expect(given.asked).toEqual([]);
  });

  it('refuses a missing budget, a budget below the most the runs can cost, a missing --out and an --out inside a git tree, making no call', async () => {
    for (const extra of [['--out', scratch()], ['--budget', '449', '--out', scratch()], ['--budget', '450'], ['--budget', '450', '--out', join(ROOT, 'tools', 'ask-eval', 'out-in-a-git-tree')]]) {
      const given = hooksWith(() => ({ failure: 'timeout' }));
      expect(await runCli(['assistant', 'loop-cost', '--packs', PACKS, ...extra], io().io, given), extra.join(' ')).toBe(2);
      expect(given.asked).toEqual([]);
    }
  });

  it('runs every view and ask message with the loop off and on, counts the extra call of an ask turn and writes a record of ids, counts and times with no wording', async () => {
    const reply = await scriptedModel();
    const live = hooksWith(reply);
    const out = scratch();
    const run2 = io();
    const code = await runCli(flags(join(out, 'run')), run2.io, live);
    expect(code, run2.out.join('\n') + run2.err.join('\n')).toBe(0);
    const text = run2.out.join('\n');
    expect(text).toContain('messages run: 45 of 45');
    expect(text).toMatch(/route answered ask: 32 messages/);
    expect(text).toMatch(/extra calls per routed message: mean 1, median 1, max 1/);
    const recordPath = join(out, 'run', 'loop-cost-record.json');
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const record = readFileSync(recordPath, 'utf8');
    for (const secret of ['AC-0002000', 'Which accounts', 'What am I looking at']) expect(record).not.toContain(secret);
    expect(JSON.parse(record)).toMatchObject({ messages: 45, run: 45, steps: 4, maxCalls: 5 });
  });

  it('stops before a run the budget cannot cover, never inside a turn, and says how many messages it ran', async () => {
    const given = hooksWith(() => ({ failure: 'timeout' }));
    const inflated = {
      ...given,
      recordingProvider: (provider: unknown, budget: number) => {
        const recording = given.recordingProvider(provider, budget);
        return { ...recording, usage: () => ({ ...recording.usage(), calls: recording.usage().calls + 445 }) };
      },
    };
    const out = io();
    expect(await runCli(flags(join(scratch(), 'run')), out.io, inflated)).toBe(1);
    expect(out.out.join('\n')).toContain('stopped at the budget');
    expect(out.out.join('\n')).toContain('messages run: 0 of 45');
  });
});

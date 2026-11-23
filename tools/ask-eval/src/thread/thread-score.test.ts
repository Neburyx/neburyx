import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import { agreement, codexRunner, countedRunner, parseApproval, parseScores, promptOf, scoreProblems, scoreSet, zeroNoAnswers, ScorerUnavailable, type Score, type Slot } from './scorer.js';

const SLOTS: Slot[] = [{ repeat: 1, turn: 1, label: 'A' }, { repeat: 1, turn: 1, label: 'B' }];
const scoreOf = (slot: Slot, bits: [0 | 1, 0 | 1, 0 | 1, 0 | 1] = [1, 1, 1, 1]): Score => ({ ...slot, c1: bits[0], c2: bits[1], c3: bits[2], c4: bits[3] });
const reply = (scores: Score[]): string => `Here you are\n${JSON.stringify(scores)}`;
const RUBRIC = 'PRIVATE RUBRIC TEXT';
const SET = '# Set 1\n\n## Turn 1\nMessage: q\n\n### Answer A\n- fact [n1]\n\n### Answer B\n(no answer: this turn did not run or did not give an answer)\n';

describe('scoring a set', () => {
  it('rejects a reply of another shape and asks once more, and a second bad reply fails the set naming it', async () => {
    const prompts: string[] = [];
    let n = 0;
    const flaky = (prompt: string): Promise<string> => {
      prompts.push(prompt);
      n += 1;
      return Promise.resolve(n === 1 ? 'I think they are fine' : reply(SLOTS.map((slot) => scoreOf(slot))));
    };
    expect(await scoreSet(flaky, RUBRIC, SET, SLOTS, 'set 1')).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply was not valid');
    await expect(scoreSet(() => Promise.resolve('nonsense'), RUBRIC, SET, SLOTS, 'set 1')).rejects.toThrow('set 1');
  });

  it('rejects scores with a missing, duplicate, extra or out-of-range entry, naming the slot', () => {
    expect(scoreProblems(SLOTS, [scoreOf(SLOTS[0] as Slot)])).toEqual(['missing score for 1/1/B']);
    expect(scoreProblems(SLOTS, [...SLOTS.map((slot) => scoreOf(slot)), scoreOf(SLOTS[0] as Slot)])).toEqual(['duplicate score for 1/1/A']);
    expect(scoreProblems(SLOTS, [...SLOTS.map((slot) => scoreOf(slot)), scoreOf({ repeat: 1, turn: 2, label: 'A' })])).toEqual(['extra score for 1/2/A']);
    expect(parseScores('[{"repeat":1,"turn":1,"label":"A","c1":2,"c2":1,"c3":1,"c4":1}]')).toBeUndefined();
    expect(scoreProblems(SLOTS, SLOTS.map((slot) => scoreOf(slot)))).toEqual([]);
  });

  it('sends the set and the rubric to the scorer and nothing else, reads one score per criterion for every answer, and gives no answer no point', async () => {
    let seen = '';
    const scores = await scoreSet((prompt) => ((seen = prompt), Promise.resolve(reply(SLOTS.map((slot) => scoreOf(slot))))), RUBRIC, SET, SLOTS, 'set 1');
    expect(seen).toContain(RUBRIC);
    expect(seen).toContain('### Answer A');
    expect(seen).toBe(promptOf(RUBRIC, SET));
    const zeroed = zeroNoAnswers(scores, new Set(['1/1/B']));
    expect(zeroed.find((score) => score.label === 'B')).toMatchObject({ c1: 0, c2: 0, c3: 0, c4: 0 });
    expect(zeroed.find((score) => score.label === 'A')).toMatchObject({ c1: 1, c2: 1, c3: 1, c4: 1 });
  });
});

describe('the scorer and its approval', () => {
  it('stops with the fixed message when Codex is out of quota, and never switches scorer by itself', async () => {
    const spawn = ((_: string, __: readonly string[]) => {
      const handlers: Record<string, (value?: number) => void> = {};
      return {
        stdin: { end: () => undefined },
        stdout: { on: () => undefined },
        stderr: { on: (_event: string, listener: (chunk: Buffer) => void) => setTimeout(() => listener(Buffer.from("ERROR: You've hit your usage limit")), 0) },
        on: (event: string, listener: (value?: number) => void) => {
          handlers[event] = listener;
          if (event === 'close') setTimeout(() => listener(1), 5);
        },
      };
    }) as never;
    await expect(codexRunner(spawn)('prompt')).rejects.toThrow('scorer unavailable: out of quota');
    await expect(codexRunner(spawn)('prompt')).rejects.toBeInstanceOf(ScorerUnavailable);
  });

  it('stops a harness-run scorer at the approved number of invocations', async () => {
    const counted = countedRunner(() => Promise.resolve('x'), 2);
    await counted.run('a');
    await counted.run('b');
    await expect(counted.run('c')).rejects.toThrow('used up');
    expect(counted.made()).toBe(2);
  });

  it('reads an approval only when it confirms the exception with a number of invocations, by whom and when', () => {
    expect(parseApproval('{"exceptionConfirmed":true,"invocations":6,"by":"approver","at":"2026-11-23"}')).toMatchObject({ invocations: 6 });
    expect(parseApproval('{"exceptionConfirmed":false,"invocations":6,"by":"o","at":"d"}')).toBeUndefined();
    expect(parseApproval('{"exceptionConfirmed":true,"invocations":0,"by":"o","at":"d"}')).toBeUndefined();
    expect(parseApproval('nope')).toBeUndefined();
  });
});

describe('the score command', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-score-'));
    writeFileSync(join(dir, 'set-1.md'), SET);
    writeFileSync(join(dir, 'key.json'), JSON.stringify({ slots: SLOTS }));
    writeFileSync(join(dir, 'rubric.md'), RUBRIC);
    writeFileSync(join(dir, 'approval.json'), '{"exceptionConfirmed":true,"invocations":2,"by":"approver","at":"2026-11-23"}');
    return dir;
  };
  const run = async (argv: string[], runners?: { codex: (p: string) => Promise<string>; opus: (p: string) => Promise<string> }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['thread', 'score', ...argv], { out: (line) => out.push(line), err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks, runners === undefined ? {} : { runners });
    return { code, out, err };
  };

  it('does not invoke Codex without the approval file, and invokes the stand-in at most the approved number of times with it', async () => {
    const dir = setup();
    let calls = 0;
    const codex = (): Promise<string> => ((calls += 1), Promise.resolve(reply(SLOTS.map((slot) => scoreOf(slot)))));
    const base = ['--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--rubric', join(dir, 'rubric.md'), '--scorer', 'codex', '--out', join(dir, 'scores.json')];
    const refused = await run(base, { codex, opus: codex });
    expect(refused.code).toBe(2);
    expect(calls).toBe(0);
    const approved = await run([...base, '--approval', join(dir, 'approval.json')], { codex, opus: codex });
    expect(approved.code).toBe(0);
    expect(calls).toBeLessThanOrEqual(2);
    const file = JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8')) as { scorer: string; origin: string; scores: Score[] };
    expect(file).toMatchObject({ scorer: 'codex', origin: 'harness' });
    expect(file.scores.find((score) => score.label === 'B')).toMatchObject({ c1: 0, c4: 0 });
  });

  it('runs the Opus path with an enforced count and records the calls, and marks ingested scores as not harness-run', async () => {
    const dir = setup();
    const bad = (): Promise<string> => Promise.resolve('no scores');
    const failed = await run(['--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--rubric', join(dir, 'rubric.md'), '--scorer', 'opus', '--max-calls', '1', '--out', join(dir, 's1.json')], { codex: bad, opus: bad });
    expect(failed.code).toBe(1);
    expect(failed.err.join('\n')).toContain('used up');
    const good = (): Promise<string> => Promise.resolve(reply(SLOTS.map((slot) => scoreOf(slot))));
    const ok = await run(['--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--rubric', join(dir, 'rubric.md'), '--scorer', 'opus', '--max-calls', '1', '--out', join(dir, 's2.json')], { codex: good, opus: good });
    expect(ok.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 's2.json'), 'utf8'))).toMatchObject({ scorer: 'opus', origin: 'harness', invocations: 1 });
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ scores: SLOTS.map((slot) => scoreOf(slot)) }));
    const ingested = await run(['--ingest', join(dir, 'other.json'), '--scorer-name', 'opus-agent', '--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--out', join(dir, 's3.json')]);
    expect(ingested.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 's3.json'), 'utf8'))).toMatchObject({ scorer: 'opus-agent', origin: 'ingested' });
  });
});

describe('the calibration', () => {
  it('reports the agreement per criterion and overall, and says indicative below 90 percent', () => {
    const a = [scoreOf(SLOTS[0] as Slot), scoreOf(SLOTS[1] as Slot)];
    expect(agreement(a, a)).toMatchObject({ overall: 100, indicative: false, slots: 2 });
    const b = [scoreOf(SLOTS[0] as Slot, [0, 1, 1, 1]), scoreOf(SLOTS[1] as Slot, [0, 0, 1, 1])];
    const result = agreement(a, b);
    expect(result).toMatchObject({ c1: 0, c2: 50, c3: 100, c4: 100, overall: 62.5, indicative: true });
  });
});

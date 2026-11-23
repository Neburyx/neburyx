import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import { agreement, codexRunner, countedRunner, opusRunner, parseApproval, parseScores, promptOf, scoreProblems, scoreSet, zeroNoAnswers, ScorerUnavailable, type Runner, type Slot } from './scorer.js';
import type { Score } from './schemas.js';

const SLOTS: Slot[] = [{ repeat: 1, turn: 1, label: 'A' }, { repeat: 1, turn: 1, label: 'B' }];
const scoreOf = (slot: Slot, bits: [0 | 1, 0 | 1, 0 | 1, 0 | 1] = [1, 1, 1, 1]): Score => ({ ...slot, c1: bits[0], c2: bits[1], c3: bits[2], c4: bits[3] });
const reply = (scores: Score[]): string => `Here you are\n${JSON.stringify(scores)}`;
const RUBRIC = 'PRIVATE RUBRIC TEXT';
const ran = (text: string, calls = 1): { text: string; calls: number } => ({ text, calls });
const SET = '# Set 1\n\n## Turn 1\nMessage: q\n\n### Answer A\n- fact [n1]\n\n### Answer B\n(no answer: this turn did not run or did not give an answer)\n';

describe('scoring a set', () => {
  it('rejects a reply of another shape and asks once more, and a second bad reply fails the set naming it', async () => {
    const prompts: string[] = [];
    let n = 0;
    const flaky: Runner = (prompt) => {
      prompts.push(prompt);
      n += 1;
      return Promise.resolve(ran(n === 1 ? 'I think they are fine' : reply(SLOTS.map((slot) => scoreOf(slot)))));
    };
    expect(await scoreSet(flaky, RUBRIC, SET, SLOTS, 'set 1')).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply was not valid');
    await expect(scoreSet(() => Promise.resolve(ran('nonsense')), RUBRIC, SET, SLOTS, 'set 1')).rejects.toThrow('set 1');
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
    const scores = await scoreSet((prompt) => ((seen = prompt), Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot)))))), RUBRIC, SET, SLOTS, 'set 1');
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
    await expect(codexRunner(spawn, {})('prompt')).rejects.toThrow('scorer unavailable: out of quota');
    await expect(codexRunner(spawn, {})('prompt')).rejects.toBeInstanceOf(ScorerUnavailable);
  });

  it('stops a harness-run scorer at the approved number of calls, counts the calls a run reports and refuses a run that made more than were left', async () => {
    const counted = countedRunner(() => Promise.resolve(ran('x')), 2);
    await counted.run('a');
    await counted.run('b');
    await expect(counted.run('c')).rejects.toThrow('used up');
    expect(counted.made()).toBe(2);
    const greedy = countedRunner(() => Promise.resolve(ran('x', 3)), 2);
    await expect(greedy.run('a')).rejects.toThrow('made 3 calls');
    expect(greedy.made()).toBe(3);
  });

  it('gives the scorers an environment of their own: none of the product\'s settings, database or key reaches the program, and each runs in an empty folder of its own', async () => {
    const seen: { command: string; args: readonly string[]; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined }[] = [];
    const spawn = ((command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      seen.push({ command, args, cwd: options.cwd, env: options.env });
      const reply = args.includes('-o') ? args[args.indexOf('-o') + 1] : undefined;
      if (reply !== undefined) writeFileSync(reply, '[]');
      return {
        stdin: { end: () => undefined },
        stdout: { on: (_event: string, listener: (chunk: Buffer) => void) => setTimeout(() => listener(Buffer.from('{"result":"[]","num_turns":1}')), 0) },
        stderr: { on: () => undefined },
        on: (event: string, listener: (value?: number) => void) => {
          if (event === 'close') setTimeout(() => listener(0), 5);
        },
      };
    }) as never;
    const env = { PATH: '/bin', HOME: '/home/x', DATABASE_URL: 'postgres://u:CANARY@h/db', NEBURYX_ASSISTANT_MODEL: 'canary-model', ANTHROPIC_API_KEY: 'scorer-own-key', OPENAI_API_KEY: 'codex-own-key', NEBURYX_PROVIDER_KEY_FILE: '/secret/path' };
    await codexRunner(spawn, env)('p');
    await opusRunner(spawn, env)('p');
    for (const run of seen) {
      expect(Object.keys(run.env ?? {}).sort()).not.toContain('DATABASE_URL');
      expect(JSON.stringify(run.env)).not.toMatch(/CANARY|canary-model|secret\/path/u);
      expect(run.cwd).toBeDefined();
      expect(run.cwd).toContain('thread-scorer-');
    }
    expect(seen[0]?.env).toMatchObject({ OPENAI_API_KEY: 'codex-own-key' });
    expect(seen[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(seen[0]?.args).toContain('shell_environment_policy.inherit="none"');
    expect(seen[1]?.env).toMatchObject({ ANTHROPIC_API_KEY: 'scorer-own-key' });
    expect(seen[1]?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(seen[1]?.args.slice(seen[1].args.indexOf('--tools'), seen[1].args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
  });

  it('gives Codex a home of its own that holds only its sign-in: the user\'s configuration is not there, and the original folder is not its home', async () => {
    const real = mkdtempSync(join(tmpdir(), 'thread-codex-home-'));
    writeFileSync(join(real, 'auth.json'), '{"token":"scorer-own"}');
    writeFileSync(join(real, 'config.toml'), 'model = "user-setting"');
    let seen: { home: string | undefined; files: string[]; auth: string } | undefined;
    const spawn = ((_: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const home = options.env?.['CODEX_HOME'];
      seen = { home, files: home === undefined ? [] : readdirSync(home).sort(), auth: home === undefined ? '' : readFileSync(join(home, 'auth.json'), 'utf8') };
      writeFileSync(args[args.indexOf('-o') + 1] ?? '', '[]');
      return { stdin: { end: () => undefined }, stdout: { on: () => undefined }, stderr: { on: () => undefined }, on: (event: string, listener: (value?: number) => void) => { if (event === 'close') setTimeout(() => listener(0), 5); } };
    }) as never;
    await codexRunner(spawn, { CODEX_HOME: real, HOME: '/home/user', PATH: '/bin' })('p');
    expect(seen?.home).not.toBe(real);
    expect(seen?.files).toEqual(['auth.json']);
    expect(seen?.auth).toContain('scorer-own');
    expect(existsSync(seen?.home ?? real)).toBe(false);
  });

  it('counts the model calls an Opus run states and refuses a reply that does not state them', async () => {
    const spawnOf = (out: string) =>
      ((_: string, __: readonly string[]) => ({
        stdin: { end: () => undefined },
        stdout: { on: (_event: string, listener: (chunk: Buffer) => void) => setTimeout(() => listener(Buffer.from(out)), 0) },
        stderr: { on: () => undefined },
        on: (event: string, listener: (value?: number) => void) => {
          if (event === 'close') setTimeout(() => listener(0), 5);
        },
      })) as never;
    expect(await opusRunner(spawnOf('{"result":"[]","num_turns":4}'), {})('p')).toEqual({ text: '[]', calls: 4 });
    await expect(opusRunner(spawnOf('{"result":"[]"}'), {})('p')).rejects.toThrow('does not state the calls');
    await expect(opusRunner(spawnOf('not json'), {})('p')).rejects.toThrow('not the JSON');
    const counted = countedRunner(opusRunner(spawnOf('{"result":"[]","num_turns":4}'), {}), 3);
    await expect(counted.run('p')).rejects.toThrow('made 4 calls');
  });

  it('reads an approval only when it confirms the exception with a number of invocations, by whom and when', () => {
    expect(parseApproval('{"exceptionConfirmed":true,"invocations":6,"by":"approver","at":"2026-11-23"}')).toMatchObject({ invocations: 6 });
    expect(parseApproval('{"exceptionConfirmed":false,"invocations":6,"by":"o","at":"d"}')).toBeUndefined();
    expect(parseApproval('{"exceptionConfirmed":true,"invocations":0,"by":"o","at":"d"}')).toBeUndefined();
    expect(parseApproval('nope')).toBeUndefined();
  });
});

const SHA = createHash('sha256').update(SET, 'utf8').digest('hex');
const KEY = { key: { seed: 's', manifestSha256: 'm', entries: [{ repeat: 1, turn: 1, labels: { A: 'arm-one', B: 'arm-two' } }], sets: { '1': SHA }, noAnswer: ['1/1/B'] }, slots: SLOTS };

describe('the score command', () => {
  const setup = (invocations = 2) => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-score-'));
    writeFileSync(join(dir, 'set-1.md'), SET);
    writeFileSync(join(dir, 'key.json'), JSON.stringify(KEY));
    writeFileSync(join(dir, 'rubric.md'), RUBRIC);
    writeFileSync(join(dir, 'approval.json'), `{"exceptionConfirmed":true,"invocations":${invocations},"by":"approver","at":"2026-11-23"}`);
    return dir;
  };
  const run = async (argv: string[], runners?: { codex: Runner; opus: Runner }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['thread', 'score', ...argv], { out: (line) => out.push(line), err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks, runners === undefined ? {} : { runners });
    return { code, out, err };
  };
  const common = (dir: string) => ['--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--rubric', join(dir, 'rubric.md')];

  it('does not invoke Codex without the approval file, and invokes the stand-in at most the approved number of times with it', async () => {
    const dir = setup();
    let calls = 0;
    const codex: Runner = () => ((calls += 1), Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot))))));
    const base = [...common(dir), '--scorer', 'codex', '--out', join(dir, 'scores.json')];
    const refused = await run(base, { codex, opus: codex });
    expect(refused.code).toBe(2);
    expect(calls).toBe(0);
    const approved = await run([...base, '--approval', join(dir, 'approval.json')], { codex, opus: codex });
    expect(approved.code).toBe(0);
    expect(calls).toBeLessThanOrEqual(2);
    const file = JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8')) as { scorer: string; origin: string; repeat: number; setSha256: string; scores: Score[] };
    expect(file).toMatchObject({ scorer: 'codex', origin: 'harness', repeat: 1, setSha256: SHA });
    expect(file.scores.find((score) => score.label === 'B')).toMatchObject({ c1: 0, c4: 0 });
  });

  it('spends one approval across commands, sets and retries: the calls used are kept beside it and the next command gets what is left', async () => {
    const dir = setup(3);
    let calls = 0;
    const bad: Runner = () => ((calls += 1), Promise.resolve(ran('no scores')));
    const good: Runner = () => ((calls += 1), Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot))))));
    const args = (out: string) => [...common(dir), '--scorer', 'codex', '--approval', join(dir, 'approval.json'), '--out', join(dir, out)];
    expect((await run(args('a.json'), { codex: bad, opus: bad })).code).toBe(1);
    expect(calls).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, 'approval.json.ledger.json'), 'utf8'))).toEqual({ used: 2 });
    calls = 0;
    expect((await run(args('b.json'), { codex: bad, opus: bad })).code).toBe(1);
    expect(calls).toBe(1);
    calls = 0;
    const spent = await run(args('c.json'), { codex: good, opus: good });
    expect(spent.code).toBe(2);
    expect(spent.err.join('\n')).toContain('used up');
    expect(calls).toBe(0);
    expect(existsSync(join(dir, 'c.json'))).toBe(false);
  });

  it('counts a launch that fails or is cut off, because the invocation is taken before the program starts', async () => {
    const dir = setup(5);
    const crash: Runner = () => Promise.reject(new ScorerUnavailable('cut off'));
    const failed = await run([...common(dir), '--scorer', 'codex', '--approval', join(dir, 'approval.json'), '--out', join(dir, 'a.json')], { codex: crash, opus: crash });
    expect(failed.code).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'approval.json.ledger.json'), 'utf8'))).toEqual({ used: 1 });
  });

  it('takes an invocation under a lock: a lock another command holds stops the launch with no invocation spent, and a lock left by a crashed command long ago is cleared', async () => {
    const dir = setup(5);
    const lock = join(dir, 'approval.json.ledger.json.lock');
    let launches = 0;
    const good: Runner = () => ((launches += 1), Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot))))));
    const args = (out: string) => [...common(dir), '--scorer', 'codex', '--approval', join(dir, 'approval.json'), '--out', join(dir, out)];
    mkdirSync(lock);
    const held = await run(args('a.json'), { codex: good, opus: good });
    expect(held.code).toBe(1);
    expect(held.err.join('\n')).toContain('locked by another command');
    expect(launches).toBe(0);
    expect(existsSync(join(dir, 'approval.json.ledger.json'))).toBe(false);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect((await run(args('b.json'), { codex: good, opus: good })).code).toBe(0);
    expect(launches).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses a rubric or a set that looks like it holds a credential, before any scorer runs, and a ledger that cannot be written, before any invocation', async () => {
    const dir = setup();
    let launches = 0;
    const good: Runner = () => ((launches += 1), Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot))))));
    writeFileSync(join(dir, 'leaky.md'), 'use sk-ABCDEFGHIJKLMNOPQRSTUVWX to score');
    const leaky = await run(['--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--rubric', join(dir, 'leaky.md'), '--scorer', 'opus', '--max-calls', '1', '--out', join(dir, 'a.json')], { codex: good, opus: good });
    expect(leaky.code).toBe(2);
    expect(JSON.stringify(leaky)).not.toContain('ABCDEFGH');
    symlinkSync(join(dir, 'rubric.md'), join(dir, 'approval.json.ledger.json'));
    const linked = await run([...common(dir), '--scorer', 'codex', '--approval', join(dir, 'approval.json'), '--out', join(dir, 'b.json')], { codex: good, opus: good });
    expect(linked.code).toBe(2);
    expect(launches).toBe(0);
  });

  it('runs the Opus path with an enforced count and records the calls, and marks ingested scores as not harness-run', async () => {
    const dir = setup();
    const bad: Runner = () => Promise.resolve(ran('no scores'));
    const failed = await run([...common(dir), '--scorer', 'opus', '--max-calls', '1', '--out', join(dir, 's1.json')], { codex: bad, opus: bad });
    expect(failed.code).toBe(1);
    expect(failed.err.join('\n')).toContain('used up');
    const good: Runner = () => Promise.resolve(ran(reply(SLOTS.map((slot) => scoreOf(slot)))));
    const ok = await run([...common(dir), '--scorer', 'opus', '--max-calls', '1', '--out', join(dir, 's2.json')], { codex: good, opus: good });
    expect(ok.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 's2.json'), 'utf8'))).toMatchObject({ scorer: 'opus', origin: 'harness', invocations: 1 });
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ scores: SLOTS.map((slot) => scoreOf(slot)) }));
    const ingested = await run(['--ingest', join(dir, 'other.json'), '--scorer-name', 'opus-agent', '--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--out', join(dir, 's3.json')]);
    expect(ingested.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 's3.json'), 'utf8'))).toMatchObject({ scorer: 'opus-agent', origin: 'ingested', repeat: 1, setSha256: SHA });
  });

  it('refuses ingested scores that are not 0 or 1, that hold an unknown field, or that are for another set, and refuses a set that is not the one the key was made with', async () => {
    const dir = setup();
    const ingest = (name: string, body: unknown) => {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
      return run(['--ingest', join(dir, `${name}.json`), '--scorer-name', 'x', '--set', join(dir, 'set-1.md'), '--slots', join(dir, 'key.json'), '--out', join(dir, `${name}.out.json`)]);
    };
    const hundred = await ingest('hundred', { scores: [{ ...scoreOf(SLOTS[0] as Slot), c1: 100 }, scoreOf(SLOTS[1] as Slot)] });
    expect(hundred.code).toBe(2);
    expect(existsSync(join(dir, 'hundred.out.json'))).toBe(false);
    expect((await ingest('extra', { scores: SLOTS.map((slot) => ({ ...scoreOf(slot), note: 'x' })) })).code).toBe(2);
    expect((await ingest('short', { scores: [scoreOf(SLOTS[0] as Slot)] })).code).toBe(1);
    writeFileSync(join(dir, 'edited.md'), `${SET}edited\n`);
    const edited = await run(['--ingest', join(dir, 'short.json'), '--scorer-name', 'x', '--set', join(dir, 'edited.md'), '--slots', join(dir, 'key.json'), '--out', join(dir, 'e.json')]);
    expect(edited.code).toBe(2);
    expect(edited.err.join('\n')).toContain('not the set the key was made with');
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

  it('writes the calibration artifact only for two scorers\' files of the same complete set of the key, and refuses partial, mismatched or same-scorer files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-calibrate-'));
    writeFileSync(join(dir, 'key.json'), JSON.stringify(KEY));
    const file = (scorer: string, scores: Score[], over: Record<string, unknown> = {}) => ({ scorer, origin: 'harness', repeat: 1, setSha256: SHA, scores, ...over });
    const write = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body));
    const all = SLOTS.map((slot) => scoreOf(slot));
    write('a.json', file('codex', all));
    write('b.json', file('opus', [scoreOf(SLOTS[0] as Slot), scoreOf(SLOTS[1] as Slot, [0, 0, 0, 0])]));
    write('partial.json', file('opus', [scoreOf(SLOTS[0] as Slot)]));
    write('other-set.json', file('opus', all, { setSha256: 'f'.repeat(64) }));
    write('same.json', file('codex', all));
    const calibrate = async (b: string, out: string) => {
      const err: string[] = [];
      const code = await runCli(['thread', 'calibrate', '--key-file', join(dir, 'key.json'), '--a', join(dir, 'a.json'), '--b', join(dir, b), '--out', join(dir, out)], { out: () => undefined, err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks);
      return { code, err };
    };
    expect((await calibrate('b.json', 'cal.json')).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'cal.json'), 'utf8'))).toMatchObject({ repeat: 1, setSha256: SHA, scorers: ['codex', 'opus'], slots: 2, indicative: true });
    for (const bad of ['partial.json', 'other-set.json', 'same.json']) expect((await calibrate(bad, `${bad}.out`)).code).toBe(2);
  });
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { RecordedAnswer } from './hooks.js';
import { cleanUp, fixtureSet, hooksWith, io, QUESTIONS, scratch } from './testing/hooks.js';

afterAll(cleanUp);

const RIGHT: Record<string, RecordedAnswer> = {
  'Show thing one.': { reply: '{"intent":"byId","entities":{"id":"T-1"}}' },
  'Are two things linked, T-1 and T-2?': { reply: '{"intent":"pair","entities":{"first":"T-1","second":"T-2"}}' },
  'What is the weather?': { reply: '{"intent":null,"entities":{}}' },
};
const hooks = (answers: Record<string, RecordedAnswer> = RIGHT) => hooksWith((question) => answers[question] ?? { failure: 'timeout' });

async function privateRun(extra: readonly string[], answers: Record<string, RecordedAnswer> = RIGHT, replayAnswers: Record<string, RecordedAnswer> = answers) {
  const fixture = fixtureSet(QUESTIONS);
  const outside = scratch();
  const given = hooks(answers);
  // the replay of the fixture is written by the tool itself, then its answers are replaced
  const scripted = io();
  const replay = join(outside, 'replay.json');
  expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], scripted.io, given)).toBe(0);
  const text = JSON.parse(readFileSync(replay, 'utf8')) as { note?: string; folders: unknown; answers: unknown };
  writeFileSync(replay, JSON.stringify({ model: 'fixture-model', folders: text.folders, answers: replayAnswers }));
  const run = io();
  const code = await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay, ...extra], run.io, given);
  return { code, ...run, fixture, outside, replay };
}

describe('the usage', () => {
  it.each([[[]], [['--packs']], [['--bogus', 'x']], [['--packs', 'a', '--questions', 'b']], [['record']], [['scan']], [['--packs', 'a', '--folder', 'f']]])('prints the usage and exits 2 for %j', async (argv) => {
    const run = io();
    expect(await runCli(argv, run.io, hooks())).toBe(2);
    expect(run.err.join('\n')).toContain('usage');
  });
});

describe('scoring a private-shaped set on a replay', () => {
  it('passes with every answer right, and the report holds counts and ids, never a wording or a value', async () => {
    const run = await privateRun([]);
    expect(run.code).toBe(0);
    const text = run.out.join('\n');
    expect(text).toContain('refusals: 1 of 1 refused');
    expect(text).toContain('plans: 2 of 2 right (100.0%), at most 0 may miss');
    expect(text).not.toMatch(/thing|weather|T-1/);
    expect(text).not.toContain('replay: scripted');
  });

  it('fails with a wrong intent and a refusal that was answered, naming the ids and the causes', async () => {
    const run = await privateRun([], RIGHT, { ...RIGHT, 'Show thing one.': { reply: '{"intent":"pair","entities":{"first":"T-1","second":"T-1"}}' }, 'What is the weather?': { reply: '{"intent":"byId","entities":{"id":"T-1"}}' } });
    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain('miss: fixture-source/q1 wrong-intent');
    expect(run.out.join('\n')).toContain('miss: fixture-source/q3 answered');
  });

  it('counts a question with no recorded answer as a miss that stays in the totals', async () => {
    const { 'Show thing one.': _removed, ...fewer } = RIGHT;
    const run = await privateRun([], RIGHT, fewer);
    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain('miss: fixture-source/q1 no-reply');
    expect(run.out.join('\n')).toContain('plans: 1 of 2 right');
  });

  it('gives the classifier\'s own cause for a reply that does not fit, a model refusal and a failed call', async () => {
    const run = await privateRun([], RIGHT, { 'Show thing one.': { reply: 'not json' }, 'Are two things linked, T-1 and T-2?': { declined: true }, 'What is the weather?': { failure: 'timeout' } });
    const text = run.out.join('\n');
    expect(text).toContain('miss: fixture-source/q1 bad-reply');
    expect(text).toContain('miss: fixture-source/q2 model-declined');
    expect(text).toContain('miss: fixture-source/q3 model-failed');
  });

  it('refuses a reply recorded for another classification text, and a replay with answers to questions not in the set', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const replay = join(outside, 'replay.json');
    writeFileSync(replay, JSON.stringify({ model: 'fixture-model', folders: { [fixture.source]: 'f'.repeat(64) }, answers: {} }));
    const stale = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], stale.io, hooks())).toBe(2);
    expect(stale.err.join('\n')).toContain('recorded for another classification text');
    const scripted = io();
    await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], scripted.io, hooks());
    const written = JSON.parse(readFileSync(replay, 'utf8')) as { folders: unknown; answers: Record<string, unknown> };
    writeFileSync(replay, JSON.stringify({ model: 'fixture-model', folders: written.folders, answers: { ...written.answers, 'Not in the set.': { reply: 'x' } } }));
    const stray = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], stray.io, hooks())).toBe(2);
    expect(stray.err.join('\n')).toContain('1 answer to questions that are not in the set');
    expect(stray.err.join('\n')).not.toContain('Not in the set');
  });

  it('refuses a malformed replay and one over 5 MiB', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    for (const text of ['not json', '{"folders":{},"answers":{"q":{"reply":1}}}', JSON.stringify({ model: 'm', folders: {}, answers: {}, pad: 'x'.repeat(5 * 1024 * 1024 + 1) })]) {
      const replay = join(outside, 'r.json');
      writeFileSync(replay, text);
      const run = io();
      expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], run.io, hooks())).toBe(2);
    }
  });

  it('refuses a replay or a baseline path inside a git working tree for a private run', async () => {
    const fixture = fixtureSet(QUESTIONS);
    mkdirSync(join(fixture.root, '.git'));
    const run = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', join(fixture.root, 'r.json')], run.io, hooks())).toBe(2);
  });
});

describe('the baseline', () => {
  const baselineWith = async (initial: string, update: boolean, answers = RIGHT) => {
    const outside = scratch();
    const baseline = join(outside, 'baseline.json');
    writeFileSync(baseline, initial);
    const run = await privateRun(['--baseline', baseline, ...(update ? ['--update-baseline'] : [])].map((part) => (part === baseline ? baseline : part)), RIGHT, answers);
    return { ...run, baseline };
  };

  it('is written from a run that meets its targets, and then a run below it fails', async () => {
    const outside = scratch();
    const baseline = join(outside, 'baseline.json');
    writeFileSync(baseline, '{}');
    const first = await privateRun(['--baseline', baseline, '--update-baseline']);
    expect(first.code).toBe(0);
    const stored = JSON.parse(readFileSync(baseline, 'utf8')) as { replay: { refusals: number; plans: number } };
    expect(stored.replay).toMatchObject({ model: 'fixture-model', refusals: 1, plans: 2 });
    const worse = await privateRun(['--baseline', baseline], RIGHT, { ...RIGHT, 'Show thing one.': { reply: '{"intent":"byId","entities":{"id":"T-9"}}' } });
    expect(worse.code).toBe(1);
  });

  it('is not written from a run that misses its targets', async () => {
    const run = await baselineWith('{}', true, { ...RIGHT, 'What is the weather?': { reply: '{"intent":"byId","entities":{"id":"T-1"}}' } });
    expect(run.code).toBe(2);
    expect(readFileSync(run.baseline, 'utf8')).toBe('{}');
  });

  it('is refused when it was made for other questions, and when it is malformed', async () => {
    const other = await baselineWith(JSON.stringify({ replay: { model: 'fixture-model', questions: 'a'.repeat(64), refusals: 1, plans: 2 } }), false);
    expect(other.code).toBe(2);
    expect(other.err.join('\n')).toContain('other questions');
    expect((await baselineWith('{"surprise":1}', false)).code).toBe(2);
  });
});

describe('the scripted replay', () => {
  it('is written with the note scripted and is scored as a pass that says so', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const replay = join(outside, 'replay.json');
    const write = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], write.io, hooks())).toBe(0);
    expect(JSON.parse(readFileSync(replay, 'utf8')).note).toBe('scripted');
    const run = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], run.io, hooks())).toBe(0);
    expect(run.out.join('\n')).toContain('replay: scripted from the expectations, not a model');
  });

  it('is refused as the source of a baseline', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const replay = join(outside, 'replay.json');
    const baseline = join(outside, 'baseline.json');
    writeFileSync(baseline, '{}');
    await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], io().io, hooks());
    const run = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay, '--baseline', baseline, '--update-baseline'], run.io, hooks())).toBe(2);
    expect(run.err.join('\n')).toContain('scripted replay');
    expect(readFileSync(baseline, 'utf8')).toBe('{}');
  });
});

describe('the recorder', () => {
  const base = (fixture: ReturnType<typeof fixtureSet>) => ['record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source];

  it('prints, in a dry run, the number of calls and the settings, makes no call and needs no key', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const given = hooks();
    const run = io();
    expect(await runCli([...base(fixture), '--dry-run'], run.io, given)).toBe(0);
    expect(run.out).toEqual(expect.arrayContaining(['questions to ask: 3', 'calls: 3', 'model: claude-haiku-5-5', 'effort: medium']));
    expect(run.out.join('\n')).toMatch(/prompt hash fixture-source: [0-9a-f]{64}/);
    expect(given.asked).toEqual([]);
  });

  it('refuses a budget below the number of questions, a missing budget and an --out inside a git working tree, making no call', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    for (const extra of [['--budget', '2', '--out', outside], ['--out', outside], ['--budget', '3']]) {
      const given = hooks();
      const run = io();
      expect(await runCli([...base(fixture), ...extra], run.io, given), extra.join(' ')).toBe(2);
      expect(given.asked).toEqual([]);
    }
    mkdirSync(join(fixture.root, '.git'));
    expect(await runCli([...base(fixture), '--budget', '3', '--out', join(fixture.root, 'out')], io().io, hooks())).toBe(2);
  });

  it('makes exactly one call for each question, writes the recording and a run record that hold no text, with mode 0600', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const out = join(outside, 'run');
    const given = hooks();
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], run.io, given)).toBe(0);
    expect(given.asked).toEqual(['Show thing one.', 'Are two things linked, T-1 and T-2?', 'What is the weather?']);
    expect(statSync(join(out, 'recording.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(out, 'run-record.json')).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ model: 'fixture-model', effort: 'medium', calls: 3, failed: 0, inputTokens: 30, outputTokens: 15, cacheReadTokens: 6, stoppedAtBudget: false });
    expect(JSON.stringify(record)).not.toMatch(/thing|weather/);
    expect(run.out.join('\n')).toContain('calls: 3 of 3');
    const again = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], again.io, hooks())).toBe(2);
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out, '--force'], io().io, hooks())).toBe(0);
  });

  it('records a failed call as a failure code, counts it, and never calls again for it', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const given = hooksWith((question) => (question === 'Show thing one.' ? { failure: 'timeout' } : (RIGHT[question] ?? { failure: 'timeout' })));
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], io().io, given)).toBe(0);
    expect(given.asked.filter((question) => question === 'Show thing one.')).toHaveLength(1);
    const recording = JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as { answers: Record<string, unknown> };
    expect(recording.answers['Show thing one.']).toEqual({ failure: 'timeout' });
    expect(JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8')).failed).toBe(1);
  });

  it('records a model refusal in the replay format, so the recording can be committed as the replay', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const given = hooksWith((question) => (question === 'What is the weather?' ? { declined: true } : (RIGHT[question] ?? { failure: 'timeout' })));
    await runCli([...base(fixture), '--budget', '3', '--out', out], io().io, given);
    const replay = join(out, 'recording.json');
    const run = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], run.io, hooks())).toBe(1);
    expect(run.out.join('\n')).toContain('miss: fixture-source/q3 model-declined');
  });
});

describe('the unknown-intent cause, and the quiet failure of a private folder', () => {
  it('scores a reply naming an intent the folder does not have as an unknown-intent miss', async () => {
    const run = await privateRun([], RIGHT, { ...RIGHT, 'Show thing one.': { reply: '{"intent":"nope","entities":{}}' } });
    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain('miss: fixture-source/q1 unknown-intent');
  });

  it('prints only the number of problems of a private folder that fails the start-up checks, never an intent name', async () => {
    const fixture = fixtureSet(QUESTIONS);
    writeFileSync(join(fixture.folder, fixture.source, 'intents.json'), JSON.stringify({ secretIntentName: { parameters: ['id'], query: 'CREATE (n) RETURN n' } }));
    const run = io();
    expect(await runCli(['record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--dry-run'], run.io, hooks())).toBe(2);
    expect(run.err.join('\n')).toMatch(/\d+ problems?/);
    expect(run.err.join('\n')).not.toContain('secretIntentName');
  });
});

describe('the files a private run writes', () => {
  const base = (fixture: ReturnType<typeof fixtureSet>) => ['record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--budget', '3'];

  it('writes the scripted replay and the baseline of a private run with mode 0600', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const replay = join(outside, 'replay.json');
    const baseline = join(outside, 'baseline.json');
    await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], io().io, hooks());
    expect(statSync(replay).mode & 0o777).toBe(0o600);
    writeFileSync(baseline, '{}');
    chmodSync(baseline, 0o644);
    const answers = JSON.parse(readFileSync(replay, 'utf8')) as { answers: Record<string, RecordedAnswer> };
    writeFileSync(replay, JSON.stringify({ model: 'fixture-model', folders: (JSON.parse(readFileSync(replay, 'utf8')) as { folders: unknown }).folders, answers: answers.answers }));
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay, '--baseline', baseline, '--update-baseline'], io().io, hooks())).toBe(0);
    expect(statSync(baseline).mode & 0o777).toBe(0o600);
  });

  it('refuses a recording that would be written through a link, even with --force, before any call', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const target = scratch();
    mkdirSync(join(target, '.git'));
    const out = join(scratch(), 'run');
    mkdirSync(out, { mode: 0o700 });
    symlinkSync(join(target, 'planted.json'), join(out, 'recording.json'));
    for (const extra of [[], ['--force']]) {
      const given = hooks();
      expect(await runCli([...base(fixture), '--out', out, ...extra], io().io, given)).toBe(2);
      expect(given.asked).toEqual([]);
    }
    expect(existsSync(join(target, 'planted.json'))).toBe(false);
  });

  it('refuses an --out that is a link, and one that group or others can reach', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const real = join(outside, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(outside, 'link'));
    expect(await runCli([...base(fixture), '--out', join(outside, 'link')], io().io, hooks())).toBe(2);
    const open = join(outside, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(await runCli([...base(fixture), '--out', open], io().io, hooks())).toBe(2);
  });

  it('keeps the recording and the run record of the questions answered when the run ends by an unexpected error', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const given = hooks();
    let asked = 0;
    const failing = { ...given, classify: async (...args: Parameters<typeof given.classify>) => {
      asked += 1;
      if (asked === 2) throw new Error('boom');
      return given.classify(...args);
    } };
    expect(await runCli([...base(fixture), '--out', out], io().io, failing)).toBe(1);
    expect(Object.keys((JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as { answers: object }).answers)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8'))).toMatchObject({ stoppedByError: true, calls: 1 });
  });

  it('refuses a scan of a private file or folder inside a git working tree', async () => {
    const fixture = fixtureSet(QUESTIONS);
    mkdirSync(join(fixture.root, '.git'));
    expect(await runCli(['scan', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, scratch()], io().io, hooks())).toBe(2);
  });
});

describe('the temporary folders of a run', () => {
  it('leaves none behind after a scoring run of the packs, in a temporary folder of its own that no other test shares', async () => {
    const { fileURLToPath } = await import('node:url');
    const packs = fileURLToPath(new URL('../../../domain-packs', import.meta.url));
    const out = join(scratch(), 'r.json');
    const own = mkdtempSync(join(tmpdir(), 'ask-eval-test-tmp-'));
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = own;
    try {
      expect(tmpdir()).toBe(own);
      expect(await runCli(['--packs', packs, '--write-replay', out], io().io, hooks())).toBe(0);
      expect(readdirSync(own)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('the model of a replay and of a baseline', () => {
  it('prints the model of a recorded replay in the report', async () => {
    const run = await privateRun([]);
    expect(run.out).toContain('model: fixture-model');
  });

  it('refuses a replay that is not scripted and does not say which model recorded it, and a scripted one that names a model', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const outside = scratch();
    const replay = join(outside, 'replay.json');
    await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', replay], io().io, hooks());
    const scripted = JSON.parse(readFileSync(replay, 'utf8')) as { folders: unknown; answers: unknown };
    writeFileSync(replay, JSON.stringify({ folders: scripted.folders, answers: scripted.answers }));
    const missing = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], missing.io, hooks())).toBe(2);
    expect(missing.err.join('\n')).toContain('does not say which model');
    writeFileSync(replay, JSON.stringify({ note: 'scripted', model: 'fixture-model', folders: scripted.folders, answers: scripted.answers }));
    const named = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay], named.io, hooks())).toBe(2);
    expect(named.err.join('\n')).toContain('names no model');
  });

  it('writes the model into the baseline, and then refuses a baseline made for another model, an update over another model\'s value, and a value with no model', async () => {
    const outside = scratch();
    const baseline = join(outside, 'baseline.json');
    writeFileSync(baseline, '{}');
    expect((await privateRun(['--baseline', baseline, '--update-baseline'])).code).toBe(0);
    const stored = JSON.parse(readFileSync(baseline, 'utf8')) as { replay: { model: string; questions: string; refusals: number; plans: number } };
    expect(stored.replay.model).toBe('fixture-model');
    writeFileSync(baseline, JSON.stringify({ replay: { ...stored.replay, model: 'other-model' } }));
    const other = await privateRun(['--baseline', baseline]);
    expect(other.code).toBe(2);
    expect(other.err.join('\n')).toContain('another model');
    const update = await privateRun(['--baseline', baseline, '--update-baseline']);
    expect(update.code).toBe(2);
    expect(update.err.join('\n')).toContain('another model');
    expect(JSON.parse(readFileSync(baseline, 'utf8')).replay.model).toBe('other-model');
    const { model: _model, ...withoutModel } = stored.replay;
    writeFileSync(baseline, JSON.stringify({ replay: withoutModel }));
    expect((await privateRun(['--baseline', baseline])).code).toBe(2);
  });

  it('writes the model into a recording, so the recording can be committed as the replay', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    expect(await runCli(['record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--budget', '3', '--out', out], io().io, hooks())).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')).model).toBe('fixture-model');
  });
});

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { cleanUp, fixtureSet, hooksWith, io, scratch } from './testing/hooks.js';

afterAll(cleanUp);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MESSAGES = `messages:
  - id: view
    wording: What is shown?
    expect: { route: view, view: [{ entityType: thing, stableId: T-1 }] }
  - id: byId
    wording: Show thing one.
    expect: { route: ask, intent: byId, entities: { id: T-1 } }
  - id: verdict
    wording: Is thing one guilty?
    expect: { route: refuse, cause: verdict }
`;
const REPLIES: Record<string, string> = { 'What is shown?': '{"route":"view"}', 'Show thing one.': '{"route":"ask","intent":"byId","entities":{"id":"T-1"}}', 'Is thing one guilty?': '{"route":"refuse","cause":"verdict"}' };

/** The reply the fixture model gives to a request: the right route for the message the request holds. */
const answerRoutes = (values: string) => {
  const found = Object.entries(REPLIES).find(([wording]) => values.includes(`Message:\n${wording}`));
  return found === undefined ? { declined: true as const } : { reply: found[1] };
};

function privateSet() {
  const fixture = fixtureSet('questions: []\n');
  writeFileSync(fixture.questions, MESSAGES);
  return fixture;
}

const base = (fixture: ReturnType<typeof fixtureSet>) => ['assistant', 'record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source];

describe('the recorder of the assistant\'s router', () => {
  it('prints, in a dry run, the requests, the least and the most calls, the settings, the hashes and an estimate of the input, makes no call and needs no key', async () => {
    const fixture = privateSet();
    const given = hooksWith(answerRoutes);
    const run = io();
    expect(await runCli([...base(fixture), '--dry-run'], run.io, given)).toBe(0);
    const text = run.out.join('\n');
    expect(text).toContain('requests to route: 3');
    expect(text).toContain('calls: at least 3, at most 6');
    expect(text).toMatch(/model: claude-sonnet-5-5/);
    expect(text).toMatch(/router text hash fixture-source: [0-9a-f]{64}/);
    expect(text).toMatch(/set hash: [0-9a-f]{64}/);
    expect(text).toMatch(/estimated input tokens: \d+/);
    expect(given.asked).toEqual([]);
  });

  it('refuses a missing budget, a budget below twice the requests, a missing --out and an --out inside a git working tree, making no call', async () => {
    const fixture = privateSet();
    const outside = scratch();
    for (const extra of [['--out', outside], ['--budget', '5', '--out', outside], ['--budget', '6'], ['--budget', 'x', '--out', outside]]) {
      const given = hooksWith(answerRoutes);
      expect(await runCli([...base(fixture), ...extra], io().io, given), extra.join(' ')).toBe(2);
      expect(given.asked).toEqual([]);
    }
    mkdirSync(join(fixture.root, '.git'));
    expect(await runCli([...base(fixture), '--budget', '6', '--out', join(fixture.root, 'out')], io().io, hooksWith(answerRoutes))).toBe(2);
  });

  it('routes each request once, writes the recording with the wordings and a run record without them, both owner-only in an owner-only folder, and the recording scores', async () => {
    const fixture = privateSet();
    const out = join(scratch(), 'run');
    const given = hooksWith(answerRoutes);
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '6', '--out', out], run.io, given), run.err.join('\n')).toBe(0);
    expect(given.asked).toHaveLength(3);
    expect(run.out).toEqual(expect.arrayContaining(['calls: 3 of 6', 'requests routed: 3 of 3', 'model: fixture-model']));
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const name of ['recording.json', 'run-record.json']) expect(statSync(join(out, name)).mode & 0o777).toBe(0o600);
    const recording = readFileSync(join(out, 'recording.json'), 'utf8');
    expect(JSON.parse(recording)).toMatchObject({ model: 'fixture-model' });
    expect(recording).toContain('Show thing one.');
    const record = readFileSync(join(out, 'run-record.json'), 'utf8');
    for (const secret of ['Show thing one.', 'What is shown?', 'guilty', 'T-1']) expect(record).not.toContain(secret);
    expect(JSON.parse(record)).toMatchObject({ model: 'fixture-model', effort: 'medium', outputLimit: 4000, requests: 3, calls: 3, outcomes: [{ name: 'fixture-source/view', status: 'routed', calls: 1 }, { name: 'fixture-source/byId' }, { name: 'fixture-source/verdict' }] });
    const scored = io();
    expect(await runCli(['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', join(out, 'recording.json')], scored.io, hooksWith(answerRoutes))).toBe(0);
    expect(scored.out).toContain('model: fixture-model');
  });

  it('counts the repeat after a reply that is not a route and finishes on a budget of exactly twice the requests', async () => {
    const fixture = privateSet();
    const given = hooksWith(() => ({ reply: 'no route here' }));
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '6', '--out', join(scratch(), 'run')], run.io, given)).toBe(0);
    expect(given.asked).toHaveLength(6);
    expect(run.out).toEqual(expect.arrayContaining(['calls: 6 of 6', 'requests routed: 3 of 3']));
  });

  it('stops before a request the budget cannot cover, never inside the router, and says how many it routed', async () => {
    const fixture = privateSet();
    const given = hooksWith(answerRoutes);
    const inflated = {
      ...given,
      recordingProvider: (provider: unknown, budget: number) => {
        const recording = given.recordingProvider(provider, budget);
        return { ...recording, usage: () => ({ ...recording.usage(), calls: recording.usage().calls + 5 }) };
      },
    };
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '6', '--out', join(scratch(), 'run')], run.io, inflated)).toBe(1);
    expect(run.out.join('\n')).toContain('stopped at the budget');
    expect(run.out.join('\n')).toContain('requests routed: 0 of 3');
  });

  it('uses the assistant\'s settings for the model: the model named by the flag reaches the provider', async () => {
    const fixture = privateSet();
    const given = hooksWith(answerRoutes);
    const seen: (string | undefined)[] = [];
    const spied = { ...given, liveAssistantProvider: async (env: Readonly<Record<string, string | undefined>>, folder: string, model?: string) => (seen.push(model), given.liveAssistantProvider(env, folder, model)) };
    await runCli([...base(fixture), '--budget', '6', '--out', join(scratch(), 'run'), '--model', 'a-model'], io().io, spied);
    expect(seen).toEqual(['a-model']);
  });
});

describe('the baseline of the assistant\'s router', () => {
  async function recorded() {
    const fixture = privateSet();
    const out = join(scratch(), 'run');
    await runCli([...base(fixture), '--budget', '6', '--out', out], io().io, hooksWith(answerRoutes));
    const run = scratch();
    const baseline = join(run, 'baseline.json');
    writeFileSync(baseline, '{}\n');
    const args = ['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', join(out, 'recording.json'), '--baseline', baseline];
    return { fixture, out, baseline, args };
  }

  it('is written from a first measured passing run for a model, and then holds it: below it the exit code is 1', async () => {
    const { args, baseline, out } = await recorded();
    const written = io();
    expect(await runCli([...args, '--update-baseline'], written.io, hooksWith(answerRoutes))).toBe(0);
    expect(written.out).toContain('baseline written');
    expect(JSON.parse(readFileSync(baseline, 'utf8')).replay).toMatchObject({ model: 'fixture-model', refusals: 1, plans: 2 });
    const replay = JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as { answers: Record<string, { reply: string }> };
    for (const values of Object.keys(replay.answers)) if (values.includes('Show thing one.')) replay.answers[values] = { reply: '{"route":"view"}' };
    writeFileSync(join(out, 'recording.json'), JSON.stringify(replay));
    const lower = io();
    expect(await runCli(args, lower.io, hooksWith(answerRoutes))).toBe(1);
    expect(lower.out.join('\n')).toContain('below the baseline');
  });

  it('is refused for a scripted replay, for a result below its targets, for another model and for another set', async () => {
    const { fixture, args, baseline, out } = await recorded();
    const scripted = join(scratch(), 'scripted.json');
    await runCli(['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', scripted], io().io, hooksWith(answerRoutes));
    const scriptedArgs = [...args.slice(0, args.indexOf('--replay')), '--replay', scripted, '--baseline', baseline, '--update-baseline'];
    expect(await runCli(scriptedArgs, io().io, hooksWith(answerRoutes))).toBe(2);
    await runCli([...args, '--update-baseline'], io().io, hooksWith(answerRoutes));
    const recording = JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as { model: string };
    writeFileSync(join(out, 'recording.json'), JSON.stringify({ ...recording, model: 'another-model' }));
    expect(await runCli(args, io().io, hooksWith(answerRoutes))).toBe(2);
    expect(await runCli([...args, '--update-baseline'], io().io, hooksWith(answerRoutes))).toBe(2);
    writeFileSync(fixture.questions, MESSAGES.replace('What is shown?', 'What is on the screen?'));
    writeFileSync(join(out, 'recording.json'), JSON.stringify(recording));
    expect(await runCli(args, io().io, hooksWith(answerRoutes))).toBe(2);
  });
});

describe('a private set of the assistant', () => {
  it('is scored on the terms of Ask\'s private set: its question file and folder outside every git tree, its written files owner-only', async () => {
    const fixture = privateSet();
    const out = join(scratch(), 'scripted.json');
    expect(await runCli(['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--write-replay', out], io().io, hooksWith(answerRoutes))).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const run = io();
    expect(await runCli(['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', out], run.io, hooksWith(answerRoutes))).toBe(0);
    expect(run.out.join('\n')).toContain('result: pass');
    const inside = join(ROOT, 'tools', 'ask-eval', 'private-set-in-a-git-tree.yaml');
    expect(await runCli(['assistant', '--questions', inside, '--folder', fixture.folder, '--source', fixture.source, '--replay', out], io().io, hooksWith(answerRoutes))).toBe(2);
    mkdirSync(join(fixture.root, '.git'));
    expect(await runCli(['assistant', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', out], io().io, hooksWith(answerRoutes))).toBe(2);
  });
});

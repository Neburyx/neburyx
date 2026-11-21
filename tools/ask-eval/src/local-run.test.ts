import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { ProviderLabel, RecordedAnswer } from './hooks.js';
import { parseReplay } from './replay-file.js';
import { cleanUp, fixtureSet, hooksWith, io, QUESTIONS, scratch } from './testing/hooks.js';

afterAll(cleanUp);

const RIGHT: Record<string, RecordedAnswer> = {
  'Show thing one.': { reply: '{"intent":"byId","entities":{"id":"T-1"}}' },
  'Are two things linked, T-1 and T-2?': { reply: '{"intent":"pair","entities":{"first":"T-1","second":"T-2"}}' },
  'What is the weather?': { reply: '{"intent":null,"entities":{}}' },
};
const LOCAL: ProviderLabel = { kind: 'local', grammar: true, grammarPrompts: ['ask.classify'], probe: 'accepted' };
const hooks = (label: ProviderLabel) => hooksWith((question) => RIGHT[question] ?? { failure: 'timeout' }, label);
const base = (fixture: ReturnType<typeof fixtureSet>) => ['record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source];

describe('a local recording of Ask', () => {
  it('says in the recording, the run record and the printed lines that it was local, with the grammar label, the schema probe and the time of a call, and counts local calls against the budget', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], run.io, hooks(LOCAL))).toBe(0);
    const text = run.out.join('\n');
    expect(text).toContain('provider: local, grammar on');
    expect(text).toContain('grammar prompts: ask.classify');
    expect(text).toContain('schema probe: accepted');
    expect(text).toMatch(/time of a call: median \d+ ms, 95th percentile \d+ ms/);
    expect(text).toContain('calls: 3 of 3');
    const recording = JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as { provider: string; grammar: boolean; model: string };
    expect(recording).toMatchObject({ provider: 'local', grammar: true, model: 'fixture-model' });
    const record = JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ provider: LOCAL, calls: 3, medianMs: expect.any(Number), p95Ms: expect.any(Number) });
    for (const name of ['recording.json', 'run-record.json']) expect(statSync(join(out, name)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(record)).not.toMatch(/thing|weather/);
  });

  it('names a thinking-off run in the recording, the lines and the score report, and leaves it out otherwise', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], run.io, hooks({ kind: 'local', grammar: false, grammarPrompts: [], thinking: 'off' }))).toBe(0);
    expect(run.out.join('\n')).toContain('thinking: off');
    expect(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8'))).toMatchObject({ provider: 'local', grammar: false, thinking: 'off' });
    const score = io();
    expect(await runCli(['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', join(out, 'recording.json')], score.io, hooks(LOCAL))).toBe(0);
    expect(score.out).toContain('thinking: off');
    const again = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', join(scratch(), 'run2')], again.io, hooks(LOCAL))).toBe(0);
    expect(again.out.join('\n')).not.toContain('thinking:');
  });

  it('writes nothing about the provider for an Anthropic recording, so that it is as it was', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], run.io, hooks({ kind: 'anthropic' }))).toBe(0);
    expect(run.out.join('\n')).not.toContain('provider:');
    const recording = JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8')) as Record<string, unknown>;
    expect(recording).not.toHaveProperty('provider');
    expect(recording).not.toHaveProperty('grammar');
  });

  it('refuses a call budget below the calls a local run needs, as for any run', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const run = io();
    expect(await runCli([...base(fixture), '--budget', '2', '--out', join(scratch(), 'run')], run.io, hooks(LOCAL))).toBe(2);
  });

  it('prints the estimate of the largest request on the dry run, as a number, with no call', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const given = hooks(LOCAL);
    const run = io();
    expect(await runCli([...base(fixture), '--dry-run'], run.io, given)).toBe(0);
    expect(given.asked).toEqual([]);
    expect(run.out.join('\n')).toMatch(/^largest request, estimated input tokens: \d+$/m);
  });
});

describe('the score report of a local replay', () => {
  it('prints the provider kind and the grammar label next to the model, in text and in JSON, and the replay still parses without them', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const out = join(scratch(), 'run');
    expect(await runCli([...base(fixture), '--budget', '3', '--out', out], io().io, hooks(LOCAL))).toBe(0);
    const replay = join(out, 'recording.json');
    const score = ['--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--replay', replay];
    const text = io();
    expect(await runCli(score, text.io, hooks(LOCAL))).toBe(0);
    const lines = text.out;
    expect(lines[lines.indexOf('model: fixture-model') + 1]).toBe('provider: local, grammar on');
    const json = io();
    expect(await runCli([...score, '--json'], json.io, hooks(LOCAL))).toBe(0);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ provider: 'local', grammar: true });
    const plain = JSON.parse(readFileSync(replay, 'utf8')) as Record<string, unknown>;
    delete plain['provider'];
    delete plain['grammar'];
    writeFileSync(replay, JSON.stringify(plain));
    const again = io();
    expect(await runCli(score, again.io, hooks(LOCAL))).toBe(0);
    expect(again.out.join('\n')).not.toContain('provider:');
  });

  it('refuses a replay whose provider is neither local nor anthropic', () => {
    expect(() => parseReplay(JSON.stringify({ model: 'm', provider: 'remote', folders: {}, answers: {} }))).toThrow(/expected form/);
  });
});

const MESSAGES = `messages:
  - id: view
    wording: What is shown?
    expect: { route: view, view: [{ entityType: thing, stableId: T-1 }] }
  - id: byId
    wording: Show thing one.
    expect: { route: ask, intent: byId, entities: { id: T-1 } }
`;
const REPLIES: Record<string, string> = { 'What is shown?': '{"route":"view"}', 'Show thing one.': '{"route":"ask","intent":"byId","entities":{"id":"T-1"}}' };
const answerRoutes = (values: string): RecordedAnswer => {
  const found = Object.entries(REPLIES).find(([wording]) => values.includes(`Message:\n${wording}`));
  return found === undefined ? { declined: true } : { reply: found[1] };
};
const assistantBase = (fixture: ReturnType<typeof fixtureSet>) => ['assistant', 'record', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source];
const assistantSet = () => {
  const fixture = fixtureSet('questions: []\n');
  writeFileSync(fixture.questions, MESSAGES);
  return fixture;
};

describe('a local recording of the assistant\'s router', () => {
  it('names the provider in the recording, the run record and the lines, records the time of a call and prints the largest request on the dry run', async () => {
    const fixture = assistantSet();
    const given = hooksWith(answerRoutes, { kind: 'local', grammar: false, grammarPrompts: [] });
    const dry = io();
    expect(await runCli([...assistantBase(fixture), '--dry-run'], dry.io, given)).toBe(0);
    expect(dry.out.join('\n')).toMatch(/^largest request, estimated input tokens: \d+$/m);
    expect(given.asked).toEqual([]);
    const out = join(scratch(), 'run');
    const run = io();
    expect(await runCli([...assistantBase(fixture), '--budget', '4', '--out', out], run.io, given)).toBe(0);
    expect(run.out.join('\n')).toContain('provider: local, grammar off');
    expect(run.out.join('\n')).toMatch(/time of a call: median \d+ ms/);
    expect(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8'))).toMatchObject({ provider: 'local', grammar: false });
    expect(JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8'))).toMatchObject({ provider: { kind: 'local', grammar: false }, callMs: { median: expect.any(Number), p95: expect.any(Number) } });
  });

  it('resumes a stopped local run as it resumes an Anthropic one: the answered requests are not asked again and the label stays', async () => {
    const fixture = assistantSet();
    const out = join(scratch(), 'run');
    const label: ProviderLabel = { kind: 'local', grammar: true, grammarPrompts: ['assistant.route'], probe: 'accepted' };
    const given = hooksWith(answerRoutes, label);
    let routed = 0;
    const failing = { ...given, routeMessage: async (...args: Parameters<typeof given.routeMessage>) => (++routed === 2 ? Promise.reject(new Error('the service went away')) : given.routeMessage(...args)) };
    expect(await runCli([...assistantBase(fixture), '--budget', '4', '--out', out], io().io, failing)).toBe(1);
    const resumed = hooksWith(answerRoutes, label);
    expect(await runCli([...assistantBase(fixture), '--budget', '4', '--out', out, '--resume'], io().io, resumed)).toBe(0);
    expect(resumed.asked).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(out, 'recording.json'), 'utf8'))).toMatchObject({ provider: 'local', grammar: true });
  });
});

describe('the places no workflow scores', () => {
  it('names no local replay in the nightly workflow, which replays the committed pairs of the Anthropic models and the scripted replay', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/ask-eval-nightly.yml', import.meta.url), 'utf8');
    expect(workflow).not.toContain('data/local');
    expect(workflow).not.toMatch(/gpt-oss|qwen|gemma/i);
  });
});

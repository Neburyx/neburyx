import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assistantSetHash, readAssistantFile, unitsOf, type AssistantSet } from './assistant-questions.js';
import { loadAssistantSets } from './assistant-run.js';
import { requestsOf } from './assistant-replay.js';
import { runCli } from './cli.js';
import { UsageError } from './questions.js';
import { cleanUpTemporary } from './sets.js';
import { cleanUp, hooksWith, io, scratch } from './testing/hooks.js';

afterAll(() => {
  cleanUp();
  cleanUpTemporary();
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKS = join(ROOT, 'domain-packs');
const SCRIPTED = join(ROOT, 'tools', 'ask-eval', 'data', 'assistant', 'scripted', 'replay.json');
const hooks = () => hooksWith(() => ({ failure: 'timeout' }));

const VIEW = '{ route: view, view: [{ entityType: thing, stableId: T-1 }] }';
const file = (...messages: string[]) => `messages:\n${messages.join('\n')}\n`;
const message = (id: string, expect: string, wording = `wording of ${id}`) => `  - { id: ${id}, wording: "${wording}", expect: ${expect} }`;

describe('the file of labelled assistant messages', () => {
  it('reads each form: a view with its elements, a refusal with its cause, a plan with its intent and entities', () => {
    const read = readAssistantFile(file(message('a', VIEW), message('b', '{ route: refuse, cause: raw-query }'), message('c', '{ route: ask, intent: byId, entities: { id: T-1 } }')), 3);
    expect(read.messages.map((entry) => entry.expect.route)).toEqual(['view', 'refuse', 'ask']);
  });

  it.each([
    ['an unknown member', file('  - { id: a, wording: "x", expect: { route: view, view: [{ entityType: t, stableId: s }] }, extra: 1 }')],
    ['a repeated id', file(message('a', VIEW), message('a', VIEW, 'another'))],
    ['an unknown cause', file(message('a', '{ route: refuse, cause: whim }'))],
    ['a view without its elements', file(message('a', '{ route: view }'))],
    ['a view with an empty list', file(message('a', '{ route: view, view: [] }'))],
    ['an empty wording', file(message('a', VIEW, ' '))],
    ['text that is not YAML', 'messages: [unclosed'],
  ])('refuses %s, naming the place and never a wording', (_name, text) => {
    expect(() => readAssistantFile(text, 3)).toThrow(UsageError);
    try {
      readAssistantFile(text, 3);
    } catch (error) {
      expect((error as Error).message).not.toContain('wording of');
    }
  });

  it('hashes the messages: the same under the order of the file, different when a wording changes', async () => {
    const sets = await loadAssistantSets(PACKS, hooks());
    const [first, ...rest] = sets;
    if (first === undefined) throw new Error('no set');
    const reordered = [{ ...first, messages: [...first.messages].reverse() }, ...rest];
    expect(assistantSetHash(reordered)).toBe(assistantSetHash(sets));
    const changed = [{ ...first, messages: first.messages.map((entry, index) => (index === 0 ? { ...entry, wording: `${entry.wording}!` } : entry)) }, ...rest];
    expect(assistantSetHash(changed)).not.toBe(assistantSetHash(sets));
  });
});

describe('the committed sets of the demo packs', () => {
  it('load beside their Ask folders, which still pass the product\'s loader, and hold a view, a plan and a refusal for each pack', async () => {
    const sets = await loadAssistantSets(PACKS, hooks());
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const set of sets) {
      const routes = set.messages.map((entry) => entry.expect.route);
      for (const route of ['view', 'ask', 'refuse']) expect(routes, `${set.label} ${route}`).toContain(route);
    }
  });

  it('cover the full single-message set: two views, two messages for each refusal cause and a message for every intent of the pack\'s intents.json', async () => {
    for (const set of await loadAssistantSets(PACKS, hooks())) {
      expect(set.messages.filter((entry) => entry.expect.route === 'view').length, `${set.label} views`).toBeGreaterThanOrEqual(2);
      for (const cause of ['verdict', 'raw-query', 'other-source', 'unplaced']) expect(set.messages.filter((entry) => entry.expect.route === 'refuse' && entry.expect.cause === cause).length, `${set.label} ${cause}`).toBeGreaterThanOrEqual(2);
      const asked = new Set(set.messages.flatMap((entry) => (entry.expect.route === 'ask' ? [entry.expect.intent] : [])));
      for (const intent of set.source.intents) expect(asked.has(intent.name), `${set.label} ${intent.name}`).toBe(true);
    }
  });

  it('give each request its own first form, except a thread\'s first turn, which is the request of the single message it repeats and has its label', async () => {
    const requests = await requestsOf(await loadAssistantSets(PACKS, hooks()), hooks());
    const firsts = new Set([...requests.values()].map((entry) => entry.first));
    // the first turns a thread shares with another thread of the set (the same wording and the same earlier turns) are one request
    const sets = await loadAssistantSets(PACKS, hooks());
    const byForm = new Map<string, string[]>();
    for (const [name, entry] of requests) byForm.set(entry.first, [...(byForm.get(entry.first) ?? []), name]);
    const sharing = [...byForm.values()].filter((names) => names.length > 1);
    // every form two units share is shared by units with the same expectation and the same earlier turns, as the recorder allows
    for (const names of sharing) {
      const units = unitsOf(sets).filter((unit) => names.includes(unit.name));
      expect(new Set(units.map((unit) => JSON.stringify([unit.expect, unit.earlier]))).size, names.join(', ')).toBe(1);
    }
    // three first turns of each of the two threads that open alike in both packs, and the first turn of the thread of the account just shown
    expect(requests.size - firsts.size).toBe(sharing.reduce((sum, names) => sum + names.length - 1, 0));
    expect(requests.size - firsts.size).toBe(10);
  });
});

describe('the router scored over a replay', () => {
  const committed = () => JSON.parse(readFileSync(SCRIPTED, 'utf8')) as { note: string; folders: Record<string, string>; answers: Record<string, { reply: string }> };
  const run = async (replay: unknown) => {
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    const out = io();
    const code = await runCli(['assistant', '--packs', PACKS, '--replay', path], out.io, hooks());
    return { code, text: out.out.join('\n'), err: out.err.join('\n') };
  };

  it('has a scripted replay that is exactly what the tool writes from the expectations, and that passes with exit 0', async () => {
    const out = join(scratch(), 'replay.json');
    expect(await runCli(['assistant', '--packs', PACKS, '--write-replay', out], io().io, hooks())).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(SCRIPTED, 'utf8'));
    const passed = await run(committed());
    expect(passed.code, passed.text).toBe(0);
    expect(passed.text).toContain('replay: scripted from the expectations, not a model');
    expect(passed.text).toContain('result: pass');
  });

  it('exits 1 when an expected refusal is answered by a plan, with the cause of the miss and no wording', async () => {
    const replay = committed();
    const key = Object.keys(replay.answers).find((values) => values.includes('guilty'));
    if (key === undefined) throw new Error('no refusal message');
    replay.answers[key] = { reply: JSON.stringify({ route: 'view' }) };
    const missed = await run(replay);
    expect(missed.code).toBe(1);
    expect(missed.text).toContain('miss: banking-fraud/verdict-on-an-owner wrong-route');
    expect(missed.text).not.toContain('guilty');
    expect(missed.text).not.toContain('AC-0002000');
  });

  it('scores a refusal with another cause as wrong-cause, and a plan with another intent or entity as wrong-intent or wrong-entities', async () => {
    const replay = committed();
    const entries = Object.keys(replay.answers);
    const refusal = entries.find((values) => values.includes('guilty')) ?? '';
    const plan = entries.find((values) => values.includes('same device')) ?? '';
    replay.answers[refusal] = { reply: JSON.stringify({ route: 'refuse', cause: 'raw-query' }) };
    replay.answers[plan] = { reply: JSON.stringify({ route: 'ask', intent: 'accounts-on-the-same-address', entities: { account: 'AC-0002000' } }) };
    const run1 = await run(replay);
    expect(run1.text).toContain('wrong-cause');
    expect(run1.text).toContain('wrong-intent');
    replay.answers[plan] = { reply: JSON.stringify({ route: 'ask', intent: 'accounts-on-the-same-device', entities: { account: 'AC-0009999' } }) };
    expect((await run(replay)).text).toContain('wrong-entities');
  });

  it('allows floor(plans × 8 / 100) misses: a missing entry is a no-reply miss, not a refusal of the replay, and one miss more than the allowed number fails', async () => {
    const replay = committed();
    const shared = new Map<string, number>();
    for (const entry of (await requestsOf(await loadAssistantSets(PACKS, hooks()), hooks())).values()) shared.set(entry.first, (shared.get(entry.first) ?? 0) + 1);
    // a request that two units make (the same first turns of two threads) would count as two misses when removed
    const plans = Object.keys(replay.answers).filter((values) => shared.get(values) === 1 && values.includes('Earlier turns') && replay.answers[values]?.reply.includes('"route":"ask"') === true);
    for (const values of plans.slice(0, 9)) delete replay.answers[values];
    const within = await run(replay);
    expect(within.text).toContain('at most 9 may miss');
    expect(within.text).toContain('no-reply');
    expect(within.code, within.text).toBe(0);
    delete replay.answers[plans[9] ?? ''];
    const over = await run(replay);
    expect(over.code).toBe(1);
    expect(over.text).toContain('result: fail');
  });

  it('takes the route of the repeat after a reply that is not a route, looked up under the repeat\'s own request', async () => {
    const replay = committed();
    const sets = await loadAssistantSets(PACKS, hooks());
    const requests = await requestsOf(sets, hooks());
    const first = requests.get('banking-fraud/describe-the-view');
    if (first === undefined) throw new Error('no request');
    replay.answers[first.first] = { reply: 'Here you go: {"route":"view"}' };
    replay.answers[first.repeat] = { reply: '{"route":"view"}' };
    const rescued = await run(replay);
    expect(rescued.code).toBe(0);
    expect(rescued.text).not.toContain('miss: banking-fraud/describe-the-view');
    expect(rescued.text).toContain('first reply: banking-fraud/describe-the-view text-around');
    delete replay.answers[first.repeat];
    const unrepeated = await run(replay);
    expect(unrepeated.text).toContain('miss: banking-fraud/describe-the-view failed');
  });

  it('ends a message unplaced when the repeat is not a route either', async () => {
    const replay = committed();
    const requests = await requestsOf(await loadAssistantSets(PACKS, hooks()), hooks());
    const request = requests.get('banking-fraud/describe-the-view');
    if (request === undefined) throw new Error('no request');
    replay.answers[request.first] = { reply: 'no' };
    replay.answers[request.repeat] = { reply: 'still no' };
    const unplaced = await run(replay);
    expect(unplaced.text).toContain('miss: banking-fraud/describe-the-view unplaced');
  });

  it('refuses a replay made for another router text, and one that holds an answer no message asks for, naming a count and never a wording', async () => {
    const other = committed();
    other.folders['banking-demo'] = 'f'.repeat(64);
    const refused = await run(other);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('another router text of banking-demo');
    const stray = committed();
    stray.answers['Message:\nsecret wording\n\nIn view:\n(none)'] = { reply: '{"route":"view"}' };
    const strayed = await run(stray);
    expect(strayed.code).toBe(2);
    expect(strayed.err).toContain('holds 1 answer');
    expect(strayed.err).not.toContain('secret wording');
  });

  it('prints a report of counts, causes and ids that holds no wording, reply or entity value, in text and in JSON', async () => {
    const out = io();
    await runCli(['assistant', '--packs', PACKS, '--replay', SCRIPTED, '--json'], out.io, hooks());
    const text = out.out.join('\n');
    expect(JSON.parse(text)).toMatchObject({ refusals: { total: 27, refused: 27 }, plans: { total: 119, right: 119 }, scripted: true });
    for (const secret of ['guilty', 'AC-0002000', 'same device', 'CT-00100', 'fraudster']) expect(text).not.toContain(secret);
  });

  it('refuses a run without a replay or a way to write one, and asks nothing of a model', async () => {
    const run2 = io();
    const checking = hooksWith(() => ({ failure: 'timeout' }));
    expect(await runCli(['assistant', '--packs', PACKS], run2.io, checking)).toBe(2);
    expect(checking.asked).toEqual([]);
  });
});

const THREAD_FILE = (turns: string) => `messages: []\nthreads:\n  - id: t\n    turns:\n${turns}`;
const turn = (wording: string, expect: string) => `      - message: "${wording}"\n        expect: ${expect}`;
const ASK = '{ route: ask, intent: byId, entities: { id: T-1 } }';
const CLARIFY = (candidates: string) => `{ route: clarify, intent: byId, role: id, entities: {}, candidates: [${candidates}] }`;
const T1 = '{ entityType: thing, stableId: T-1 }';
const T2 = '{ entityType: thing, stableId: T-2 }';
const ASK2 = '{ route: ask, intent: byId, entities: { id: T-2 } }';

describe('the threads of a file', () => {
  it('reads a thread of 2 to 5 turns, with a clarification after the first turn that offers elements the turns before it name', () => {
    const read = readAssistantFile(THREAD_FILE([turn('first', ASK), turn('second', ASK2), turn('which one', CLARIFY(`${T1}, ${T2}`))].join('\n')), 3);
    expect(read.threads[0]?.turns).toHaveLength(3);
  });

  it.each([
    ['one turn', THREAD_FILE(turn('first', ASK))],
    ['six turns', THREAD_FILE(Array.from({ length: 6 }, (_, index) => turn(`turn ${index}`, ASK)).join('\n'))],
    ['a clarification in the first turn', THREAD_FILE([turn('which one', CLARIFY(`${T1}, ${T2}`)), turn('second', ASK)].join('\n'))],
    ['a candidate that no earlier turn names', THREAD_FILE([turn('first', ASK), turn('which one', CLARIFY(`${T1}, ${T2}`))].join('\n'))],
    ['an unknown member of a turn', THREAD_FILE([turn('first', ASK), '      - message: "second"\n        extra: 1\n        expect: ' + ASK].join('\n'))],
    ['a clarification with one candidate', THREAD_FILE([turn('first', ASK), turn('second', ASK2), turn('which one', CLARIFY(T1))].join('\n'))],
  ])('refuses %s, naming the thread', (_name, text) => {
    expect(() => readAssistantFile(text, 3)).toThrow(UsageError);
  });

  it('refuses a candidate that only a turn outside the context window names', () => {
    const text = THREAD_FILE([turn('first', ASK), turn('second', ASK2), turn('third', ASK2), turn('fourth', ASK2), turn('which one', CLARIFY(`${T1}, ${T2}`))].join('\n'));
    expect(() => readAssistantFile(text, 3)).toThrow(/no turn of its context/);
    expect(() => readAssistantFile(text, 4)).not.toThrow();
  });
});

describe('a view turn in a thread', () => {
  const VIEW = `{ route: view, view: [${'{ entityType: thing, stableId: T-1 }'}, ${'{ entityType: thing, stableId: T-2 }'}] }`;
  const text = THREAD_FILE([turn('look at these', VIEW), turn('first', ASK), turn('which one', `{ route: clarify, intent: byId, role: id, entities: {}, candidates: [${T1}, { entityType: thing, stableId: T-2 }] }`)].join('\n'));

  it('names its elements for a later clarification, and every later turn is sent the latest view of the thread', () => {
    const file = readAssistantFile(text, 3);
    const set = { label: 'x', source: { sourceId: 'src' }, messages: [], threads: file.threads } as unknown as AssistantSet;
    const units = unitsOf([set]);
    const key = (id: string) => JSON.stringify(['node', 'src', 'thing', id]);
    expect(units.map((unit) => unit.viewKeys)).toEqual([[key('T-1'), key('T-2')], [key('T-1'), key('T-2')], [key('T-1'), key('T-2')]]);
    expect(units[1]?.earlier[0]).toMatchObject({ route: 'view', cited: [{ entityType: 'thing', stableId: 'T-1' }, { entityType: 'thing', stableId: 'T-2' }] });
  });
});

describe('the committed threads of the demo packs', () => {
  it('number at least 10 for each pack, 20 in all, with 2 clarifications, each thread having a follow-up whose wording names no id', async () => {
    const sets = await loadAssistantSets(PACKS, hooks());
    for (const set of sets) expect(set.threads.length, set.label).toBeGreaterThanOrEqual(10);
    expect(sets.reduce((total, set) => total + set.threads.length, 0)).toBeGreaterThanOrEqual(20);
    const turns = sets.flatMap((set) => set.threads.flatMap((thread) => thread.turns));
    expect(turns.filter((entry) => entry.expect.route === 'clarify').length).toBeGreaterThanOrEqual(2);
    for (const set of sets) {
      for (const thread of set.threads) {
        const followUp = thread.turns.slice(1).some((entry) => {
          if (entry.expect.route !== 'ask' && entry.expect.route !== 'clarify') return false;
          const ids = entry.expect.route === 'ask' ? Object.values(entry.expect.entities) : entry.expect.candidates.map((candidate) => candidate.stableId);
          return ids.every((id) => !entry.message.includes(id));
        });
        expect(followUp, `${set.label}/${thread.id}`).toBe(true);
      }
    }
  });

  it('hold every intent of a folder only through the messages, and every thread turn is an intent of its folder', async () => {
    const sets = await loadAssistantSets(PACKS, hooks());
    for (const set of sets) for (const thread of set.threads) for (const entry of thread.turns) if (entry.expect.route === 'ask' || entry.expect.route === 'clarify') expect(set.source.intents.map((intent) => intent.name)).toContain(entry.expect.intent);
  });
});

// Each of these reads the demo packs and runs the CLI in the process: 20 to 210 ms alone, measured on the dev machine. They timed out at 5 s only when the whole workspace's tests and a container suite ran at once, so the limit is 30 s: about 140 times the slowest run alone, still short enough to catch a hang.
describe('the threads scored over a replay', { timeout: 30_000 }, () => {
  const committed = () => JSON.parse(readFileSync(SCRIPTED, 'utf8')) as { note: string; folders: Record<string, string>; answers: Record<string, { reply: string }> };
  const firstOf = async (name: string): Promise<string> => {
    const requests = await requestsOf(await loadAssistantSets(PACKS, hooks()), hooks());
    const found = requests.get(name);
    if (found === undefined) throw new Error(`no request ${name}`);
    return found.first;
  };
  const run = async (replay: unknown) => {
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    const out = io();
    const code = await runCli(['assistant', '--packs', PACKS, '--replay', path], out.io, hooks());
    return { code, text: out.out.join('\n'), err: out.err.join('\n') };
  };

  it('scores a follow-up that names its element by the key it was shown as the stable id the key stands for', async () => {
    const replay = committed();
    const key = await firstOf('banking-fraud/device-then-merchants#2');
    expect(key).toContain('Earlier turns of this thread');
    expect(key).toMatch(/^c1 \| "AC-0002000" \| "account"$/m);
    replay.answers[key] = { reply: JSON.stringify({ route: 'ask', intent: 'merchants-an-account-paid', entities: {}, elements: { account: 'c1' } }) };
    const right = await run(replay);
    expect(right.text).not.toContain('device-then-merchants');
    replay.answers[key] = { reply: JSON.stringify({ route: 'ask', intent: 'merchants-an-account-paid', entities: {}, elements: { account: 'c9' } }) };
    expect((await run(replay)).text).toContain('miss: banking-fraud/device-then-merchants#2 wrong-entities');
  });

  it('shows turns 4 and 5 of a five-turn thread only the last 3 labelled turns', async () => {
    const fourth = await firstOf('banking-fraud/five-turns-the-last-one-named#5');
    for (const id of ['AC-0002071', 'AC-0002072']) expect(fourth).toContain(`"${id}"`);
    expect(fourth).not.toContain('"AC-0002070"');
  });

  it('scores a clarification right only with its intent, role, other roles and every candidate, and calls the other parts by their causes', async () => {
    const replay = committed();
    const key = await firstOf('banking-fraud/two-accounts-then-which#3');
    const clarify = (over: Record<string, unknown>) => ({ reply: JSON.stringify({ route: 'clarify', intent: 'merchants-an-account-paid', role: 'account', entities: {}, candidates: ['c1', 'c2'], ...over }) });
    replay.answers[key] = clarify({});
    expect((await run(replay)).text).not.toContain('two-accounts-then-which');
    replay.answers[key] = clarify({ candidates: ['c1', 'c2', 'c3'] });
    expect((await run(replay)).text).toMatch(/two-accounts-then-which#3 (wrong-candidates|unplaced|failed)/);
    replay.answers[key] = clarify({ intent: 'accounts-that-paid-an-account' });
    expect((await run(replay)).text).toContain('two-accounts-then-which#3 wrong-intent');
    replay.answers[key] = { reply: JSON.stringify({ route: 'ask', intent: 'merchants-an-account-paid', entities: { account: 'AC-0002050' } }) };
    expect((await run(replay)).text).toContain('two-accounts-then-which#3 wrong-route');
  });

  it('is built from the labels alone: a wrong reply in an earlier turn does not change the context of the next', async () => {
    const replay = committed();
    const before = await firstOf('banking-fraud/device-then-merchants#2');
    const first = await firstOf('banking-fraud/device-then-merchants#1');
    replay.answers[first] = { reply: '{"route":"view"}' };
    expect(await firstOf('banking-fraud/device-then-merchants#2')).toBe(before);
    expect((await run(replay)).text).toContain('miss: banking-fraud/device-then-merchants#1 wrong-route');
  });

  it('counts the turns with the messages in the report and holds no wording or id', async () => {
    const out = io();
    await runCli(['assistant', '--packs', PACKS, '--replay', SCRIPTED, '--json'], out.io, hooks());
    const text = out.out.join('\n');
    expect(JSON.parse(text)).toMatchObject({ refusals: { total: 27, refused: 27 }, plans: { total: 119, right: 119 } });
    for (const secret of ['AC-0002050', 'CT-00230', 'Which merchants', 'that account']) expect(text).not.toContain(secret);
  });
});

describe('the first replies of the router', () => {
  const committed = () => JSON.parse(readFileSync(SCRIPTED, 'utf8')) as { note: string; folders: Record<string, string>; answers: Record<string, { reply?: string; failure?: string }> };
  const requests = async () => requestsOf(await loadAssistantSets(PACKS, hooks()), hooks());
  const json = async (replay: unknown) => {
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    const out = io();
    const code = await runCli(['assistant', '--packs', PACKS, '--replay', path, '--json'], out.io, hooks());
    return { code, result: JSON.parse(out.out.join('\n')) as { firstReplies: Record<string, unknown> }, text: out.out.join('\n') };
  };

  it('counts each kind on a replay with a known number of each, and the rate of the first replies that were not a bare route', async () => {
    const replay = committed();
    const found = await requests();
    const at = (name: string) => found.get(name) ?? { first: '', repeat: '' };
    const bare = (route: string) => ({ reply: JSON.stringify({ route }) });
    const a = at('banking-fraud/device-then-merchants#2');
    replay.answers[a.first] = { reply: 'Here is the route: {"route":"ask","intent":"merchants-an-account-paid","entities":{"account":"AC-0002000"}}' };
    replay.answers[a.repeat] = { reply: '{"route":"ask","intent":"merchants-an-account-paid","entities":{"account":"AC-0002000"}}' };
    const b = at('banking-fraud/address-then-show#2');
    replay.answers[b.first] = { reply: 'I would show that account.' };
    replay.answers[b.repeat] = { reply: 'Still prose.' };
    const c = at('insurance-claims/address-then-phone#2');
    replay.answers[c.first] = { reply: '{"route":"view"} and that is all.' };
    const d = at('banking-fraud/two-accounts-then-which#3');
    replay.answers[d.first] = { reply: JSON.stringify({ route: 'clarify', intent: 'merchants-an-account-paid', role: 'account', entities: {}, candidates: ['c1', 'c9'] }) };
    replay.answers[d.repeat] = { reply: JSON.stringify({ route: 'clarify', intent: 'merchants-an-account-paid', role: 'account', entities: {}, candidates: ['c1', 'c2'] }) };
    replay.answers[at('insurance-claims/filed-then-policies#2').first] = { failure: 'timeout' };
    delete replay.answers[at('insurance-claims/vehicle-then-repairer#2').first];
    const counted = await json(replay);
    expect(counted.result.firstReplies).toMatchObject({ counted: 144, bare: 140, textAround: 2, wrongForm: 1, didNotFit: 1, failed: 1, noFirstReply: 1, rescued: 2, unplaced: 1, notBare: 4 });
    expect(counted.result.firstReplies['rate']).toBeCloseTo(4 / 144, 6);
    expect(counted.result.firstReplies['ids']).toEqual(expect.arrayContaining([{ name: 'banking-fraud/device-then-merchants#2', kind: 'text-around' }, { name: 'banking-fraud/two-accounts-then-which#3', kind: 'did-not-fit' }]));
  });

  it('prints the counts and the percentage in the report, by id, and holds no reply or wording', async () => {
    const replay = committed();
    const found = await requests();
    const b = found.get('banking-fraud/address-then-show#2');
    if (b === undefined) throw new Error('no request');
    replay.answers[b.first] = { reply: 'I would show that account, AC-0002010.' };
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    const out = io();
    await runCli(['assistant', '--packs', PACKS, '--replay', path], out.io, hooks());
    const text = out.out.join('\n');
    expect(text).toContain('first replies that were not a bare route: 1 of');
    expect(text).toMatch(/\(\d+\.\d%\)/);
    expect(text).not.toContain('I would show that account');
    expect(text).not.toContain('AC-0002010');
  });

  it('counts a request with no first reply apart, never as a bare route', async () => {
    const replay = committed();
    const found = await requests();
    delete replay.answers[found.get('banking-fraud/address-then-show#2')?.first ?? ''];
    const counted = await json(replay);
    expect(counted.result.firstReplies).toMatchObject({ noFirstReply: 1, counted: 145, bare: 145 });
  });
});

describe('the committed replays of the models', () => {
  const DATA = join(ROOT, 'tools', 'ask-eval', 'data', 'assistant');
  const models = readdirSync(DATA).filter((name) => name !== 'scripted' && existsSync(join(DATA, name, 'replay.json')));

  it('are the recordings of two models at least', () => {
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  it.each(models)('keep, for %s, the hash of the router text of each pack as it is now, so that no answer of the replay was recorded under another text', async (model) => {
    const replay = JSON.parse(readFileSync(join(DATA, model, 'replay.json'), 'utf8')) as { folders: Record<string, string>; answers: Record<string, unknown> };
    const given = hooks();
    for (const set of await loadAssistantSets(PACKS, given)) expect(replay.folders[set.source.sourceId]).toBe(await given.routerTextSha256(set.source));
  });

  it.each(models)('score, for %s, against their own baseline of the questions as they are now, with every request answered', async (model) => {
    const out = io();
    const code = await runCli(['assistant', '--packs', PACKS, '--replay', join(DATA, model, 'replay.json'), '--baseline', join(DATA, model, 'baseline.json')], out.io, hooks());
    expect(code, out.out.join('\n') + out.err.join('\n')).toBe(0);
    expect(out.out.join('\n')).toContain('requests with no first reply: 0');
  });
});


import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noHooks } from './test-support.js';
import { parseRepeatFile } from './schemas.js';
import { runCli } from '../cli.js';
import type { Http } from './driver.js';
import { parseManifest } from './manifest.js';

/** A run file the command wrote, read back through its schema. */
const runFile = (path: string) => parseRepeatFile(JSON.parse(readFileSync(path, 'utf8')), 'the run file');
const scratch = (): string => mkdtempSync(join(tmpdir(), 'thread-run-'));
const MANIFEST = { name: 'example', sourceId: 'demo-source', anchor: { entityType: 'widget', stableId: 'W-1' }, neighbourType: 'gadget', neighbours: 25, messages: ['one', 'two', 'three'] };
const files = (manifest: object = MANIFEST): { manifest: string; settings: string; out: string } => {
  const dir = scratch();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'product.env'), 'NEBURYX_ASSISTANT_MODEL=model-a\nNEBURYX_ASSISTANT_MAX_CALLS=7\nNEBURYX_ASK_API_KEY_FILE=/secret/key-path\nSECRET_TOKEN=SECRET-VALUE-CANARY\nNEBURYX_ASK_EFFORT=medium\n');
  return { manifest: join(dir, 'manifest.json'), settings: join(dir, 'product.env'), out: join(dir, 'out') };
};
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env: {} } };
};
const args = (f: ReturnType<typeof files>, extra: string[] = []): string[] => ['thread', 'run', '--manifest', f.manifest, '--base', 'http://127.0.0.1:8000', '--settings-file', f.settings, '--head', 'abc1234', '--arm', 'refs', ...extra];

const NODE = (entityType: string, stableId: string) => ({ ref: { sourceId: 'demo-source', entityType, stableId }, display: { title: `${entityType} ${stableId}`, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const INVESTIGATION = (n: number) => ({ id: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`, sourceId: 'demo-source', title: 'Widget W-1', caseRef: null, status: 'open', startingEntity: { entityType: 'widget', stableId: 'W-1' }, sourceState: 'available', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 });
const REFUSED = { status: 'answered', route: 'refuse', cause: 'unplaced', sentence: 'I can’t place this message. Rephrase it, or use the manual tools.' };
const WAITING = { status: 'clarification', question: 'Which one?', candidates: [{ title: 'W-2', type: 'widget', choice: { intent: 'x', roles: ['r'], entities: { id: 'W-2' }, choiceToken: `1.${'a'.repeat(64)}` } }] };

/** A stand-in of the product's HTTP surface with answers that fit the contract: it records every request and answers from a script. */
function standIn(over: { expand?: unknown; neighbours?: number; extraType?: boolean; answers?: (n: number) => { status: number; body: unknown; trace?: string | null }; throwOn?: (path: string, n: number) => boolean } = {}): { http: () => Http; requests: { method: string; path: string; body: unknown }[] } {
  const requests: { method: string; path: string; body: unknown }[] = [];
  let turn = 0;
  let opened = 0;
  const http: Http = (method, path, body) => {
    requests.push({ method, path, body });
    if (over.throwOn?.(path, turn + 1) === true) return Promise.reject(new Error('connection lost http://127.0.0.1 with SECRET'));
    const reply = (status: number, json: unknown, trace?: string) => Promise.resolve({ status, header: (name: string) => (name === 'x-trace-id' ? trace : undefined), json: () => json });
    if (path === '/v1/investigations') {
      opened += 1;
      return reply(201, { investigation: INVESTIGATION(opened), created: true, entity: NODE('widget', 'W-1'), draft: { version: 1, notes: null, basedOnViewId: null } });
    }
    if (path === '/v1/graph/expand') {
      if (over.expand !== undefined) return reply(200, over.expand);
      const count = over.neighbours ?? 25;
      const nodes = [NODE('widget', 'W-1'), ...Array.from({ length: count }, (_, index) => NODE(over.extraType === true && index === 0 ? 'other' : 'gadget', `G-${index}`))];
      return reply(200, { ref: { sourceId: 'demo-source', entityType: 'widget', stableId: 'W-1' }, pageSize: 25, nodes, edges: [], pages: [], warnings: [] });
    }
    turn += 1;
    const scripted = over.answers?.(turn) ?? { status: 200, body: REFUSED };
    return reply(scripted.status, scripted.body, scripted.trace === null ? undefined : (scripted.trace ?? `tr-${turn}`));
  };
  return { http: () => http, requests };
}

describe('the thread run command: refusals before any request', () => {
  it('refuses a key on the command line, a base that is not loopback and a missing manifest, making no request', async () => {
    const f = files();
    const s = standIn();
    for (const extra of [['--api-key', 'sk-SECRET'], ['--base', 'http://192.168.1.5:8000']]) {
      const r = io();
      const argv = extra[0] === '--base' ? args(f).map((part) => (part === 'http://127.0.0.1:8000' ? 'http://192.168.1.5:8000' : part)) : [...args(f), ...extra];
      expect(await runCli(argv, r.io, noHooks, { http: s.http })).toBe(2);
      expect(r.err.join('\n')).not.toContain('sk-SECRET');
    }
    const missing = io();
    expect(await runCli(['thread', 'run', '--base', 'http://127.0.0.1:8000'], missing.io, noHooks, { http: s.http })).toBe(2);
    expect(s.requests).toEqual([]);
  });
});

describe('the help', () => {
  it('names the key folder under the name the parser accepts, and lists the options the commands need', async () => {
    const r = io();
    expect(await runCli(['thread', 'nonsense'], r.io, noHooks)).toBe(2);
    const usage = r.err.join('\n');
    expect(usage).toContain('--key-folder <another folder>');
    expect(usage).not.toMatch(/--key </u);
    const flags = [...new Set([...usage.matchAll(/--([a-z-]+)/gu)].map((match) => match[1] ?? ''))].filter((name) => name !== 'dry-run');
    expect(flags).toEqual(expect.arrayContaining(['calibrations', 'allowed-tools', 'key-folder', 'key-file']));
  });
});

describe('the dry run', () => {
  it('prints the messages, repeats, arm, model, limit and the most calls, reads only allowlisted names of the settings file, and makes no request', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    expect(await runCli(args(f, ['--dry-run']), r.io, noHooks, { http: s.http })).toBe(0);
    expect(r.out).toEqual(['messages: 3', 'repeats: 3', 'arm: refs', 'model: model-a', 'call limit: 7', 'most model calls: 63']);
    expect(JSON.stringify(r)).not.toContain('SECRET-VALUE-CANARY');
    expect(JSON.stringify(r)).not.toContain('key-path');
    expect(s.requests).toEqual([]);
  });

  it('refuses a call limit or model that disagrees with the settings file, with zero requests made', async () => {
    const f = files();
    const s = standIn();
    for (const extra of [['--call-limit', '5'], ['--model', 'model-b']]) {
      const r = io();
      expect(await runCli(args(f, [...extra, '--dry-run']), r.io, noHooks, { http: s.http })).toBe(2);
      expect(r.err.join('\n')).toContain('disagrees with the settings');
    }
    expect(s.requests).toEqual([]);
  });
});

describe('one repeat', () => {
  it('opens a fresh investigation, builds the view of the anchor and 25 neighbours, sends the messages in order and writes a private run file with the trace ids', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    expect(await runCli(args(f, ['--repeats', '2', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(0);
    const investigations = s.requests.filter((request) => request.path === '/v1/investigations');
    expect(investigations).toHaveLength(2);
    const turns = s.requests.filter((request) => request.path === '/v1/assistant/turns');
    expect(turns.map((turn) => turn.body)).toEqual(['one', 'two', 'three', 'one', 'two', 'three'].map((message) => ({ message, investigationId: expect.any(String), sourceId: 'demo-source', viewElementKeys: expect.any(Array) })));
    const names = readdirSync(f.out).sort();
    expect(names).toEqual(['thread-refs-r1.json', 'thread-refs-r2.json']);
    const file = runFile(join(f.out, 'thread-refs-r1.json'));
    expect(file.turns.map((turn) => turn.traceId)).toEqual(['tr-1', 'tr-2', 'tr-3']);
    expect(file).toMatchObject({ ended: 'complete', head: 'abc1234', settings: { model: 'model-a', callLimit: 7 }, view: { entities: 26 } });
    expect(statSync(join(f.out, 'thread-refs-r1.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses a view that does not hold the anchor and exactly 25 neighbours of the type, and ends the repeat naming the cause with no turn sent', async () => {
    for (const over of [{ neighbours: 24 }, { neighbours: 26 }, { extraType: true }]) {
      const f = files();
      const s = standIn(over);
      const r = io();
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toEqual([]);
      const file = runFile(join(f.out, 'thread-refs-r1.json'));
      expect(file.ended).toBe('failed');
      expect(file.stoppedBecause).toMatch(/view/);
    }
  });

  it('ends the repeat at a turn that waits for a confirmation, and at a failed turn, recording both', async () => {
    for (const [answers, ended] of [[(n: number) => (n === 2 ? { status: 200, body: WAITING } : { status: 200, body: REFUSED }), 'waiting'], [(n: number) => (n === 2 ? { status: 503, body: { error: {} } } : { status: 200, body: REFUSED }), 'failed']] as const) {
      const f = files();
      const s = standIn({ answers });
      const r = io();
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      const file = runFile(join(f.out, 'thread-refs-r1.json'));
      expect(file.ended).toBe(ended);
      expect(file.turns).toHaveLength(2);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(2);
    }
  });

  it('goes on after a turn the product stopped with its own limit sentence, recording it as stopped, and ends the repeat at an unavailable turn', async () => {
    const LIMIT = { status: 'limit', limit: 'input', sentence: 'This turn grew past what it may send, so it stopped. What was read is shown above.', reads: [] };
    const f = files();
    const s = standIn({ answers: (n) => ({ status: 200, body: n === 2 ? LIMIT : REFUSED }) });
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(0);
    const file = runFile(join(f.out, 'thread-refs-r1.json'));
    expect(file.turns.map((turn) => turn.status)).toEqual(['refused', 'stopped', 'refused']);
    expect(file.ended).toBe('complete');
    const g = files();
    const down = standIn({ answers: (n) => ({ status: 200, body: n === 2 ? { status: 'unavailable', kind: 'service', readStarted: false } : REFUSED }) });
    expect(await runCli(args(g, ['--repeats', '1', '--budget', '100', '--out', g.out, '--database-env-file', g.settings]), io().io, noHooks, { http: down.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
    expect(runFile(join(g.out, 'thread-refs-r1.json')).turns.map((turn) => turn.status)).toEqual(['refused', 'failed']);
  });

  it('records a meaning answer as an answered turn, not as a stop', async () => {
    const MEANING = { status: 'meaning', described: [], noDescription: { sentence: 'The mapping has no description for RECEIVED_BY, so I cannot say what it means.', names: ['RECEIVED_BY'] } };
    const f = files();
    const s = standIn({ answers: (n) => ({ status: 200, body: n === 2 ? MEANING : REFUSED }) });
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(0);
    expect(runFile(join(f.out, 'thread-refs-r1.json')).turns.map((turn) => turn.status)).toEqual(['refused', 'answered', 'refused']);
  });

  it('writes no key, connection string or cookie text into the run file', async () => {
    const f = files();
    const s = standIn();
    await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    const text = readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8');
    expect(text).not.toMatch(/SECRET|key-path|postgres:\/\/|bolt:\/\/|set-cookie|authorization/iu);
  });
});

describe('transport failures, trace ids and outputs', () => {
  it('records a connection loss as a failed turn with the turns before it kept, and names no address or secret', async () => {
    const f = files();
    const s = standIn({ throwOn: (path, n) => path === '/v1/assistant/turns' && n === 2 });
    const r = io();
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
    const file = runFile(join(f.out, 'thread-refs-r1.json'));
    expect(file.ended).toBe('failed');
    expect(file.turns.map((turn) => turn.status)).toEqual(['refused', 'failed']);
    expect(JSON.stringify([file, r])).not.toMatch(/SECRET|127\.0\.0\.1/u);
  });

  it('ends a repeat at a turn with no trace id, and at an answer that does not fit the contract', async () => {
    for (const answers of [(n: number) => ({ status: 200, body: REFUSED, trace: n === 1 ? null : `tr-${n}` }), (n: number) => ({ status: 200, body: n === 1 ? { status: 'unknown-status' } : REFUSED })]) {
      const f = files();
      const s = standIn({ answers });
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      const file = runFile(join(f.out, 'thread-refs-r1.json'));
      expect(file.ended).toBe('failed');
      expect(file.turns).toHaveLength(1);
    }
  });

  it('refuses an arm name that could change a path, an output file that exists and an output inside a git tree, with no request made', async () => {
    const s = standIn();
    const f = files();
    for (const arm of ['../evil', 'a/b', 'x']) {
      const argv = args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]).map((part) => (part === 'refs' ? arm : part));
      expect(await runCli(argv, io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    }
    await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    const before = s.requests.length;
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    expect(s.requests).toHaveLength(before);
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', join(process.cwd(), 'inside-a-git-tree'), '--database-env-file', f.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    expect(s.requests).toHaveLength(before);
  });

  it('does not write a file whose content looks like a credential, and does not echo it', async () => {
    const f = files();
    const leaky = standIn({ answers: () => ({ status: 200, body: { ...REFUSED, sentence: 'key sk-ABCDEFGHIJKLMNOPQRSTUVWX and postgres://user:hunter2@host/db' } }) });
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: leaky.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    expect(code).toBe(2);
    expect(readdirSync(f.out)).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|ABCDEFGHIJKLMNOPQRSTUVWX/u);
  });
});

describe('the budget', () => {
  it('refuses a budget below one turn, and a budget that covers two turns stops before the third', async () => {
    const f = files();
    const r = io();
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '6', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: standIn().http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    const g = files();
    const s = standIn();
        // a budget under what every repeat is counted at is refused unless a short one is asked for: the figure of a truncated set is no figure
    const refused = io();
    expect(await runCli(args(g, ['--repeats', '1', '--budget', '14', '--out', g.out, '--database-env-file', g.settings]), refused.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    expect(refused.err.join('\n')).toContain('--short-budget');
    expect(s.requests).toEqual([]);
    expect(await runCli(args(g, ['--repeats', '1', '--budget', '14', '--short-budget', '--out', g.out, '--database-env-file', g.settings]), io().io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
    expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(2);
    const file = parseRepeatFile(JSON.parse(readFileSync(join(g.out, 'thread-refs-r1.json'), 'utf8')), 'the run file');
    expect(file.ended).toBe('budget');
  });
});

describe('the settings seen in the first turn', () => {
  it('stops the repeat after the first turn when its run record disagrees with what was verified', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve('the run record shows another call limit than the settings file') });
    expect(code).toBe(1);
    expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(1);
  });
});

describe('the production check of the first turn', () => {
  const runDb = (settings: Record<string, unknown> | undefined, fail = false): { database: () => Promise<{ db: { query: () => Promise<{ rows: Record<string, unknown>[] }> }; close: () => Promise<void> }> } => ({
    database: () => Promise.resolve({ db: { query: () => (fail ? Promise.reject(new Error('connection lost postgres://u:SECRET@h/db')) : Promise.resolve({ rows: settings === undefined ? [] : [{ id: 'run-1', outcome: 'ok', finished_at: new Date(), calls: 0, settings }] })) }, close: () => Promise.resolve() }),
  });
  const withSettings = (extra: string): ReturnType<typeof files> => {
    const f = files();
    writeFileSync(f.settings, `NEBURYX_ASSISTANT_MODEL=model-a\nNEBURYX_ASSISTANT_MAX_CALLS=7\n${extra}\n`);
    return f;
  };
  const go = async (f: ReturnType<typeof files>, deps: Record<string, unknown>) => {
    const s = standIn();
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, ...deps });
    const written = readdirSync(f.out).length === 0 ? undefined : (runFile(join(f.out, 'thread-refs-r1.json')));
    return { code, r, s, written };
  };

  it('passes when the run record shows every setting the file sets, and stops with the turn kept when any of them differs', async () => {
    const f = withSettings('NEBURYX_ASSISTANT_MAX_STEPS=5\nNEBURYX_ASSISTANT_TIMEOUT_MS=1000');
    const ok = await go(f, runDb({ model: 'model-a', maxCalls: 7, maxSteps: 5, timeoutMs: 1000 }));
    expect(ok.code).toBe(0);
    const g = withSettings('NEBURYX_ASSISTANT_MAX_STEPS=5');
    const other = await go(g, runDb({ model: 'model-a', maxCalls: 7, maxSteps: 9 }));
    expect(other.code).toBe(1);
    expect(other.written).toMatchObject({ ended: 'failed', stoppedBecause: 'the run record of the first turn shows another maxSteps than the settings file' });
    expect(other.written?.turns).toHaveLength(1);
  });

  it('treats a blank setting as the product default, as the product does, and does not compare it', async () => {
    const f = withSettings('NEBURYX_ASSISTANT_MAX_STEPS=\nNEBURYX_ASSISTANT_TIMEOUT_MS=  ');
    expect((await go(f, runDb({ model: 'model-a', maxCalls: 7, maxSteps: 12, timeoutMs: 30000 }))).code).toBe(0);
  });

  it('stops with the first turn kept when the database fails after it, naming the cause and no connection string', async () => {
    const result = await go(withSettings(''), runDb(undefined, true));
    expect(result.code).toBe(1);
    expect(result.written).toMatchObject({ ended: 'failed' });
    expect(result.written?.turns).toHaveLength(1);
    expect(JSON.stringify([result.written, result.r])).not.toContain('SECRET');
  });
});

describe('what the tool prints and sends', () => {
  it('withholds a printed line that looks like a credential, so a value of the settings never reaches the terminal as such', async () => {
    const f = files();
    writeFileSync(f.settings, 'NEBURYX_ASSISTANT_MODEL=sk-ABCDEFGHIJKLMNOPQRSTUVWX\nNEBURYX_ASSISTANT_MAX_CALLS=7\n');
    const r = io();
    expect(await runCli(args(f, ['--dry-run']), r.io, noHooks, { http: standIn().http })).toBe(0);
    expect(r.out).toContain('[a line that looked like a credential was withheld]');
    expect(JSON.stringify(r)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('refuses an output folder that does not exist or an output that is a link, before the database is read or a scorer runs', async () => {
    const f = files();
    const run = { manifest: { name: 'm', sha256: 'x' }, sourceId: 'demo', repeat: 1, expectedMessages: ['q'], arm: 'refs', head: 'h', settings: { model: 'm', callLimit: 7, configured: {} }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: [], ended: 'failed' };
    const dir = scratch();
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
    let opened = 0;
    const database = () => ((opened += 1), Promise.reject(new Error('not reached')));
    const records = (out: string) => runCli(['thread', 'records', '--file', join(dir, 'run.json'), '--database-env-file', f.settings, '--allowed-tools', 'answer', '--out', out], io().io, noHooks, { database });
    expect(await records(join(dir, 'missing', 'records.json'))).toBe(2);
    symlinkSync(join(dir, 'run.json'), join(dir, 'link.json'));
    expect(await records(join(dir, 'link.json'))).toBe(2);
    expect(opened).toBe(0);
  });
});

describe('the documented command', () => {
  it('runs: the live example of the README, with its placeholders filled, is accepted by the production check of the first turn', async () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const line = readme.split('\n').find((entry) => entry.startsWith('pnpm ask-eval thread run') && entry.includes('--budget'));
    expect(line).toBeDefined();
    const f = files();
    const fill: Record<string, string> = { '--manifest': f.manifest, '--base': 'http://127.0.0.1:8000', '--settings-file': f.settings, '--head': 'abc1234', '--arm': 'refs', '--budget': '100', '--out': f.out, '--database-env-file': f.settings };
    const argv = ['thread', 'run', ...[...(line ?? '').matchAll(/(--[a-z-]+)(?: (<[^>]*>|\S+))?/gu)].flatMap((match) => [match[1] ?? '', ...(match[2] === undefined ? [] : [fill[match[1] ?? ''] ?? match[2]])])];
    expect(argv.some((token) => token.startsWith('<'))).toBe(false);
    const db = { query: () => Promise.resolve({ rows: [{ id: 'run-1', outcome: 'ok', finished_at: new Date(), calls: 0, settings: { model: 'model-a', maxCalls: 7 } }] }) };
    const s = standIn();
    expect(await runCli(argv, io().io, noHooks, { http: s.http, database: () => Promise.resolve({ db, close: () => Promise.resolve() }) })).toBe(0);
  });
});

describe('the manifest', () => {
  it('refuses a field it does not know, a missing field and a bad message list, naming the field and no value', () => {
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, extra: 'x' }))).toThrow('a field it does not know');
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, messages: [] }))).toThrow('messages');
    expect(() => parseManifest('nope')).toThrow('not JSON');
    expect(parseManifest(JSON.stringify(MANIFEST)).manifest.messages).toEqual(['one', 'two', 'three']);
  });

  it('is written with neutral synthetic names in the public example', () => {
    const example = readFileSync(new URL('../../data/thread/manifest.example.json', import.meta.url), 'utf8');
    expect(parseManifest(example).manifest.sourceId).toBe('demo-source');
  });
});

describe('the edges view', () => {
  const EDGES = { neighbourTypes: ['gadget', 'tag'], entities: 4, relationships: 3 };
  const REF = (entityType: string, stableId: string, sourceId = 'demo-source') => ({ sourceId, entityType, stableId });
  const EDGE = (toType: string, to: string, n: number, over: { sourceId?: string; stored?: boolean; type?: string; fromType?: string; toType?: string } = {}) => ({
    ref: over.stored === false ? { sourceId: over.sourceId ?? 'demo-source', aggregate: { type: 'HAS', from: REF('widget', 'W-1'), to: REF(toType, to) } } : { sourceId: over.sourceId ?? 'demo-source', type: over.type ?? 'HAS', from: over.fromType ?? 'widget', to: over.toType ?? toType, stableId: `e-${n}` },
    from: REF('widget', 'W-1'),
    to: REF(toType, to),
    type: 'HAS',
    direction: 'out',
    semantics: 'stored',
    ...(over.stored === false ? { memberCount: { quality: 'exact', value: 2, scope: 'test' } } : {}),
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  });
  const NODES = () => [NODE('widget', 'W-1'), NODE('gadget', 'g.1'), NODE('gadget', 'g.2'), NODE('tag', 't.1')];
  const EDGE_LIST = () => [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), EDGE('tag', 't.1', 3)];
  const expand = (over: { nodes?: unknown[]; edges?: unknown[] } = {}) => ({ ref: REF('widget', 'W-1'), pageSize: 25, nodes: over.nodes ?? NODES(), edges: over.edges ?? EDGE_LIST(), pages: [], warnings: [] });
  const run = async (manifest: object, over: object) => {
    const f = files(manifest);
    const s = standIn(over);
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    return { code, s, file: runFile(join(f.out, 'thread-refs-r1.json')) };
  };

  it('is read from the manifest, and refused when it is not a list of types with the two counts, or when the anchor holds another field', () => {
    const base = { ...MANIFEST, edgesView: EDGES };
    expect(parseManifest(JSON.stringify(base)).manifest.edgesView).toEqual(EDGES);
    expect(parseManifest(JSON.stringify(MANIFEST)).manifest.edgesView).toBeUndefined();
    for (const bad of [{ ...EDGES, neighbourTypes: [] }, { ...EDGES, entities: 0 }, { ...EDGES, relationships: 1.5 }, { ...EDGES, extra: 1 }, 'text']) expect(() => parseManifest(JSON.stringify({ ...MANIFEST, edgesView: bad }))).toThrow(/edgesView/);
    const stranger = { ...MANIFEST, anchor: { ...MANIFEST.anchor, extra: 'SECRET-CANARY' } };
    expect(() => parseManifest(JSON.stringify(stranger))).toThrow(/anchor holds a field it does not know/);
    expect(() => parseManifest(JSON.stringify(stranger))).not.toThrow(/SECRET-CANARY/);
  });

  it('asks the expansion for the named types and sends, with every turn, the same keys of the entities and of the stored relationships, and records both counts', async () => {
    const { code, s, file } = await run({ ...MANIFEST, edgesView: EDGES }, { expand: expand() });
    expect(code).toBe(0);
    expect(s.requests.find((request) => request.path === '/v1/graph/expand')?.body).toMatchObject({ neighborTypes: ['gadget', 'tag'], limit: 25 });
    const expected = [
      JSON.stringify(['node', 'demo-source', 'widget', 'W-1']),
      JSON.stringify(['node', 'demo-source', 'gadget', 'g.1']),
      JSON.stringify(['node', 'demo-source', 'gadget', 'g.2']),
      JSON.stringify(['node', 'demo-source', 'tag', 't.1']),
      JSON.stringify(['edge', 'demo-source', 'stored', 'HAS', 'widget', 'gadget', 'e-1']),
      JSON.stringify(['edge', 'demo-source', 'stored', 'HAS', 'widget', 'gadget', 'e-2']),
      JSON.stringify(['edge', 'demo-source', 'stored', 'HAS', 'widget', 'tag', 'e-3']),
    ];
    const turns = s.requests.filter((request) => request.path === '/v1/assistant/turns');
    expect(turns).toHaveLength(3);
    for (const turn of turns) expect((turn.body as { viewElementKeys: string[] }).viewElementKeys).toEqual(expected);
    expect(file.view).toEqual({ entities: 4, relationships: 3 });
  });

  it.each([
    ['too few relationships', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2)] }, /relationships/],
    ['a relationship that is not a stored one', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), EDGE('tag', 't.1', 3, { stored: false })] }, /not a stored one/],
    ['a reference of another relationship type than the relationship', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), { ...EDGE('tag', 't.1', 3), type: 'OTHER' }] }, /does not agree/],
    ['a reference with other end types than the relationship', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), EDGE('tag', 't.1', 3, { toType: 'gadget' })] }, /does not agree/],
    ['a relationship twice', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.1', 1), EDGE('tag', 't.1', 3)] }, /relationship twice/],
    ['a relationship of another source', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), EDGE('tag', 't.1', 3, { sourceId: 'other' })] }, /another source/],
    ['a relationship with an end outside the view', { edges: [EDGE('gadget', 'g.1', 1), EDGE('gadget', 'g.2', 2), EDGE('tag', 'x.9', 3)] }, /end that is not an element of the view/],
    ['an element of a type the manifest does not name', { nodes: [NODE('widget', 'W-1'), NODE('gadget', 'g.1'), NODE('gadget', 'g.2'), NODE('other', 'o.1')] }, /type the manifest does not name/],
    ['an element twice', { nodes: [NODE('widget', 'W-1'), NODE('gadget', 'g.1'), NODE('gadget', 'g.1'), NODE('tag', 't.1')] }, /twice/],
    ['the anchor twice', { nodes: [NODE('widget', 'W-1'), NODE('widget', 'W-1'), NODE('gadget', 'g.1'), NODE('tag', 't.1')] }, /anchor exactly once|twice/],
    ['no anchor', { nodes: [NODE('gadget', 'g.0'), NODE('gadget', 'g.1'), NODE('gadget', 'g.2'), NODE('tag', 't.1')] }, /anchor/],
    ['an anchor of another source', { nodes: [{ ...NODE('widget', 'W-1'), ref: REF('widget', 'W-1', 'other') }, NODE('gadget', 'g.1'), NODE('gadget', 'g.2'), NODE('tag', 't.1')] }, /another source|anchor/],
    ['another number of entities', { nodes: [NODE('widget', 'W-1'), NODE('gadget', 'g.1'), NODE('tag', 't.1')] }, /entities/],
  ])('refuses a view with %s, and sends no turn', async (_name, over, cause) => {
    const { code, s, file } = await run({ ...MANIFEST, edgesView: EDGES }, { expand: expand(over) });
    expect(code).toBe(1);
    expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toEqual([]);
    expect(file.stoppedBecause).toMatch(cause);
  });
});

describe('the budget of a run', () => {
  const runWith = async (repeats: number, budget: number, extra: string[] = []) => {
    const f = files();
    const s = standIn();
    const r = io();
    const code = await runCli(args(f, ['--repeats', String(repeats), '--budget', String(budget), ...extra, '--out', f.out, '--database-env-file', f.settings]), r.io, noHooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    return { code, s, err: r.err.join('\n') };
  };

  it('is refused one below the most calls that every repeat is counted at (3 messages x 7 calls per repeat), with the whole message and no request, and accepted at it', async () => {
    for (const [repeats, most] of [[1, 21], [3, 63]] as const) {
      const below = await runWith(repeats, most - 1);
      expect(below.code).toBe(2);
      expect(below.err).toBe(`the budget ${most - 1} is below the ${most} calls that every repeat is counted at (the call limit for each turn): a run on it can stop inside a repeat; raise it, or add --short-budget to run what fits`);
      expect(below.s.requests).toEqual([]);
      const at = await runWith(repeats, most);
      expect(at.code).toBe(0);
    }
    expect((await runWith(1, 14, ['--short-budget'])).code).toBe(1);
  });
});

import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import type { Http } from './driver.js';
import { parseManifest } from './manifest.js';

const hooks = {} as unknown as EvalHooks;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'thread-run-'));
const MANIFEST = { name: 'example', sourceId: 'demo-source', anchor: { entityType: 'widget', stableId: 'W-1' }, neighbourType: 'gadget', neighbours: 25, messages: ['one', 'two', 'three'] };
const files = (): { manifest: string; settings: string; out: string } => {
  const dir = scratch();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
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
function standIn(over: { neighbours?: number; extraType?: boolean; answers?: (n: number) => { status: number; body: unknown; trace?: string | null }; throwOn?: (path: string, n: number) => boolean } = {}): { http: () => Http; requests: { method: string; path: string; body: unknown }[] } {
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
      expect(await runCli(argv, r.io, hooks, { http: s.http })).toBe(2);
      expect(r.err.join('\n')).not.toContain('sk-SECRET');
    }
    const missing = io();
    expect(await runCli(['thread', 'run', '--base', 'http://127.0.0.1:8000'], missing.io, hooks, { http: s.http })).toBe(2);
    expect(s.requests).toEqual([]);
  });
});

describe('the dry run', () => {
  it('prints the messages, repeats, arm, model, limit and the most calls, reads only allowlisted names of the settings file, and makes no request', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    expect(await runCli(args(f, ['--dry-run']), r.io, hooks, { http: s.http })).toBe(0);
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
      expect(await runCli(args(f, [...extra, '--dry-run']), r.io, hooks, { http: s.http })).toBe(2);
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
    expect(await runCli(args(f, ['--repeats', '2', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(0);
    const investigations = s.requests.filter((request) => request.path === '/v1/investigations');
    expect(investigations).toHaveLength(2);
    const turns = s.requests.filter((request) => request.path === '/v1/assistant/turns');
    expect(turns.map((turn) => (turn.body as { message: string }).message)).toEqual(['one', 'two', 'three', 'one', 'two', 'three']);
    expect((turns[0]?.body as { viewElementKeys: string[] }).viewElementKeys).toHaveLength(26);
    expect(Object.keys(turns[0]?.body as object).sort()).toEqual(['investigationId', 'message', 'sourceId', 'viewElementKeys']);
    const names = readdirSync(f.out).sort();
    expect(names).toEqual(['thread-refs-r1.json', 'thread-refs-r2.json']);
    const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { turns: { traceId: string; message: string; answer: unknown }[]; ended: string; head: string; settings: { model: string; callLimit: number }; view: { entities: number } };
    expect(file.turns.map((turn) => turn.traceId)).toEqual(['tr-1', 'tr-2', 'tr-3']);
    expect(file).toMatchObject({ ended: 'complete', head: 'abc1234', settings: { model: 'model-a', callLimit: 7 }, view: { entities: 26 } });
    expect(statSync(join(f.out, 'thread-refs-r1.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses a view that does not hold the anchor and exactly 25 neighbours of the type, and ends the repeat naming the cause with no turn sent', async () => {
    for (const over of [{ neighbours: 24 }, { neighbours: 26 }, { extraType: true }]) {
      const f = files();
      const s = standIn(over);
      const r = io();
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toEqual([]);
      const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; stoppedBecause: string };
      expect(file.ended).toBe('failed');
      expect(file.stoppedBecause).toMatch(/view/);
    }
  });

  it('ends the repeat at a turn that waits for a confirmation, and at a failed turn, recording both', async () => {
    for (const [answers, ended] of [[(n: number) => (n === 2 ? { status: 200, body: WAITING } : { status: 200, body: REFUSED }), 'waiting'], [(n: number) => (n === 2 ? { status: 503, body: { error: {} } } : { status: 200, body: REFUSED }), 'failed']] as const) {
      const f = files();
      const s = standIn({ answers });
      const r = io();
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; turns: unknown[] };
      expect(file.ended).toBe(ended);
      expect(file.turns).toHaveLength(2);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(2);
    }
  });

  it('writes no key, connection string or cookie text into the run file', async () => {
    const f = files();
    const s = standIn();
    await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    const text = readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8');
    expect(text).not.toMatch(/SECRET|key-path|postgres:\/\/|bolt:\/\/|set-cookie|authorization/iu);
  });
});

describe('transport failures, trace ids and outputs', () => {
  it('records a connection loss as a failed turn with the turns before it kept, and names no address or secret', async () => {
    const f = files();
    const s = standIn({ throwOn: (path, n) => path === '/v1/assistant/turns' && n === 2 });
    const r = io();
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
    const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; turns: { status: string }[]; stoppedBecause: string };
    expect(file.ended).toBe('failed');
    expect(file.turns.map((turn) => turn.status)).toEqual(['refused', 'failed']);
    expect(JSON.stringify([file, r])).not.toMatch(/SECRET|127\.0\.0\.1/u);
  });

  it('ends a repeat at a turn with no trace id, and at an answer that does not fit the contract', async () => {
    for (const answers of [(n: number) => ({ status: 200, body: REFUSED, trace: n === 1 ? null : `tr-${n}` }), (n: number) => ({ status: 200, body: n === 1 ? { status: 'unknown-status' } : REFUSED })]) {
      const f = files();
      const s = standIn({ answers });
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
      const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; turns: unknown[] };
      expect(file.ended).toBe('failed');
      expect(file.turns).toHaveLength(1);
    }
  });

  it('refuses an arm name that could change a path, an output file that exists and an output inside a git tree, with no request made', async () => {
    const s = standIn();
    const f = files();
    for (const arm of ['../evil', 'a/b', 'x']) {
      const argv = args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]).map((part) => (part === 'refs' ? arm : part));
      expect(await runCli(argv, io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    }
    await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    const before = s.requests.length;
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    expect(s.requests).toHaveLength(before);
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', join(process.cwd(), 'inside-a-git-tree'), '--database-env-file', f.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    expect(s.requests).toHaveLength(before);
  });

  it('does not write a file whose content looks like a credential, and does not echo it', async () => {
    const f = files();
    const leaky = standIn({ answers: () => ({ status: 200, body: { ...REFUSED, sentence: 'key sk-ABCDEFGHIJKLMNOPQRSTUVWX and postgres://user:hunter2@host/db' } }) });
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: leaky.http, verifyFirstTurn: () => () => Promise.resolve(undefined) });
    expect(code).toBe(2);
    expect(readdirSync(f.out)).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|ABCDEFGHIJKLMNOPQRSTUVWX/u);
  });
});

describe('the budget', () => {
  it('refuses a budget below one turn, and a budget that covers two turns stops before the third', async () => {
    const f = files();
    const r = io();
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '6', '--out', f.out, '--database-env-file', f.settings]), r.io, hooks, { http: standIn().http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(2);
    const g = files();
    const s = standIn();
    expect(await runCli(args(g, ['--repeats', '1', '--budget', '14', '--out', g.out, '--database-env-file', g.settings]), io().io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve(undefined) })).toBe(1);
    expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(2);
    const file = JSON.parse(readFileSync(join(g.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string };
    expect(file.ended).toBe('budget');
  });
});

describe('the settings seen in the first turn', () => {
  it('stops the repeat after the first turn when its run record disagrees with what was verified', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    const code = await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out]), r.io, hooks, { http: s.http, verifyFirstTurn: () => () => Promise.resolve('the run record shows another call limit than the settings file') });
    expect(code).toBe(1);
    expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(1);
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

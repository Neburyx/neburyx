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

/** A stand-in of the product's HTTP surface: it records every request and answers from a script. */
function standIn(over: { neighbours?: number; extraType?: boolean; answers?: (n: number) => { status: number; body: unknown } } = {}): { http: () => Http; requests: { method: string; path: string; body: unknown }[] } {
  const requests: { method: string; path: string; body: unknown }[] = [];
  let turn = 0;
  const http: Http = (method, path, body) => {
    requests.push({ method, path, body });
    const reply = (status: number, json: unknown, trace?: string) => Promise.resolve({ status, header: (name: string) => (name === 'x-trace-id' ? trace : undefined), json: () => json });
    if (path === '/v1/investigations') return reply(201, { id: `inv-${requests.length}` });
    if (path === '/v1/graph/expand') {
      const count = over.neighbours ?? 25;
      const nodes = [{ ref: { sourceId: 'demo-source', entityType: 'widget', stableId: 'W-1' } }, ...Array.from({ length: count }, (_, index) => ({ ref: { sourceId: 'demo-source', entityType: over.extraType === true && index === 0 ? 'other' : 'gadget', stableId: `G-${index}` } }))];
      return reply(200, { nodes, edges: [], pages: [] });
    }
    turn += 1;
    const scripted = over.answers?.(turn) ?? { status: 200, body: { status: 'answered', route: 'view', sentences: [], calls: 3 } };
    return reply(scripted.status, scripted.body, `tr-${turn}`);
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
      expect(r.err.join('\n')).toContain('disagrees with the settings file');
    }
    expect(s.requests).toEqual([]);
  });
});

describe('one repeat', () => {
  it('opens a fresh investigation, builds the view of the anchor and 25 neighbours, sends the messages in order and writes a private run file with the trace ids', async () => {
    const f = files();
    const s = standIn();
    const r = io();
    expect(await runCli(args(f, ['--repeats', '2', '--budget', '100', '--out', f.out]), r.io, hooks, { http: s.http })).toBe(0);
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
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out]), r.io, hooks, { http: s.http })).toBe(1);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toEqual([]);
      const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; stoppedBecause: string };
      expect(file.ended).toBe('failed');
      expect(file.stoppedBecause).toMatch(/view/);
    }
  });

  it('ends the repeat at a turn that waits for a confirmation, and at a failed turn, recording both', async () => {
    for (const [answers, ended] of [[(n: number) => (n === 2 ? { status: 200, body: { status: 'confirmation', pendingId: 'p' } } : { status: 200, body: { status: 'answered', route: 'view' } }), 'waiting'], [(n: number) => (n === 2 ? { status: 503, body: { error: {} } } : { status: 200, body: { status: 'answered', route: 'view' } }), 'failed']] as const) {
      const f = files();
      const s = standIn({ answers });
      const r = io();
      expect(await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out]), r.io, hooks, { http: s.http })).toBe(1);
      const file = JSON.parse(readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8')) as { ended: string; turns: unknown[] };
      expect(file.ended).toBe(ended);
      expect(file.turns).toHaveLength(2);
      expect(s.requests.filter((request) => request.path === '/v1/assistant/turns')).toHaveLength(2);
    }
  });

  it('writes no key, connection string or cookie text into the run file', async () => {
    const f = files();
    const s = standIn();
    await runCli(args(f, ['--repeats', '1', '--budget', '100', '--out', f.out]), io().io, hooks, { http: s.http });
    const text = readFileSync(join(f.out, 'thread-refs-r1.json'), 'utf8');
    expect(text).not.toMatch(/SECRET|key-path|postgres:\/\/|bolt:\/\/|set-cookie|authorization/iu);
  });
});

describe('the budget', () => {
  it('refuses a budget below one turn, and a budget that covers two turns stops before the third', async () => {
    const f = files();
    const r = io();
    expect(await runCli(args(f, ['--repeats', '1', '--budget', '6', '--out', f.out]), r.io, hooks, { http: standIn().http })).toBe(2);
    const g = files();
    const s = standIn();
    expect(await runCli(args(g, ['--repeats', '1', '--budget', '14', '--out', g.out]), io().io, hooks, { http: s.http })).toBe(1);
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

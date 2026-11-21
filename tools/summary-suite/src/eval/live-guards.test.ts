import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCases } from '../cases.js';
import { cli } from '../testing/harness.js';
import { realHooks } from '../testing/eval-hooks.js';
import type { EvalHooks } from './hooks.js';

const outside = mkdtempSync(join(tmpdir(), 'nbx-eval-out-'));
afterAll(() => rmSync(outside, { recursive: true, force: true }));
const GUARD = { NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '100000' };

/** Hooks whose live provider is scripted and counted: how often it was built and how many requests it answered. */
function counted(): { readonly hooks: EvalHooks<ModelProvider>; readonly built: { count: number }; readonly requests: { count: number } } {
  const built = { count: 0 };
  const requests = { count: 0 };
  const hooks: EvalHooks<ModelProvider> = {
    ...realHooks,
    liveProvider: async (_env, _folder, settings) => {
      built.count += 1;
      const inner = realHooks.scriptedProvider(() => JSON.stringify({ sentences: [{ text: 'quill haverd is also linked to AC-7001.', cites: ['n1'] }] }));
      return { provider: { complete: (request, signal) => (requests.count += 1, inner.complete(request, signal)) }, model: settings.model };
    },
  };
  return { hooks, built, requests };
}

describe('a live run, before any call', () => {
  it('is refused, with exit 2 and before the provider is built, without a budget, an output folder or an Ask folder', async () => {
    const spy = counted();
    const missing = [
      { args: ['--out', join(outside, 'a'), '--folder', 'f'], env: GUARD, said: '--budget' },
      { args: ['--budget', '30', '--folder', 'f'], env: GUARD, said: '--out' },
      { args: ['--budget', '30', '--out', join(outside, 'a')], env: GUARD, said: '--folder' },
    ];
    for (const each of missing) {
      const result = await cli(each.args, each.env, spy.hooks);
      expect(result.code, each.said).toBe(2);
      expect(result.err.join('\n')).toContain(each.said);
    }
    expect(spy.built.count).toBe(0);
  });

  it('refuses an output folder inside a git working tree, before the provider is built', async () => {
    const spy = counted();
    const result = await cli(['--budget', '30', '--out', join(import.meta.dirname, 'out'), '--folder', 'f'], GUARD, spy.hooks);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('inside a git working tree');
    expect(spy.built.count).toBe(0);
  });

  it('refuses a key in the environment with exit 2 and no stack, naming the file variable and never the key', async () => {
    const result = await cli(['--budget', '30', '--out', join(outside, 'k'), '--folder', 'f'], { ...GUARD, NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE' });
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('NEBURYX_ASK_API_KEY_FILE');
    expect(result.err.join('\n')).not.toContain('SENTINEL-KEY-VALUE');
    expect(result.err.join('\n')).not.toMatch(/\n\s+at /u);
  });

  it('writes its record with mode 0600 in an owner-only folder, holding figures only and no sentence and no name, and refuses a second run over it before any call', async () => {
    const spy = counted();
    const out = join(outside, 'run');
    const args = ['--budget', '60', '--out', out, '--folder', 'f', '--views', 'aml-cycle'];
    const result = await cli(args, GUARD, spy.hooks);
    expect(result.code).toBe(0);
    const file = join(out, 'run-record.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o077).toBe(0);
    expect(result.text).toContain('names kept: Quill Haverd');
    const record = readFileSync(file, 'utf8');
    expect(record).toContain('"namesKept": 1');
    expect(record).not.toContain('linked to AC-7001');
    for (const name of loadCases().syntheticNames) expect(record, name).not.toContain(name);
    const before = { built: spy.built.count, requests: spy.requests.count };
    const again = await cli(args, GUARD, spy.hooks);
    expect(again.code).toBe(2);
    expect(again.err.join('\n')).toContain('already there');
    expect({ built: spy.built.count, requests: spy.requests.count }).toEqual(before);
  });
});

describe('a local run of the summary evaluation', () => {
  const localHooks = (label: { kind: 'anthropic' | 'local'; grammar?: boolean; grammarPrompts?: string[]; probe?: 'accepted' }): EvalHooks<ModelProvider> => ({
    ...realHooks,
    liveProvider: async (_env, _folder, settings) => ({ provider: realHooks.scriptedProvider(() => JSON.stringify({ sentences: [{ text: 'quill haverd is also linked to AC-7001.', cites: ['n1'] }] })), model: settings.model, label }),
  });

  it('prints the provider, the grammar label, the schema probe and the time of a call, and writes them to the record, as figures and names only', async () => {
    const out = join(outside, 'local');
    const result = await cli(['--budget', '60', '--out', out, '--folder', 'f', '--views', 'aml-cycle'], GUARD, localHooks({ kind: 'local', grammar: true, grammarPrompts: ['case-summary'], probe: 'accepted' }));
    expect(result.code).toBe(0);
    expect(result.text).toContain('provider: local, grammar on');
    expect(result.text).toContain('grammar prompts: case-summary');
    expect(result.text).toContain('schema probe: accepted');
    expect(result.text).toMatch(/time of a call: median \d+ ms, 95th percentile \d+ ms/);
    const record = JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8')) as { provider: unknown; usage: { medianMs: number; p95Ms: number } };
    expect(record.provider).toEqual({ kind: 'local', grammar: true, grammarPrompts: ['case-summary'], probe: 'accepted' });
    expect(record.usage).toMatchObject({ medianMs: expect.any(Number), p95Ms: expect.any(Number) });
  });

  it('writes no provider line for an Anthropic run, so that its output stays as it was', async () => {
    const out = join(outside, 'anthropic');
    const result = await cli(['--budget', '60', '--out', out, '--folder', 'f', '--views', 'aml-cycle'], GUARD, localHooks({ kind: 'anthropic' }));
    expect(result.code).toBe(0);
    expect(result.text).not.toContain('provider:');
    expect(JSON.parse(readFileSync(join(out, 'run-record.json'), 'utf8'))).not.toHaveProperty('provider');
  });
});

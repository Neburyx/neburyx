import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptRecordOf, type ModelProvider } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { realHooks } from '../testing/eval-hooks.js';
import { cli } from '../testing/harness.js';
import type { EvalHooks } from './hooks.js';

const roots: string[] = [];
const folderOf = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'nbx-removed-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(out, { mode: 0o700 });
  return out;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PLANTED = 'zzplantedzz an uncited sentence.';
const reply = JSON.stringify({ sentences: [{ text: 'The accounts AC-3001 and AC-3002 connect from the address ip-00000.', cites: ['n1', 'n2', 'n3', 'e1', 'e2'] }, { text: PLANTED, cites: [] }] });

const replying: EvalHooks<ModelProvider> = {
  ...realHooks,
  scriptedProvider: () => ({ complete: async (request) => ({ status: 'ok', text: reply, usage: { kind: 'known', inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) }) }),
};
const ARGS = ['--stub', '--views', 'gateway-address-with-a-business-title', '--json'];
const removedSchema = z.object({ views: z.array(z.object({ id: z.string(), sentences: z.array(z.object({ text: z.string(), cites: z.array(z.string()), reason: z.string() })) })) });

describe('the sentences the checks removed, written only when asked', () => {
  it('writes nothing of a sentence by default: not in the report, not in the folder', async () => {
    const out = folderOf();
    const result = await cli([...ARGS, '--out', out], {}, replying);
    expect(result.code).toBe(0);
    expect(result.text).not.toContain('zzplantedzz');
    expect(readdirSync(out)).toEqual([]);
  });

  it('writes each removed sentence with its cites and its reason to a private file in the folder, and still none in the report', async () => {
    const out = folderOf();
    const result = await cli([...ARGS, '--out', out, '--removed'], {}, replying);
    expect(result.text).not.toContain('zzplantedzz');
    const file = join(out, 'removed-sentences.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(removedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).views).toEqual([{ id: 'gateway-address-with-a-business-title', sentences: [{ text: PLANTED, cites: [], reason: 'citation' }] }]);
  });

  it('refuses the flag without a folder, and refuses to replace the file without --force, before anything is written', async () => {
    const without = await cli([...ARGS, '--removed'], {}, replying);
    expect(without.code).toBe(2);
    expect(without.err.join('\n')).toContain('--removed needs --out');
    const out = folderOf();
    await cli([...ARGS, '--out', out, '--removed'], {}, replying);
    const again = await cli([...ARGS, '--out', out, '--removed'], {}, replying);
    expect(again.code).toBe(2);
    expect(existsSync(join(out, 'removed-sentences.json'))).toBe(true);
  });
});

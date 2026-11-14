import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiMappingView, AiSettings } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveProviderError, liveProvider } from './live-provider.js';

const SENTINEL_KEY = 'sk-test-SENTINEL-0123456789';
const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }] };
const folder = mkdtempSync(join(tmpdir(), 'live-provider-'));
const SIGNAL = new AbortController().signal;
let server: Server;
let baseUrl: string;
let seenModels: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seenModels.push(String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model));
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: SENTINEL_KEY } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

function keyFile(mode: number, text = SENTINEL_KEY): string {
  const path = join(folder, `key-${mode.toString(8)}-${text.length}`);
  writeFileSync(path, `${text}\n`);
  chmodSync(path, mode);
  return path;
}

const settings = (key: AiSettings['key'], extra: Partial<AiSettings> = {}): AiSettings => ({ preview: true, provider: 'anthropic', model: 'model-one', key, ...extra });
const attempt = (value: AiSettings | undefined, model?: string) => liveProvider({ settings: value, model, view: VIEW, env: {}, baseUrl });

describe('the provider of a recording run', () => {
  it('refuses a key file that others can read, an empty one and a missing one, before any call', async () => {
    await expect(attempt(settings({ file: keyFile(0o644) }))).rejects.toThrow(/owner-only/);
    await expect(attempt(settings({ file: keyFile(0o600, '') }))).rejects.toThrow(LiveProviderError);
    await expect(attempt(settings({ file: join(folder, 'absent') }))).rejects.toThrow(/does not exist/);
    expect(seenModels).toEqual([]);
  });

  it('refuses a key given as an environment variable, and a mapping with no ai settings', async () => {
    await expect(attempt(settings({ env: 'SOME_VARIABLE' }))).rejects.toThrow(/ai\.key\.env is not used/);
    await expect(attempt(undefined)).rejects.toThrow(/no ai settings/);
  });

  it('refuses prompt replacements before any call, because the planner records the built-in prompts', async () => {
    await expect(attempt(settings({ file: keyFile(0o600) }, { prompts: { 'ask.plan': '/somewhere/prompt.txt' } }))).rejects.toThrow(/ai\.prompts replacements/);
    expect(seenModels).toEqual([]);
  });

  it('names the model of the settings, or the one given for the step-up, and makes a call without retrying it', async () => {
    const path = keyFile(0o600);
    const first = await attempt(settings({ file: path }));
    expect(first.model).toBe('model-one');
    const stepped = await attempt(settings({ file: path }), 'model-two');
    expect(stepped.model).toBe('model-two');
    seenModels = [];
    const answer = await stepped.provider.complete({ promptId: 'summary.view', parameters: { view: 'a synthetic view' } }, SIGNAL);
    expect(answer.status).toBe('failed');
    expect(seenModels).toEqual(['model-two']);
  });

  it('puts the key in no message and no answer, whether the provider is refused or a call fails', async () => {
    const messages: string[] = [];
    for (const value of [settings({ file: keyFile(0o644) }), settings({ env: 'SOME_VARIABLE' })]) {
      await attempt(value).catch((error: unknown) => messages.push(String(error instanceof Error ? error.message : error)));
    }
    const built = await attempt(settings({ file: keyFile(0o600) }));
    const answer = await built.provider.complete({ promptId: 'summary.view', parameters: { view: 'a synthetic view' } }, SIGNAL);
    expect(JSON.stringify([messages, answer])).not.toContain('SENTINEL');
  });
});

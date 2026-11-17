import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAILURE_CODES, promptRecordOf, type FailureCode, type ModelAnswer, type ModelProvider, type ModelRequest, type TokenUsage } from './provider.js';

const PROMPT: ModelAnswer['prompt'] = { id: 'test.prompt', version: 1, sha256: 'a'.repeat(64) };

describe('the request of the provider interface', () => {
  it('holds a prompt id, a version, optional fixed instructions and the values, and nothing else', () => {
    const request: ModelRequest = { promptId: 'test.prompt', version: 1, instructions: 'Answer in one word.', values: '‹account#1›' };
    expect(Object.keys(request).sort()).toEqual(['instructions', 'promptId', 'values', 'version']);
  });

  it('refuses at compile time every field that could carry a tool or a sampling setting', () => {
    // @ts-expect-error tools
    const tools: ModelRequest = { promptId: 'test.prompt', version: 1, values: '', tools: [] };
    // @ts-expect-error messages
    const messages: ModelRequest = { promptId: 'test.prompt', version: 1, values: '', messages: [] };
    // @ts-expect-error a system text under another name
    const system: ModelRequest = { promptId: 'test.prompt', version: 1, values: '', system: 'x' };
    // @ts-expect-error a sampling setting
    const temperature: ModelRequest = { promptId: 'test.prompt', version: 1, values: '', temperature: 0 };
    // @ts-expect-error the values are text
    const objectValues: ModelRequest = { promptId: 'test.prompt', version: 1, values: { x: 1 } };
    // @ts-expect-error the version is required
    const noVersion: ModelRequest = { promptId: 'test.prompt', values: '' };
    expect([tools, messages, system, temperature, objectValues, noVersion]).toHaveLength(6);
  });

  it('records the id, the version and the SHA-256 of the fixed instructions, never of the values', () => {
    const request: ModelRequest = { promptId: 'test.prompt', version: 2, instructions: 'Answer in one word.', values: 'first' };
    const record = promptRecordOf(request);
    expect(record).toMatchObject({ id: 'test.prompt', version: 2 });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(promptRecordOf({ ...request, values: 'second' })).toEqual(record);
    expect(promptRecordOf({ ...request, instructions: 'Answer in two words.' }).sha256).not.toBe(record.sha256);
  });

  it('hashes no instructions as the SHA-256 of nothing', () => {
    expect(promptRecordOf({ promptId: 'test.prompt', version: 1, values: 'x' }).sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('the answer of the provider interface', () => {
  function describeAnswer(answer: ModelAnswer): string {
    switch (answer.status) {
      case 'ok':
        return `ok ${answer.text}`;
      case 'refused':
        return 'refused';
      case 'failed':
        return `failed ${answer.code}`;
      default: {
        const unreachable: never = answer;
        return unreachable;
      }
    }
  }

  function missingACase(answer: ModelAnswer): string {
    switch (answer.status) {
      case 'ok':
        return 'ok';
      case 'refused':
        return 'refused';
      default: {
        // @ts-expect-error the failed case is not handled
        const unreachable: never = answer;
        return unreachable;
      }
    }
  }

  it('is handled by an exhaustive switch', () => {
    expect(describeAnswer({ status: 'ok', text: 'draft', usage: { kind: 'known', inputTokens: 1, outputTokens: 2 }, model: 'claude-sonnet-5-5', prompt: PROMPT })).toBe('ok draft');
    expect(describeAnswer({ status: 'refused', usage: { kind: 'unknown' }, prompt: PROMPT })).toBe('refused');
    for (const code of FAILURE_CODES) expect(describeAnswer({ status: 'failed', code, prompt: PROMPT })).toBe(`failed ${code}`);
    expect(missingACase({ status: 'refused', usage: { kind: 'unknown' }, prompt: PROMPT })).toBe('refused');
  });

  it('names every failure of a call with one code', () => {
    const codes: readonly FailureCode[] = FAILURE_CODES;
    expect(codes).toEqual(['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated']);
  });

  it('carries the prompt record on every variant', () => {
    // @ts-expect-error the prompt record is required on a failed answer
    const failed: ModelAnswer = { status: 'failed', code: 'timeout' };
    // @ts-expect-error the prompt record is required on a refused answer
    const refused: ModelAnswer = { status: 'refused', usage: { kind: 'unknown' } };
    expect([failed, refused]).toHaveLength(2);
  });

  it('shows an unknown count as unknown and never as a number', () => {
    const unknown: TokenUsage = { kind: 'unknown' };
    // @ts-expect-error a number cannot stand for a count that is not known
    const number: TokenUsage = 0;
    // @ts-expect-error an unknown count has no token fields
    const withTokens: TokenUsage = { kind: 'unknown', inputTokens: 0, outputTokens: 0 };
    expect([unknown, number, withTokens]).toHaveLength(3);
  });
});

describe('the usage of a failed answer', () => {
  it('may be absent, known or unknown, and refuses at compile time anything else', () => {
    const absent: ModelAnswer = { status: 'failed', code: 'truncated', prompt: PROMPT };
    const known: ModelAnswer = { status: 'failed', code: 'truncated', usage: { kind: 'known', inputTokens: 12, outputTokens: 256 }, prompt: PROMPT };
    const unknown: ModelAnswer = { status: 'failed', code: 'timeout', usage: { kind: 'unknown' }, prompt: PROMPT };
    // @ts-expect-error a bare number is not a usage
    const number: ModelAnswer = { status: 'failed', code: 'truncated', usage: 0, prompt: PROMPT };
    expect([absent, known, unknown, number]).toHaveLength(4);
  });
});

describe('the provider', () => {
  it('is called with a request and an abort signal, and nothing else', async () => {
    const provider: ModelProvider = { complete: async () => ({ status: 'refused', usage: { kind: 'unknown' }, prompt: PROMPT }) };
    expect((await provider.complete({ promptId: 'test.prompt', version: 1, values: '' }, new AbortController().signal)).status).toBe('refused');
    // @ts-expect-error a third required argument is not part of the interface
    const extra: ModelProvider = { complete: async (_request: ModelRequest, _signal: AbortSignal, _more: string) => ({ status: 'refused', usage: { kind: 'unknown' }, prompt: PROMPT }) };
    // @ts-expect-error the signal is not optional for a caller
    void provider.complete({ promptId: 'test.prompt', version: 1, values: '' });
    expect(extra).toBeDefined();
  });
});

describe('the sources of the package', () => {
  const sourceFolder = fileURLToPath(new URL('.', import.meta.url));
  const filesUnder = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(folder, entry.name)) : entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [join(folder, entry.name)] : []));
  const productionFiles = filesUnder(sourceFolder).map((path) => relative(sourceFolder, path));
  const SDK_FILE = 'anthropic.ts';
  const FORBIDDEN = [/@anthropic-ai\//, /node:http/, /node:https/, /node:net\b/, /node:tls/, /\bundici\b/, /\bfetch\(/];

  it('includes the testing folder in what is scanned', () => {
    expect(productionFiles).toContain(join('testing', 'fixture.ts'));
  });

  it.each(productionFiles.filter((file) => file !== SDK_FILE))('%s imports no provider SDK and no network module', (file) => {
    const text = readFileSync(join(sourceFolder, file), 'utf8');
    for (const pattern of FORBIDDEN) expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
  });

  it('lets only the provider file import the client library, and no other network module', () => {
    const text = readFileSync(join(sourceFolder, SDK_FILE), 'utf8');
    for (const pattern of FORBIDDEN.slice(1)) expect(text, `${SDK_FILE} matches ${pattern}`).not.toMatch(pattern);
    expect([...text.matchAll(/from '(@anthropic-ai\/[^']+)'/g)].map((match) => match[1])).toEqual(['@anthropic-ai/sdk']);
  });

  it('lists no network package and only one pinned client library as a dependency', () => {
    const manifest = readFileSync(join(sourceFolder, '..', 'package.json'), 'utf8');
    for (const pattern of [/undici/, /"openai"/, /langchain/i]) expect(manifest).not.toMatch(pattern);
    const { dependencies } = JSON.parse(manifest) as { dependencies: Record<string, string> };
    expect(Object.keys(dependencies).filter((name) => name.startsWith('@anthropic-ai/'))).toEqual(['@anthropic-ai/sdk']);
    expect(dependencies['@anthropic-ai/sdk']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

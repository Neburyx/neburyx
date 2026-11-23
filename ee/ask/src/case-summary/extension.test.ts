import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEnterpriseExtension } from '../index.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';

afterAll(removeAskFolders);

const CONTEXT = { sourceIds: ['s1'] };
const envFor = (folder: string) => ({ NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE', NEBURYX_ASK_MAPPING_FOLDER: folder });

describe('the summary instructions in the extension', () => {
  it('holds no instructions before it is configured', () => {
    expect(createEnterpriseExtension().summaryInstructions('s1')).toBeUndefined();
  });

  it('builds the instructions from the shipped files when it is configured', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, envFor(makeAskFolder(['s1'])), CONTEXT);
    expect(outcome).toEqual({ ok: true });
    expect(extension.summaryInstructions('s1')?.text).toContain('# Reply format');
    expect(extension.summaryInstructions('s1')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('holds none when Ask itself is refused', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k' }, CONTEXT);
    expect(outcome?.ok).toBe(false);
    expect(extension.summaryInstructions('s1')).toBeUndefined();
  });
});

describe('a shipped summary file that cannot be read stops start-up', () => {
  it('is refused through the real configure, naming the file and the replacing setting and holding no path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-ext-'));
    try {
      const extension = createEnterpriseExtension({ shippedSummaryDirectory: `${directory}/` });
      const outcome = await extension.configure?.({}, envFor(makeAskFolder(['s1'])), CONTEXT);
      expect(outcome?.ok).toBe(false);
      const message = outcome !== undefined && !outcome.ok ? outcome.problems.join('\n') : '';
      expect(message).toContain('summary-prompt.md');
      expect(message).toContain('NEBURYX_SUMMARY_PROMPT_FILE');
      expect(message).not.toContain(directory);
      expect(extension.summaryInstructions('s1')).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('every bad summary file stops start-up through the real configure, with no path or text in the message or the log', () => {
  const SENTINEL = 'SENTINEL-FILE-TEXT';
  const lines: string[] = [];
  const recordLine = (...parts: unknown[]): void => void lines.push(JSON.stringify(parts));
  const logger = { debug: recordLine, info: recordLine, warn: recordLine, error: recordLine, fatal: recordLine, trace: recordLine, child: () => logger };

  async function configured(env: Record<string, string>, shippedSummaryDirectory?: string) {
    const extension = createEnterpriseExtension(shippedSummaryDirectory === undefined ? {} : { shippedSummaryDirectory });
    extension.attachLogger?.(logger);
    return extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['s1']), ...env }, CONTEXT);
  }

  it.each([
    ['NEBURYX_SUMMARY_PROMPT_FILE', 'relative'],
    ['NEBURYX_SUMMARY_TYPOLOGY_FILE', 'relative'],
    ['NEBURYX_SUMMARY_PROMPT_FILE', 'missing'],
    ['NEBURYX_SUMMARY_TYPOLOGY_FILE', 'oversized'],
    ['NEBURYX_SUMMARY_PROMPT_FILE', 'not-utf8'],
    ['NEBURYX_SUMMARY_TYPOLOGY_FILE', 'unreadable'],
    ['NEBURYX_SUMMARY_PROMPT_FILE', 'directory'],
    ['NEBURYX_SUMMARY_PROMPT_FILE', 'empty'],
  ])('refuses %s set to a %s file', async (setting, kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-bad-'));
    try {
      const paths: Record<string, string> = {
        relative: `relative-${SENTINEL}.md`,
        missing: join(directory, `missing-${SENTINEL}.md`),
        oversized: join(directory, 'big.md'),
        'not-utf8': join(directory, 'bad.md'),
        unreadable: join(directory, 'closed.md'),
        directory: join(directory, 'a-directory'),
        empty: join(directory, 'empty.md'),
      };
      writeFileSync(paths['empty'] ?? '', '');
      mkdirSync(paths['directory'] ?? '');
      writeFileSync(paths['oversized'] ?? '', `${SENTINEL}${'x'.repeat(70_000)}`);
      writeFileSync(paths['not-utf8'] ?? '', Buffer.from([0xff, 0xfe, 0xfd]));
      writeFileSync(paths['unreadable'] ?? '', SENTINEL);
      chmodSync(paths['unreadable'] ?? '', 0o000);
      const outcome = await configured({ [setting]: paths[kind] ?? '' });
      chmodSync(paths['unreadable'] ?? '', 0o600);
      expect(outcome?.ok).toBe(false);
      const message = outcome !== undefined && !outcome.ok ? outcome.problems.join('\n') : '';
      expect(message).toContain(setting);
      for (const secret of [SENTINEL, directory]) {
        expect(message).not.toContain(secret);
        expect(lines.join('\n')).not.toContain(secret);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['oversized', 'not-utf8', 'unreadable'])('refuses a %s shipped file naming it and the replacing setting', async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-shipped-'));
    try {
      const prompt = join(directory, 'summary-prompt.md');
      writeFileSync(prompt, kind === 'oversized' ? `${SENTINEL}${'x'.repeat(70_000)}` : kind === 'unreadable' ? SENTINEL : Buffer.from([0xff, 0xfe]));
      if (kind === 'unreadable') chmodSync(prompt, 0o000);
      const outcome = await configured({}, `${directory}/`);
      chmodSync(prompt, 0o600);
      expect(outcome?.ok).toBe(false);
      const message = outcome !== undefined && !outcome.ok ? outcome.problems.join('\n') : '';
      expect(message).toContain('summary-prompt.md');
      expect(message).toContain('NEBURYX_SUMMARY_PROMPT_FILE');
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain(directory);
      expect(lines.join('\n')).not.toContain(directory);
      expect(lines.join('\n')).not.toContain(SENTINEL);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the token key files at start-up through the real configure', () => {
  const SENTINEL = 'SENTINEL-KEY-CONTENT';
  const HEX = 'ab'.repeat(32);

  async function configuredWith(env: Record<string, string>) {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['s1']), NEBURYX_SUMMARY_MAX_INPUT_TOKENS: '50000', ...env }, CONTEXT);
    return { extension, outcome };
  }

  it('leaves the summary unavailable, naming the setting, until a key file is set, and available once it is', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-token-'));
    try {
      const without = await configuredWith({});
      expect(without.outcome).toEqual({ ok: true });
      expect(without.extension.summaryAvailability()).toEqual({ available: false, reason: 'NEBURYX_SUMMARY_TOKEN_KEY_FILE is not set' });
      const path = join(directory, 'key');
      writeFileSync(path, HEX, { mode: 0o600 });
      const withKey = await configuredWith({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: path });
      expect(withKey.extension.summaryAvailability()).toEqual({ available: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['a group-readable file', 0o640, HEX, 'owner-only'],
    ['a file that is not a 256-bit key', 0o600, `${SENTINEL}`, '256-bit key'],
  ])('refuses %s, naming the setting and printing neither path nor content', async (_name, mode, content, expected) => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-token-'));
    try {
      const path = join(directory, 'key');
      writeFileSync(path, content);
      chmodSync(path, mode);
      const { extension, outcome } = await configuredWith({ NEBURYX_SUMMARY_TOKEN_KEY_FILE: path });
      expect(outcome?.ok).toBe(false);
      const message = outcome !== undefined && !outcome.ok ? outcome.problems.join('\n') : '';
      expect(message).toContain('NEBURYX_SUMMARY_TOKEN_KEY_FILE');
      expect(message).toContain(expected);
      expect(message).not.toContain(path);
      expect(message).not.toContain(SENTINEL);
      expect(extension.summaryAvailability().available).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

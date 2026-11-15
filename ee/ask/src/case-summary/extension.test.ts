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
    expect(createEnterpriseExtension().summaryInstructions()).toBeUndefined();
  });

  it('builds the instructions from the shipped files when it is configured', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, envFor(makeAskFolder(['s1'])), CONTEXT);
    expect(outcome).toEqual({ ok: true });
    expect(extension.summaryInstructions()?.text).toContain('# Reply format');
    expect(extension.summaryInstructions()?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('holds none when Ask itself is refused', async () => {
    const extension = createEnterpriseExtension();
    const outcome = await extension.configure?.({}, { NEBURYX_ASK_API_KEY: 'k' }, CONTEXT);
    expect(outcome?.ok).toBe(false);
    expect(extension.summaryInstructions()).toBeUndefined();
  });
});

describe('a shipped summary file that cannot be read stops start-up', () => {
  it('is refused through the real configure, naming the file and the replacing setting and holding no path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'case-summary-ext-'));
    try {
      writeFileSync(join(directory, 'summary-prompt.md'), 'prompt');
      const extension = createEnterpriseExtension({ shippedSummaryDirectory: `${directory}/` });
      const outcome = await extension.configure?.({}, envFor(makeAskFolder(['s1'])), CONTEXT);
      expect(outcome?.ok).toBe(false);
      const message = outcome !== undefined && !outcome.ok ? outcome.problems.join('\n') : '';
      expect(message).toContain('aml-typologies.md');
      expect(message).toContain('NEBURYX_SUMMARY_TYPOLOGY_FILE');
      expect(message).not.toContain(directory);
      expect(extension.summaryInstructions()).toBeUndefined();
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
      };
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
      writeFileSync(join(directory, 'aml-typologies.md'), 'typology');
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

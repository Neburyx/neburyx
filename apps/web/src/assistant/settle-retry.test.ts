import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTLE_RETRY_MS } from './settle-retry.js';

const read = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8');

describe('the waits after a turn was answered, shared by the chat list and the thread', () => {
  it('are 0.6 s, 1.5 s and 3 s, each longer than the one before', () => {
    expect(SETTLE_RETRY_MS).toEqual([600, 1500, 3000]);
    expect(SETTLE_RETRY_MS.every((wait, index) => index === 0 || wait > (SETTLE_RETRY_MS[index - 1] ?? 0))).toBe(true);
  });

  it('are taken from this one file by the chat list and by the thread sync, and neither makes a list of its own', () => {
    for (const file of ['chat-list/use-chat-list.ts', 'use-thread-sync.ts']) {
      const source = read(file);
      expect(source, file).toMatch(/import \{ SETTLE_RETRY_MS \} from '\.\.?\/(\.\.\/)?settle-retry\.js'|import \{ SETTLE_RETRY_MS \} from '(\.\.\/)?\.\/settle-retry\.js'|import \{ SETTLE_RETRY_MS \} from '\.\.\/settle-retry\.js'/u);
      expect(source, file).not.toMatch(/(const|let) SETTLE_RETRY_MS/u);
      expect(source, file).not.toMatch(/\[\s*600\s*,/u);
    }
  });
});

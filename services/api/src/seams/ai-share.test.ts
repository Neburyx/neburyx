import { describe, expect, it } from 'vitest';
import { AI_SLOT_SHARE_VARIABLE, DEFAULT_AI_SLOT_SHARE, readAiSlotShare } from './ai-share.js';

const read = (value: string | undefined) => readAiSlotShare({ [AI_SLOT_SHARE_VARIABLE]: value });

describe('the share of the read slots that AI reads may take', () => {
  it('is half when the setting is not given or empty', () => {
    expect(readAiSlotShare({})).toEqual({ ok: true, share: DEFAULT_AI_SLOT_SHARE });
    expect(read('')).toEqual({ ok: true, share: 0.5 });
  });

  it.each([['0.25', 0.25], ['.1', 0.1], ['1', 1], ['1.0', 1], ['0.5', 0.5]])('takes %s', (text, share) => {
    expect(read(text)).toEqual({ ok: true, share });
  });

  it.each(['0', '0.0', '1.5', '-0.2', '2', 'half', '50%', '0.5x', ' 0.5', '1e-1', 'NaN'])('refuses %s, naming the setting and never the value', (text) => {
    const result = read(text);
    expect(result).toEqual({ ok: false, problem: `${AI_SLOT_SHARE_VARIABLE} must be a number above 0 and up to 1` });
  });
});

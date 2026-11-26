import { SOURCE_UNAVAILABLE_ENTRIES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { FAILURE_CODES_WITH_WORDS } from '../failure-words.js';
import { codesIn } from '../patterns/no-codes.js';
import { groupFailedText, groupFailureText, moreFailedText } from './copy.js';

describe('the lines of a search group that was not read', () => {
  it.each(FAILURE_CODES_WITH_WORDS)('words %s with no code, for the results, further pages and the Add tab', (code) => {
    const lines = [groupFailedText('exact', code, undefined), groupFailedText('context', code, undefined), moreFailedText('related', code, undefined), groupFailureText('startsWith', code, undefined)];
    for (const line of lines) expect(codesIn(line)).toEqual([]);
  });

  it('says an unavailable source did not answer, naming the group it left unread', () => {
    expect(moreFailedText('related', 'SOURCE_UNAVAILABLE', undefined)).toBe(`More related records were not read. ${SOURCE_UNAVAILABLE_ENTRIES.unreachable.message}`);
  });
});

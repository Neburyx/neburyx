import { describe, expect, it } from 'vitest';
import { expectNothingStartedSince } from './assistant-checks.js';

describe('the check that nothing started after a cancel', () => {
  it('passes when nothing more began', () => {
    expect(() => expectNothingStartedSince({ reads: 4, modelCalls: 2 }, { reads: 4, modelCalls: 2 })).not.toThrow();
  });

  it('canary: fails a read and a model call that began after the cancel', () => {
    expect(() => expectNothingStartedSince({ reads: 4, modelCalls: 2 }, { reads: 5, modelCalls: 2 })).toThrow('a read of the source started');
    expect(() => expectNothingStartedSince({ reads: 4, modelCalls: 2 }, { reads: 4, modelCalls: 3 })).toThrow('a call to the model started');
  });
});

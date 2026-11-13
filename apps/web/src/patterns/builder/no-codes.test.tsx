import { ERROR_CODES, PATTERN_PROBLEM_CODES } from '@neburyx/contracts';
import type { PatternValidateResponse } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import { assertNoCodes } from '../no-codes.js';
import { failure } from '../patterns-kit.js';
import { afterDebounce, buildStep, builderPanel, builderWorkspace, chooseStart, cleanup, openBuilder } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Answer = ApiResult<PatternValidateResponse>;

async function built(validate: () => Promise<Answer>) {
  await builderWorkspace({ validate });
  await openBuilder();
  await chooseStart('n-a');
  await buildStep(1, 'out', 'n-b', ['r-1']);
  await afterDebounce();
}

describe('what the editor shows when the check fails or finds problems', () => {
  it.each(ERROR_CODES)('shows no code when the check fails with %s', async (code) => {
    await built(async () => ({ ok: false, failure: failure(code, code === 'RATE_LIMITED' ? { retryAfterMs: 5000 } : undefined) }));
    assertNoCodes(builderPanel().textContent ?? '', `the editor after ${code}`);
    expect(builderPanel().textContent).not.toContain(code);
  });

  it.each(['NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'SCHEMA_MISMATCH', 'ABORTED', 'UNEXPECTED_FAILURE'] as const)('shows no code when the check fails with the client’s %s', async (code) => {
    await built(async () => ({ ok: false, failure: { code } as never }));
    assertNoCodes(builderPanel().textContent ?? '', `the editor after ${code}`);
  });

  it('shows no code for a problem of any code at the start, a step, a condition, a window or the top', async () => {
    const places: (string | number)[][] = [['anchorType'], ['steps', 0, 'relationshipTypes'], ['steps', 0, 'conditions', 0], ['steps', 0, 'window'], ['steps']];
    const problems = PATTERN_PROBLEM_CODES.flatMap((code) => places.map((path) => ({ path, code })));
    await built(async () => ({ ok: true, value: { status: 'invalid', problems } as PatternValidateResponse }));
    assertNoCodes(builderPanel().textContent ?? '', 'the editor with every problem');
    expect(builderPanel().textContent).not.toMatch(/\b(unknown-key|wrong-type|too-many|bad-value|bad-shape)\b/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatternListResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { listed, openBuiltIn, patternsWorkspace, settle } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const HOLDS = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Devices week', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });
const page = (): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [HOLDS], nextCursor: null } });

describe('the form under a built-in card', () => {
  it('shows the glyph of the type a built-in pattern reaches on its card, and no summary line', async () => {
    await patternsWorkspace();
    await openBuiltIn();
    const card = screen.getByRole('button', { name: 'Shared devices' });
    expect(card.querySelector('img.pattern-card-glyph')).not.toBeNull();
    expect(card.closest('li')?.textContent).not.toMatch(/→/);
  });

  it('keeps Escape for the view on screen: while a saved run is on its way, Escape cancels it and leaves the panel open though a built-in card is chosen in the list behind it', async () => {
    let signal: AbortSignal | undefined;
    const kit = await patternsWorkspace({
      patterns: {
        listPatterns: async () => page(),
        runSavedPattern: (_id, _request, _key, given) => {
          signal = given;
          return new Promise(() => undefined);
        },
      },
    });
    await openBuiltIn();
    await userEvent.click(screen.getByRole('button', { name: 'Run Devices week' }));
    await settle();
    expect(kit.patternCalls.filter((call) => call.method === 'runSavedPattern')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to patterns' }), { key: 'Escape' });
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('complementary', { name: 'Patterns' })).toBeTruthy();
  });
});

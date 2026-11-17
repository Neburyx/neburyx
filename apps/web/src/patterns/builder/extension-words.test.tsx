import { renderHook, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PatternDefinition, PatternPreview } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { builderProfile } from './builder-kit.js';
import { draftWords } from './draft-words.js';
import { ExtensionCard } from './extension-card.js';
import { breaksOf, type BuilderState, type Draft } from './model.js';
import { PatternEditor } from './pattern-editor.js';
import { usePatternWords } from './use-words.js';

const PREVIEW = (text: string): PatternPreview => ({ start: { type: 'n-a', name: 'N-A', text: 'Start' }, steps: [{ relationshipTypes: ['r-self'], direction: 'out', arrivesAt: { type: 'n-a', name: 'N-A' }, text, conditions: [] }], bounds: { hopLimit: { value: 4, text: 'a' }, pageLimit: { value: 50, text: 'b' }, countCap: { value: 500, text: 'c' } } });
const definition = (atLeast: number): PatternDefinition => ({ anchorType: 'n-a', steps: [{ relationshipTypes: ['r-self'], direction: 'out', arrivesAt: 'n-a', fan: { atLeast } }] });
const clientOf = (answer: (atLeast: number) => string) => {
  const previewPattern = vi.fn((request: { definition: PatternDefinition }) => Promise.resolve({ ok: true as const, value: { status: 'ok' as const, preview: PREVIEW(answer(request.definition.steps[0]?.fan?.atLeast ?? 0)) } }));
  return { client: { previewPattern } as unknown as ApiClient, previewPattern };
};

describe('the words of a pattern with a fan, a time order or a closing, in the builder', () => {
  it('asks for none, and shows none, for a definition that is not using them (the ordinary builder makes no request)', () => {
    const { client, previewPattern } = clientOf(() => 'x');
    const { result } = renderHook(() => usePatternWords(client, 'a', false, undefined, undefined));
    expect(result.current).toBeUndefined();
    expect(previewPattern).not.toHaveBeenCalled();
  });

  it('never returns the words of the definition before: a changed definition shows nothing until its own answer is in', async () => {
    const { client } = clientOf((atLeast) => `words for ${atLeast}`);
    const first = definition(3);
    const second = definition(4);
    const { result, rerender } = renderHook(({ current }: { current: PatternDefinition }) => usePatternWords(client, 'a', false, current, JSON.stringify(current)), { initialProps: { current: first } });
    await waitFor(() => expect(result.current?.steps[0]?.text).toBe('words for 3'));
    rerender({ current: second });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.steps[0]?.text).toBe('words for 4'));
  });

  it('says a kept, marked step in words with its reason under it, and the card of a marked step is not valid', () => {
    const profile = builderProfile();
    const draft: Draft = { anchorType: 'n-a', steps: [{ direction: 'out', arrivesAt: 'n-a', relationshipTypes: ['r-self'] }, { direction: 'out', arrivesAt: 'n-a', relationshipTypes: ['r-self'], after: 'previous' }] };
    const lines = draftWords(profile, draft, (type) => type ?? '', breaksOf(profile, draft, false), []);
    expect(lines[0]?.text).toBe('Start: n-a');
    expect(lines[2]).toMatchObject({ text: 'Step 2: follow r-self forward to n-a, after the previous step (no time in the mapping)', bad: 'Kept, not valid: Step 2: “after the previous step” needs a time in the mapping. r-self has none.' });
    expect(lines[1]?.bad).toBeUndefined();
    render(<ExtensionCard profile={profile} draft={draft} index={1} nameOf={(type) => type ?? ''} wrong />);
    expect(screen.getByText('Not valid')).toBeTruthy();
    expect(screen.getByText('Kept and marked. Not editable yet.')).toBeTruthy();
    expect(screen.getByText('no time in the mapping')).toBeTruthy();
  });
});

describe('the editor with a pattern that uses the kinds', () => {
  const timed = () => {
    const base = builderProfile();
    return { ...base, relationshipTypes: base.relationshipTypes.map((row) => ({ ...row, observedAt: 'when' })) };
  };
  const hop = (extra: Partial<Draft['steps'][number]> = {}): Draft['steps'][number] => ({ direction: 'out', arrivesAt: 'n-a', relationshipTypes: ['r-self'], ...extra });
  const editorOf = (steps: Draft['steps'], client: ApiClient, profile = timed()) => {
    const state: BuilderState = { draft: { anchorType: 'n-a', steps } };
    return render(<PatternEditor profile={{ kind: 'ready', profile } as never} retryProfile={() => undefined} client={client} sourceId="a" sourceName="a" mask={false} maxHops={4} state={state} dispatch={() => undefined} onCancel={() => undefined} onPreview={() => undefined} startRef={null} />);
  };
  const answers = (validate: unknown, preview?: PatternPreview) => ({
    validatePattern: vi.fn(() => Promise.resolve({ ok: true as const, value: validate })),
    previewPattern: vi.fn(() => Promise.resolve({ ok: true as const, value: { status: 'ok' as const, preview: preview ?? PREVIEW('Step 1: follow r-self forward to at least 3 other N-As') } })),
  });

  it('shows the server’s words with the extension phrase accented, once the check says valid', async () => {
    const mock = answers({ status: 'ok' }, { ...PREVIEW('Step 1: follow r-self forward to at least 3 other N-As'), steps: [{ ...PREVIEW('Step 1: follow r-self forward to at least 3 other N-As').steps[0], fan: { atLeast: 3, direction: 'out', text: 'at least 3 other N-As' } } as never] });
    editorOf([hop({ fan: { atLeast: 3 } })], mock as unknown as ApiClient);
    const words = await screen.findByRole('region', { name: 'In words' }, { timeout: 3000 });
    expect(within(words).getByText('at least 3 other N-As').className).toBe('pattern-words-tag');
    expect(mock.previewPattern).toHaveBeenCalledTimes(1);
  });

  it('keeps the words of a step the source refused, marked with the reason, and marks its card', async () => {
    const mock = answers({ status: 'invalid', problems: [{ path: ['steps', 0, 'fan', 'atLeast'], code: 'over-ceiling' }] });
    editorOf([hop({ fan: { atLeast: 900 } })], mock as unknown as ApiClient);
    const words = await screen.findByRole('region', { name: 'In words' }, { timeout: 3000 });
    expect(within(words).getByText(/Kept, not valid: /)).toBeTruthy();
    expect(within(words).getByText(/^Step 1: follow r-self forward to at least 900 other/i).className).toBe('pattern-words-bad');
    expect(mock.previewPattern).not.toHaveBeenCalled();
  });

  it('says a refused step with every kind it carries, a closing with a fan and an order included, in the marked sentence', async () => {
    const mock = answers({ status: 'invalid', problems: [{ path: ['steps', 1, 'fan', 'atLeast'], code: 'over-ceiling' }] });
    editorOf([hop(), hop({ fan: { atLeast: 900 }, after: 'previous', closesAtAnchor: true })], mock as unknown as ApiClient);
    const words = await screen.findByRole('region', { name: 'In words' }, { timeout: 3000 });
    const line = within(words).getByText(/^Step 2: /);
    expect(line.textContent).toBe('Step 2: follow r-self forward and close back at the start N-A with at least 900 other N-As to choose from, after the previous step (by when)');
    expect(line.className).toBe('pattern-words-bad');
  });

  it('makes no preview request for a pattern that uses none of the kinds', async () => {
    const mock = answers({ status: 'ok' });
    editorOf([hop()], mock as unknown as ApiClient);
    await waitFor(() => expect(mock.validatePattern).toHaveBeenCalled(), { timeout: 3000 });
    expect(mock.previewPattern).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'In words' })).toBeNull();
  });
});

import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ASK_MAX_RESOLUTIONS, type Count } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { answerOf } from '../search/search-test-kit.js';
import { ref } from '../state/test-data.js';
import { node } from '../state/test-data.js';
import { answerAsk, answerSearch, blockedOf, drawAsk, field, previewOf, REF, server, SOURCE } from './ask-kit.js';

afterEach(cleanup);

const widget = (stableId: string, title = stableId) => ({ ...node(SOURCE, stableId), ref: ref(SOURCE, 'widget', stableId), display: { title, type: 'widget' } });

async function blocked(question = 'which zorvat share', token = { text: 'zorvat', start: 6, end: 12 }) {
  const harness = drawAsk();
  await userEvent.click(field());
  await userEvent.paste(question);
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await answerAsk(harness.asks[0], blockedOf(token));
  return harness;
}

describe('Pick an entity', () => {
  it('opens a picker with the search for the word in the same source, exact and masked, and the focus on a result list', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    expect(searches).toHaveLength(1);
    expect(searches[0]?.request).toEqual({ sourceId: SOURCE, text: 'zorvat', matchModes: ['exact'], mask: true });
    expect(screen.getByRole('group', { name: 'Choose an entity for “zorvat”' })).toBeTruthy();
  });

  it('adds a pick for the word and asks for a new preview with all the picks when a result is chosen', async () => {
    const { searches, asks } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[0], { ok: true, value: answerOf(SOURCE, [widget('w-1', 'Z••• Q•••')]) });
    await userEvent.click(screen.getByRole('button', { name: /Z••• Q•••/ }));
    expect(asks).toHaveLength(2);
    expect(asks[1]?.request).toEqual({ message: 'which zorvat share', sourceId: SOURCE, resolutions: [{ start: 6, end: 12, ref: ref(SOURCE, 'widget', 'w-1') }], send: false });
    await answerAsk(asks[1], previewOf('which ‹widget#1› share'));
    expect(screen.queryByRole('group', { name: /Choose an entity/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });

  it('lists a hit without a reference and cannot choose it', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[0], { ok: true, value: answerOf(SOURCE, [], { exactUnreferenced: [{ entityType: 'widget', title: 'x', properties: [], reason: 'no-stable-id' }] }) });
    expect(screen.getByText('Found, but it has no reference, so it cannot be chosen.')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: /Choose an entity/ })).queryAllByRole('button').map((button) => button.textContent)).toEqual(['Search', 'Cancel']);
  });

  it('says so when nothing is found, when the search fails and when it is rate-limited, with Retry only where it helps', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[0], { ok: true, value: answerOf(SOURCE, []) });
    expect(screen.getByText('Nothing was found for this word in this source.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[1], server('RATE_LIMITED', { retryAfterMs: 4000 }));
    expect(screen.getByText('You can try again in 4 s.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await answerSearch(searches[2], server('ACCESS_DENIED', { reason: 'ai-preview-off' }));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('keeps the text and the card, and sends nothing to the model, when the picker fails', async () => {
    const { searches, asks } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[0], server('SOURCE_UNAVAILABLE', { reason: 'unreachable' }));
    expect(field().value).toBe('which zorvat share');
    expect(screen.getByRole('heading', { level: 3, name: "“zorvat” can't be sent to the model" })).toBeTruthy();
    expect(asks).toHaveLength(1);
  });

  it('closes the picker with Cancel and Escape, and Escape closes the card next and the panel last', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Choose an entity/ })).toBeNull();
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { level: 3, name: "“zorvat” can't be sent to the model" })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });
});

describe('Use as a search value', () => {
  it('adds a value pick for the word and asks for a new preview', async () => {
    const { asks } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    expect(asks[1]?.request.resolutions).toEqual([{ start: 6, end: 12, value: true }]);
  });

  it('is not offered for a word that cannot be a value', async () => {
    await blocked('which (zorvat) share', { text: '(zorvat)', start: 6, end: 14 });
    expect(screen.queryByRole('button', { name: 'Use as a search value' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pick an entity' })).toBeTruthy();
  });
});

describe('a clarification', () => {
  const clarification = { start: 6, end: 9, choices: [REF('w-1'), REF('w-2')], count: { quality: 'exact' as const, value: 2, scope: 'exact matches' }, unreferenced: 0 };

  async function clarified() {
    const harness = drawAsk();
    await userEvent.type(field(), 'which Qux share');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], { ok: true, value: { clarification } });
    return harness;
  }

  it('asks Do you mean with one chip for each choice and Cancel, says no plan run, and shows no preview', async () => {
    await clarified();
    expect(screen.getByRole('heading', { level: 3, name: 'Do you mean…?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'widget · w-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'widget · w-2' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Awaiting clarification · no plan run');
    expect(screen.queryByRole('region', { name: 'What the model will receive' })).toBeNull();
  });

  it('adds the pick for the clarification range and asks for a new preview when a chip is chosen', async () => {
    const { asks } = await clarified();
    await userEvent.click(screen.getByRole('button', { name: 'widget · w-2' }));
    expect(asks[1]?.request.resolutions).toEqual([{ start: 6, end: 9, ref: REF('w-2') }]);
    await answerAsk(asks[1], previewOf('which ‹widget#1› share'));
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
  });

  it('goes with Cancel and keeps the text', async () => {
    await clarified();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(field().value).toBe('which Qux share');
  });

  it('writes how many fit when there are more than chips, in the quality words of the search', async () => {
    const harness = drawAsk();
    await userEvent.type(field(), 'which Qux');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], { ok: true, value: { clarification: { ...clarification, count: { quality: 'lowerBound', value: 14, scope: 'exact matches' } } } });
    expect(screen.getByText('2 shown of ≥ 14 · lower bound')).toBeTruthy();
  });
});

describe('the picks', () => {
  it('drops the picks and says the choice no longer fits when the server refuses them', async () => {
    const { searches, asks } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    await answerAsk(asks[1], server('INVALID_REQUEST', { reason: 'out-of-range' }));
    expect(screen.getByText('Your choice no longer fits the text. Pick again.')).toBeTruthy();
    expect(field().value).toBe('which zorvat share');
    expect(searches).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(asks[2]?.request.resolutions).toBeUndefined();
  });

  it('moves a pick with the text before it and drops a pick that an edit touches', async () => {
    const { asks } = await blocked('which zorvat share');
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    await answerAsk(asks[1], previewOf('which ‹value#1› share'));
    await userEvent.click(field());
    field().setSelectionRange(0, 0);
    await userEvent.keyboard('so ');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(asks[2]?.request.resolutions).toEqual([{ start: 9, end: 15, value: true }]);
    await answerAsk(asks[2], previewOf('so which ‹value#1› share'));
    await userEvent.click(field());
    field().setSelectionRange(10, 10);
    await userEvent.keyboard('x');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(asks[3]?.request.resolutions).toBeUndefined();
  });

  it('disables Pick an entity, Use as a search value and the chips at the limit, and says why', async () => {
    const harness = drawAsk();
    await userEvent.click(field());
    await userEvent.paste('a b c d e f g h i j k');
    for (let index = 0; index < ASK_MAX_RESOLUTIONS; index += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
      await answerAsk(harness.asks[index], blockedOf({ text: 'abcdefghij'.charAt(index), start: index * 2, end: index * 2 + 1 }));
      if (index < ASK_MAX_RESOLUTIONS - 1) await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    await answerAsk(harness.asks[ASK_MAX_RESOLUTIONS], blockedOf({ text: 'k', start: 20, end: 21 }));
    expect((screen.getByRole('button', { name: 'Pick an entity' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Use as a search value' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Ten choices is the most. Remove a word or edit the question.')).toBeTruthy();
  });

  it('cancels a request in flight, clears the picks and takes the card away when the source changes', async () => {
    const { asks, state } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    const pending = asks[1];
    state.bindSource('other');
    await userEvent.click(document.body);
    expect(pending?.signal?.aborted).toBe(true);
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(asks[2]?.request.resolutions).toBeUndefined();
    expect(asks[2]?.request.sourceId).toBe('other');
  });
});

describe('the picker search field', () => {
  it('is filled with the word, has the focus, and searches the text typed in it when asked', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    const box = screen.getByRole('textbox', { name: 'Search for the word' });
    expect((box as HTMLInputElement).value).toBe('zorvat');
    expect(document.activeElement).toBe(box);
    await userEvent.clear(box);
    await userEvent.type(box, 'zorvath{Enter}');
    expect(searches).toHaveLength(2);
    expect(searches[1]?.request).toEqual({ sourceId: SOURCE, text: 'zorvath', matchModes: ['exact'], mask: true });
    expect(searches[0]?.signal?.aborted).toBe(true);
  });

  it('searches nothing for an empty search field', async () => {
    const { searches } = await blocked();
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search for the word' }));
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(searches).toHaveLength(1);
  });
});

describe('where the focus goes after a choice', () => {
  it('moves to the new card after a result, a chip, a search value and Remove the word, so the keyboard goes on', async () => {
    const { searches, asks } = await blocked('which zorvat share');
    await userEvent.click(screen.getByRole('button', { name: 'Pick an entity' }));
    await answerSearch(searches[0], { ok: true, value: answerOf(SOURCE, [widget('w-1')]) });
    await userEvent.click(screen.getByRole('button', { name: /w-1/ }));
    await answerAsk(asks[1], previewOf('which ‹widget#1› share'));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'What the model will receive' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit question' }));
    expect(document.activeElement).toBe(field());
  });

  it('moves to the clarification card when it is drawn, and to the next card after a chip', async () => {
    const harness = drawAsk();
    await userEvent.type(field(), 'which Qux');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], { ok: true, value: { clarification: { start: 6, end: 9, choices: [REF('w-1')], count: { quality: 'exact', value: 1, scope: 'exact matches' }, unreferenced: 0 } } });
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Do you mean…?' }));
    await userEvent.click(screen.getByRole('button', { name: 'widget · w-1' }));
    await answerAsk(harness.asks[1], previewOf('which ‹widget#1›'));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'What the model will receive' }));
  });

  it('draws a preview that replaces a preview with the focus on it again', async () => {
    const { asks } = await blocked('which zorvat share');
    await userEvent.click(screen.getByRole('button', { name: 'Use as a search value' }));
    await answerAsk(asks[1], previewOf('which ‹value#1› share'));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'What the model will receive' }));
  });
});

describe('the count beside the chips', () => {
  const draw = async (count: Count) => {
    const harness = drawAsk();
    await userEvent.type(field(), 'which Qux');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], { ok: true, value: { clarification: { start: 6, end: 9, choices: [REF('w-1'), REF('w-2')], count, unreferenced: 0 } } });
  };

  it.each([
    ['exact', { quality: 'exact' as const, value: 14, scope: 'exact matches' }, '2 shown of 14'],
    ['a lower bound', { quality: 'lowerBound' as const, value: 14, scope: 'exact matches' }, '2 shown of ≥ 14 · lower bound'],
  ])('says how many fit, in the words of the search, for %s', async (_name, count, words) => {
    await draw(count);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it.each([
    ['unknown', { quality: 'unknown' as const, scope: 'exact matches' }],
    ['exact and no larger than the chips', { quality: 'exact' as const, value: 2, scope: 'exact matches' }],
  ])('says nothing for a count that is %s', async (_name, count) => {
    await draw(count);
    expect(screen.queryByText(/shown of/)).toBeNull();
  });
});

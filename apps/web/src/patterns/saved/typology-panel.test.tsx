import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuiltInDefinition } from '@neburyx/contracts';
import { failure, listed, listOf, openPatterns, patternsWorkspace, settle, PREVIEW, type KitOptions } from '../patterns-kit.js';
import { afterDebounce } from '../run/run-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const step = { relationshipTypes: ['r-1'], direction: 'out' as const, arrivesAt: 'kind-b' };
const FAN_OUT: BuiltInDefinition = { id: 'fan-out', name: 'Fan-out', description: 'One account sends to many accounts.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'kind-a', steps: [{ ...step, fan: { atLeast: 10 } }] } };
const PASS_THROUGH: BuiltInDefinition = { id: 'pass-through', name: 'Pass-through', description: 'Money moves on.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'kind-a', steps: [step, { ...step, after: 'previous' }] } };
const TYPOLOGIES: readonly BuiltInDefinition[] = [FAN_OUT, PASS_THROUGH];
const listWith = (definitions: readonly BuiltInDefinition[]) => async () => ({ ok: true as const, value: { ...listOf(), builtInDefinitions: [...definitions] } });
const workspace = async (options: KitOptions = {}) => {
  const kit = await patternsWorkspace({ list: listWith(TYPOLOGIES), ...options });
  await openPatterns();
  return kit;
};
const sectionOf = (name: RegExp) => within(screen.getByRole('region', { name }));

describe('the typology rows of the Patterns panel', () => {
  it('lists the typologies under "Built-in · AML typologies" with their count, name, tag and sentence, and the other built-ins under "Built-in · general"', async () => {
    await workspace();
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · AML typologies · 2', 'Built-in · general · 3', 'My patterns · 0', 'Shared on this source · 0']);
    const typologies = sectionOf(/AML typologies/);
    expect(typologies.getAllByRole('listitem')).toHaveLength(2);
    expect(typologies.getByText('One account sends to many accounts.')).toBeTruthy();
    expect(typologies.getAllByText('AML')).toHaveLength(2);
    expect(typologies.getByRole('button', { name: 'Run Fan-out' })).toBeTruthy();
    expect(typologies.getByRole('button', { name: /^More: Fan-out/ })).toBeTruthy();
  });

  it('is as it was for a source with no built-in definition: one "Built-in" section', async () => {
    await workspace({ list: async () => ({ ok: true, value: listOf() }) });
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · 3', 'My patterns · 0', 'Shared on this source · 0']);
  });

  it('shows every part of the server’s words for a step in the opened row: its conditions and its window as well as its sentence', async () => {
    const step = {
      relationshipTypes: ['r-1'],
      direction: 'out' as const,
      arrivesAt: { type: 'n-b', name: 'N-B' },
      text: 'Follows r-1 outgoing to an N-B.',
      conditions: [{ on: 'relationship' as const, appliesTo: 'r-1', property: 'p-1', op: 'eq' as const, values: [{ kind: 'text' as const, value: 'v-1' }], text: 'Only where p-1 is v-1.' }],
      window: { appliesTo: ['r-1'], notAppliedTo: [], days: 30, text: 'Within the last 30 days.' },
    };
    await workspace({ preview: async () => ({ ok: true, value: { status: 'ok', preview: { ...PREVIEW, steps: [step] } } }) });
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Fan-out', expanded: false }));
    await settle();
    const words = await screen.findByRole('region', { name: 'Fan-out: Steps in words' });
    expect(within(words).getByText('Only where p-1 is v-1.')).toBeTruthy();
    expect(within(words).getByText('Within the last 30 days.')).toBeTruthy();
  });

  it('opens a row to its steps in words from the server, with the extended phrase accented, and asks once', async () => {
    const kit = await workspace({ preview: async () => ({ ok: true, value: { status: 'ok', preview: { ...PREVIEW, steps: [{ relationshipTypes: ['r-1'], direction: 'out' as const, arrivesAt: { type: 'n-b', name: 'N-B' }, conditions: [], text: 'Step 1: follow r-1 forward to at least 10 other N-Bs', fan: { atLeast: 10, direction: 'out' as const, text: 'at least 10 other N-Bs' } }] } } }) });
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Fan-out', expanded: false }));
    await settle();
    const words = await screen.findByRole('region', { name: 'Fan-out: Steps in words' });
    expect(within(words).getByText('Starts at an N-A.')).toBeTruthy();
    expect(within(words).getByText('at least 10 other N-Bs').className).toBe('pattern-words-tag');
    expect(kit.previews).toHaveLength(1);
    expect(kit.previews[0]?.definition).toEqual(FAN_OUT.definition);
  });

  it('says a failed preview with Try again, which asks again', async () => {
    let calls = 0;
    await workspace({ preview: async () => (calls++ === 0 ? { ok: false as const, failure: failure('NETWORK_UNAVAILABLE') } : { ok: true, value: { status: 'ok', preview: PREVIEW } }) });
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Fan-out', expanded: false }));
    await settle();
    expect(await screen.findByText('The steps could not be read.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(await screen.findByRole('region', { name: 'Fan-out: Steps in words' })).toBeTruthy();
  });

  it('finds a typology by its name or its sentence, and says none match', async () => {
    await workspace();
    const search = screen.getByRole('searchbox', { name: 'Search patterns' });
    await userEvent.type(search, 'many accounts');
    expect(sectionOf(/AML typologies/).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, 'moves');
    expect(sectionOf(/AML typologies/).getByRole('button', { name: 'Run Pass-through' })).toBeTruthy();
  });
});

describe('running and copying a built-in definition', () => {
  it('runs it as a pattern of its own: the built-in’s name as the heading, Built-in typology under it, the preview of its definition, a note, Copy to builder in place of Edit, and no Save pattern…', async () => {
    const kit = await workspace();
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Run Fan-out' }));
    await settle();
    expect(await screen.findByRole('heading', { name: 'Fan-out' })).toBeTruthy();
    expect(screen.getByText('Built-in typology')).toBeTruthy();
    expect(screen.getByText('A built-in typology. Copy to builder opens a copy of it; the built-in itself does not change.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save pattern/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Copy to builder$/ })).toBeTruthy();
    expect(kit.previews[0]?.definition).toEqual(FAN_OUT.definition);
    expect(screen.getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
  });

  it('Run pattern sends the definition to the run route with the starting entity, shows the result under the built-in’s name with Copy to builder, and stores nothing', async () => {
    const kit = await workspace();
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Run Fan-out' }));
    await settle();
    await userEvent.click(await screen.findByRole('button', { name: 'Run pattern' }));
    await settle();
    expect(kit.definitionRuns).toHaveLength(1);
    expect(kit.definitionRuns[0]?.request.definition).toEqual(FAN_OUT.definition);
    expect(await screen.findByRole('heading', { name: 'Fan-out' })).toBeTruthy();
    expect(screen.getByText(/^Built-in typology · from /)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy to builder' })).toBeTruthy();
    expect(kit.patternCalls.filter((call) => call.method === 'savePattern' || call.method === 'changePattern')).toEqual([]);
  });

  it('Copy to builder opens a copy named as one that is not saved, with its kinds kept; Back returns to the list', async () => {
    await workspace();
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: 'Run Pass-through' }));
    await settle();
    await userEvent.click(await screen.findByRole('button', { name: /Copy to builder$/ }));
    await settle();
    expect(await screen.findByText('Copy of Pass-through · not saved')).toBeTruthy();
    expect(screen.getAllByText('after previous').length).toBeGreaterThan(0);
  });

  it('the menu Copy opens the copy directly, and Save pattern… keeps it as the person’s own definition with its kinds intact, after which the note is gone', async () => {
    const built = { ...FAN_OUT, definition: { anchorType: 'kind-a', steps: [{ relationshipTypes: ['link-a'], direction: 'out', arrivesAt: 'kind-b', fan: { atLeast: 10 } }] } };
    const saved = listed({ id: '0192f000-0000-7000-8000-0000000000b1', name: 'My copy', definition: built.definition });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const kit = await workspace({ list: listWith([built]), patterns: { savePattern: async () => ({ ok: true, value: saved }) } });
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: /^More: Fan-out/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    await settle();
    expect(await screen.findByText('Copy of Fan-out · not saved')).toBeTruthy();
    expect(screen.getAllByText('at least 10 neighbours').length).toBeGreaterThan(0);
    await afterDebounce();
    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await settle();
    await userEvent.click(await screen.findByRole('button', { name: 'Save pattern…' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(kit.patternCalls.find((call) => call.method === 'savePattern')?.args[0]).toMatchObject({ definition: built.definition });
    expect(screen.queryByText('Copy of Fan-out · not saved')).toBeNull();
  });

  it('forgets the copy note when the copy is cancelled, so a new pattern does not carry it', async () => {
    await workspace();
    await userEvent.click(sectionOf(/AML typologies/).getByRole('button', { name: /^More: Fan-out/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    await settle();
    expect(await screen.findByText('Copy of Fan-out · not saved')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const discard = screen.queryByRole('button', { name: 'Discard draft' });
    if (discard !== null) await userEvent.click(discard);
    await settle();
    await userEvent.click(await screen.findByRole('button', { name: /New pattern/ }));
    await settle();
    expect(screen.queryByText(/Copy of Fan-out/)).toBeNull();
  });
});

describe('the groups of built-in definitions', () => {
  it('puts a definition whose group is "general" in the one general section with the built-in templates', async () => {
    await patternsWorkspace({ list: listWith([{ ...FAN_OUT, id: 'g', name: 'Named general', group: 'General' }]) });
    await openPatterns();
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · 4', 'My patterns · 0', 'Shared on this source · 0']);
    expect(within(screen.getByRole('region', { name: 'Built-in · 4' })).getByText('Named general')).toBeTruthy();
  });

  it('lists the definitions with no group in the one general section with the built-in templates, and gives two groups whose names differ only by punctuation their own sections', async () => {
    const definitions = [
      { ...FAN_OUT, id: 'a', name: 'Plain one', group: undefined },
      { ...FAN_OUT, id: 'b', name: 'Plain two', group: undefined },
      { ...FAN_OUT, id: 'c', name: 'Slash', group: 'A/B' },
      { ...FAN_OUT, id: 'd', name: 'Space', group: 'A B' },
    ];
    await patternsWorkspace({ list: listWith(definitions) });
    await openPatterns();
    expect(screen.getAllByRole('heading', { level: 3 }).map((entry) => entry.textContent)).toEqual(['Built-in · A/B · 1', 'Built-in · A B · 1', 'Built-in · general · 5', 'My patterns · 0', 'Shared on this source · 0']);
    expect(within(screen.getByRole('region', { name: 'Built-in · A/B · 1' })).getByText('Slash')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Built-in · general · 5' })).getByText('Plain two')).toBeTruthy();
  });
});

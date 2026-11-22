import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GraphNode, GraphProperty, SourceProfile } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { edgeRef, key, node as baseNode, ref } from '../state/test-data.js';
import { filtersWorkspace, openFilters } from './filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const prop = (key: string, value: unknown, dataClass: GraphProperty['dataClass'] = 'text', masked = false): GraphProperty => ({ key, value, dataClass, masked, ...(masked ? { maskedBy: 'request' as const } : {}) });
const held = (id: string, type: string, ...properties: GraphProperty[]): GraphNode => ({ ...baseNode('a', id), ref: ref('a', type, id), display: { title: id, type }, properties });

/** The profile with `score` filterable on kind-a (and a kind declared when given) and `secret_a` as personal data. */
const withScore = (declared?: SourceProfile['entityTypes'][number]['filterKinds']) => (profile: SourceProfile): SourceProfile => ({
  ...profile,
  entityTypes: profile.entityTypes.map((type) => (type.type === 'kind-a' ? { ...type, filterable: ['score', 'secret_a'], pii: ['secret_a'], filterKinds: { score: 'unknown' as const, secret_a: 'unknown' as const, ...declared } } : type)),
});

const three = [held('n1', 'kind-a', prop('score', 'alpha')), held('n2', 'kind-a', prop('score', 'beta')), held('n3', 'kind-a', prop('score', 'gamma')), held('n4', 'kind-b', prop('score', 'alpha'))];
const resultLine = (): string => document.querySelector('.filters-panel [role="status"] p:first-child')?.textContent ?? '';
const scopeText = (): string => within(screen.getByRole('group', { name: 'Graph scope' })).getAllByText(/./).map((line) => line.textContent ?? '').join(' | ');
const list = (): HTMLElement => screen.getByRole('group', { name: /score · property filter/ });
const boxes = (): HTMLElement[] => within(list()).getAllByRole('checkbox');
const box = (name: string): HTMLElement => within(list()).getByRole('checkbox', { name });
const opener = (): HTMLElement => screen.getByRole('button', { name: /KIND-A score · property filter/i });

describe('the choice of values of a property', () => {
  it('lists every distinct loaded value after the type blocks and narrows the entities of that type only', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    expect(opener().textContent).toBe('Any');
    await userEvent.click(opener());
    expect(boxes().map((item) => item.textContent)).toEqual(['alpha', 'beta', 'gamma']);
    await userEvent.click(box('alpha'));
    expect(resultLine()).toBe('2 of 4 match · exact · 2 hidden');
    expect(scopeText()).toContain('2 hidden by filters');
    expect(opener().textContent).toBe('alpha');
    expect(state.loadedGraph().entities.value).toBe(4);
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(1);
    expect(screen.getByText('Property filters apply to loaded items only.')).toBeTruthy();
  });

  it('narrows the list by the find box without ever making a typed text a value', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a value' }), 'ta');
    expect(boxes().map((item) => item.textContent)).toEqual(['beta']);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Find a value' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a value' }), 'nothing');
    expect(within(list()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
  });

  it('keeps a chosen value that is no longer loaded, listed as chosen', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(opener());
    await userEvent.click(box('alpha'));
    act(() => state.hide([elementKey(ref('a', 'kind-a', 'n1'))]));
    expect(opener().textContent).toBe('alpha');
    await userEvent.click(box('alpha'));
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
  });

  it('refuses a twenty-first value with a stated sentence and sets nothing for it', async () => {
    const many = Array.from({ length: 22 }, (_unused, at) => held(`m${at}`, 'kind-a', prop('score', `v${String(at).padStart(2, '0')}`)));
    const { state } = await filtersWorkspace(many, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(opener());
    for (const item of boxes().slice(0, 21)) await userEvent.click(item);
    expect(screen.getByText('Up to 20 values can be chosen.')).toBeTruthy();
    const [chosen] = state.presentation.view.getState().typeFilter.properties;
    expect(chosen?.op === 'in' ? chosen.values : []).toHaveLength(20);
  });

  it('says there are no values to filter on for mixed classes, none loaded, and when any loaded value is masked, and offers no control', async () => {
    const mixed = [held('n1', 'kind-a', prop('score', 'a')), held('n2', 'kind-a', prop('score', '1', 'number'))];
    await filtersWorkspace(mixed, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    expect(screen.getAllByText('No values to filter on yet')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /score · property filter/ })).toBeNull();
    cleanup();
    document.body.replaceChildren();
    await filtersWorkspace([held('n1', 'kind-a', prop('score', 'a')), held('n2', 'kind-a', prop('score', 'I•••', 'text', true))], ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    expect(screen.getAllByText('No values to filter on yet')).toHaveLength(2);
    expect(document.querySelector('.filters-panel')?.textContent).not.toContain('I•••');
    expect(screen.queryByRole('group', { name: /score · property filter/ })).toBeNull();
  });

  it('counts the entities with no value, unmasked ones only, once a condition is set', async () => {
    const nodes = [held('n1', 'kind-a', prop('score', 'a')), held('n2', 'kind-a'), held('n3', 'kind-a', prop('score', 'b'))];
    await filtersWorkspace(nodes, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    expect(screen.queryByText(/no value for score/)).toBeNull();
    await userEvent.click(opener());
    await userEvent.click(box('a'));
    expect(screen.getByText('1 has no value for score')).toBeTruthy();
  });

  it('offers no control for a personal-data property while masking is on, and none for a type with nothing loaded', async () => {
    const { state } = await filtersWorkspace([held('n1', 'kind-a', prop('score', 'a'), prop('secret_a', 'x')), held('n2', 'kind-b', prop('score', 'a'))], ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    act(() => state.setMask(true));
    openFilters();
    expect(screen.queryByText(/secret_a/)).toBeNull();
    expect(screen.queryByText(/KIND-A score/i)).toBeNull();
    await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
  });

  it('offers a boolean property as a choice and orders false before true', async () => {
    const nodes = [held('n1', 'kind-a', prop('score', true, 'boolean')), held('n2', 'kind-a', prop('score', false, 'boolean'))];
    await filtersWorkspace(nodes, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore({ score: 'boolean' }));
    openFilters();
    await userEvent.click(opener());
    expect(boxes().map((item) => item.textContent)).toEqual(['false', 'true']);
  });

  it('shows Reset while a property condition is set, clears it and keeps nothing hidden by it', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    await userEvent.click(opener());
    await userEvent.click(box('alpha'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
    expect(resultLine()).toBe('4 of 4 match · exact · 0 hidden');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('is disabled while the chip of its type is off', async () => {
    await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(screen.getByRole('button', { name: 'KIND-A' }));
    expect((opener() as HTMLButtonElement).disabled).toBe(true);
  });

  it('ends the selection and the focus on an entity the condition hides, as a type switched off does', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    const key = elementKey(ref('a', 'kind-a', 'n2'));
    act(() => state.presentation.select([key]));
    openFilters();
    await userEvent.click(opener());
    await userEvent.click(box('alpha'));
    expect(state.presentation.view.getState().selection.has(key)).toBe(false);
  });

  it('makes no request while a condition is set, changed or reset', async () => {
    const calls: string[] = [];
    await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore(), (name) => calls.push(name));
    openFilters();
    const settled = calls.length;
    await userEvent.click(opener());
    await userEvent.click(box('alpha'));
    await userEvent.click(box('beta'));
    await userEvent.click(box('beta'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(calls).toHaveLength(settled);
  });

});

describe('the panel layout and keyboard path', () => {
  it('puts the property blocks after the time window and the relationship types, and the result line and the footnote last', async () => {
    await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    const panel = document.querySelector('.filters-panel') as HTMLElement;
    const text = panel.textContent ?? '';
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('Time window')).toBeLessThan(at('Relationship types'));
    expect(at('Relationship types')).toBeLessThan(at('KIND-A score · property filter'));
    expect(at('KIND-A score · property filter')).toBeLessThan(at('4 of 4 match'));
    expect(at('4 of 4 match')).toBeLessThan(at('Property filters apply to loaded items only.'));
  });

  it('shows the footnote only while a property block is listed', async () => {
    await filtersWorkspace(three);
    openFilters();
    expect(screen.queryByText('Property filters apply to loaded items only.')).toBeNull();
  });

  it('reaches the control by keyboard, opens the list and closes it with Escape before the panel, and announces the result as a status', async () => {
    await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    const button = opener();
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Find a value' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(boxes()[0]);
    await userEvent.keyboard(' ');
    expect(boxes()[0]?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.filters-panel [role="status"]')?.textContent).toContain('match · exact');
    await userEvent.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.filters-panel')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.filters-panel')).toBeNull();
  });
});

describe('items an expansion brings in', () => {
  it('are judged at once by a condition on their type, and counted in the result line', async () => {
    const { state } = await filtersWorkspace(three, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(opener());
    await userEvent.click(box('alpha'));
    expect(resultLine()).toBe('2 of 4 match · exact · 2 hidden');
    const more = [held('x1', 'kind-a', prop('score', 'alpha')), held('x2', 'kind-a', prop('score', 'delta'))];
    const second = { ...key('a', 'expansion'), mask: false };
    act(() => {
      state.putResult(second, { sourceId: 'a', nodes: more, edges: [] });
      state.setLoaded([{ ...key('a'), mask: false }, second], [...three, ...more].map((candidate) => candidate.ref), []);
    });
    expect(resultLine()).toBe('3 of 6 match · exact · 3 hidden');
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId).sort()).toEqual(['n1', 'n4', 'x1']);
  });
});

/** score is an amount-like number kind here, so the property is ranged rather than chosen. */
const ranged = (kind: 'number' | 'date' | 'dateTime') => withScore({ score: kind });
const numbers = [held('n1', 'kind-a', prop('score', '500', 'number')), held('n2', 'kind-a', prop('score', '2450.5', 'number')), held('n3', 'kind-a', prop('score', '9007199254740993', 'number')), held('n4', 'kind-a')];
const fromField = (): HTMLElement => screen.getByLabelText('From');
const toField = (): HTMLElement => screen.getByLabelText('To');

describe('the range of a number property', () => {
  it('opens two fields with the lowest and highest loaded values, sets the range as typed and narrows the entities', async () => {
    const { state } = await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    expect(opener().textContent).toBe('Any');
    await userEvent.click(opener());
    expect(screen.getByText('Lowest loaded: 500')).toBeTruthy();
    expect(screen.getByText('Highest loaded: 9,007,199,254,740,993')).toBeTruthy();
    await userEvent.type(fromField(), '1000');
    await userEvent.type(toField(), '5000');
    expect(opener().textContent).toBe('1,000–5,000');
    expect(resultLine()).toBe('1 of 4 match · exact · 3 hidden');
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId)).toEqual(['n2']);
  });

  it('writes one open end as at least or at most and clears the condition when both fields are empty', async () => {
    const { state } = await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(fromField(), '1000');
    expect(opener().textContent).toBe('≥ 1,000');
    await userEvent.clear(fromField());
    await userEvent.type(toField(), '5000');
    expect(opener().textContent).toBe('≤ 5,000');
    await userEvent.clear(toField());
    expect(opener().textContent).toBe('Any');
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
  });

  it('writes a bound beyond 2^53 or with a fraction with its thousands separators and no rounding', async () => {
    await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(fromField(), '9007199254740993');
    await userEvent.type(toField(), '9007199254740993.5');
    expect(opener().textContent).toBe('9,007,199,254,740,993–9,007,199,254,740,993.5');
    expect(resultLine()).toBe('1 of 4 match · exact · 3 hidden');
  });

  it('refuses text that is not a number, and a from later than to, beside the field, and sets nothing', async () => {
    const { state } = await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.click(fromField());
    await userEvent.paste('1,000');
    expect(screen.getByText('Write it like 1000 or 999.5')).toBeTruthy();
    expect((fromField() as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
    await userEvent.clear(fromField());
    await userEvent.type(fromField(), '50');
    await userEvent.type(toField(), '10');
    expect(screen.getByText('From is later than to')).toBeTruthy();
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(1);
  });
});

describe('the range of a date and a dateTime property', () => {
  const dated = [held('d1', 'kind-a', prop('score', '2026-03-01', 'date')), held('d2', 'kind-a', prop('score', '2026-03-15', 'date')), held('d3', 'kind-a', prop('score', '2026-04-02', 'date'))];

  it('is typed as ISO text, shows the dates as they are, and keeps the days inside, bounds included', async () => {
    await filtersWorkspace(dated, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('date'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(fromField(), '2026-03-01');
    await userEvent.type(toField(), '2026-03-15');
    expect(opener().textContent).toBe('2026-03-01–2026-03-15');
    expect(resultLine()).toBe('2 of 3 match · exact · 1 hidden');
    await userEvent.clear(toField());
    await userEvent.type(toField(), 'March');
    expect(screen.getByText('Write it like 2026-03-01')).toBeTruthy();
  });

  it('refuses a dateTime written as a date', async () => {
    await filtersWorkspace([held('d1', 'kind-a', prop('score', '2026-03-01T10:00:00Z', 'dateTime'))], ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('dateTime'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(fromField(), '2026-03-01');
    expect(screen.getByText('Write it like 2026-03-01T10:00:00Z')).toBeTruthy();
  });
});

describe('the property block of a relationship type', () => {
  const weighted = (kind?: 'text' | 'number') => (profile: SourceProfile): SourceProfile => ({
    ...profile,
    relationshipTypes: profile.relationshipTypes.map((row) => (row.type === 'link-a' ? { ...row, filterable: ['weight'], filterKinds: { weight: kind ?? ('unknown' as const) } } : row)),
  });
  const kinds = [held('k1', 'kind-a', prop('score', 'x')), held('k2', 'kind-b', prop('score', 'y')), held('k3', 'kind-b', prop('score', 'z'))];
  const link = (id: string, from: string, to: string, value: string | undefined) => ({
    ref: edgeRef('a', id, 'link-a', 'kind-a', 'kind-b'),
    from: ref('a', 'kind-a', from),
    to: ref('a', 'kind-b', to),
    type: 'link-a',
    direction: 'from-to' as const,
    semantics: 'stored' as const,
    properties: value === undefined ? [] : [prop('weight', value)],
    evidenceRefs: [],
    qualityFlags: [],
  });
  const edges = [link('r1', 'k1', 'k2', 'heavy'), link('r2', 'k1', 'k3', 'light')];
  const relOpener = (): HTMLElement => screen.getByRole('button', { name: /link-a weight · property filter/ });

  it('lists the loaded values of the relationships of the type, hides those that do not match, and shows the relationship line and Reset', async () => {
    const { state } = await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], edges, false, weighted());
    openFilters();
    await userEvent.click(relOpener());
    const values = within(screen.getByRole('group', { name: /link-a weight · property filter/ }));
    expect(values.getAllByRole('checkbox').map((item) => item.textContent)).toEqual(['heavy', 'light']);
    await userEvent.click(values.getByRole('checkbox', { name: 'heavy' }));
    expect(state.visibleGraph().edges).toHaveLength(1);
    expect(document.querySelector('.filters-panel')?.textContent).toContain('1 of 2 relationships match');
    expect(resultLine()).toBe('2 of 3 match · exact · 1 hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(state.visibleGraph().edges).toHaveLength(2);
  });

  it('counts the relationships that carry no value for it, never the masked ones', async () => {
    await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], [...edges, link('r3', 'k1', 'k2', undefined)], false, weighted());
    openFilters();
    await userEvent.click(relOpener());
    await userEvent.click(within(screen.getByRole('group', { name: /link-a weight · property filter/ })).getByRole('checkbox', { name: 'heavy' }));
    expect(screen.getByText('1 has no value for weight')).toBeTruthy();
  });

  it('offers no block for a type whose only loaded relationships are aggregates, and says how many carry no properties to judge', async () => {
    const aggregate = { ...link('g1', 'k1', 'k2', undefined), ref: { sourceId: 'a', aggregate: { type: 'link-a', from: ref('a', 'kind-a', 'k1'), to: ref('a', 'kind-b', 'k2') } }, memberCount: { value: 3, quality: 'exact' as const, scope: 'aggregate:members' } };
    await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], [aggregate], false, weighted());
    openFilters();
    expect(screen.queryByRole('button', { name: /link-a weight/ })).toBeNull();
    cleanup();
    document.body.replaceChildren();
    await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], [...edges, aggregate], false, weighted());
    openFilters();
    await userEvent.click(relOpener());
    await userEvent.click(within(screen.getByRole('group', { name: /link-a weight · property filter/ })).getByRole('checkbox', { name: 'heavy' }));
    expect(screen.getByText('1 relationship carries no properties to judge and stays shown')).toBeTruthy();
  });

  it('is disabled while its relationship type is switched off, and offers no block when the stored rows declare different kinds', async () => {
    await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], edges, false, weighted());
    openFilters();
    await userEvent.click(screen.getByRole('checkbox', { name: 'link-a' }));
    expect((relOpener() as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    document.body.replaceChildren();
    const conflicting = (profile: SourceProfile): SourceProfile => {
      const rows = weighted('number')(profile).relationshipTypes;
      const stored = rows.filter((row) => row.type === 'link-a').map((row) => ({ ...row, from: 'kind-b', to: 'kind-c', filterKinds: { weight: 'text' as const } }));
      return { ...profile, relationshipTypes: [...rows, ...stored] };
    };
    await filtersWorkspace(kinds, ['kind-a', 'kind-b', 'kind-c'], edges, false, conflicting);
    openFilters();
    expect(screen.queryByRole('button', { name: /link-a weight/ })).toBeNull();
  });
});

describe('a filter on a personal-data property', () => {
  const personalScore = (profile: SourceProfile): SourceProfile => ({
    ...profile,
    entityTypes: profile.entityTypes.map((type) => (type.type === 'kind-a' ? { ...type, filterable: ['secret_a'], pii: ['secret_a'], filterKinds: { secret_a: 'unknown' as const } } : type)),
  });
  const people = [held('p1', 'kind-a', prop('secret_a', 'one')), held('p2', 'kind-a', prop('secret_a', 'two'))];
  const personalOpener = (): HTMLElement => screen.getByRole('button', { name: /KIND-A secret_a · personal data, not saved/ });

  it('is offered while masking is off, labelled as not saved, and narrows the entities for the session', async () => {
    const { state } = await filtersWorkspace(people, ['kind-a', 'kind-b', 'kind-c'], [], false, personalScore);
    openFilters();
    await userEvent.click(personalOpener());
    await userEvent.click(within(screen.getByRole('group', { name: /secret_a · personal data, not saved/ })).getByRole('checkbox', { name: 'one' }));
    expect(resultLine()).toBe('1 of 2 match · exact · 1 hidden');
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(1);
  });

  it('is not offered while masking is on, and a hand-made request to set one is refused', async () => {
    const { state } = await filtersWorkspace(people, ['kind-a', 'kind-b', 'kind-c'], [], false, personalScore);
    act(() => state.setMask(true));
    openFilters();
    expect(screen.queryByText(/secret_a/)).toBeNull();
    const identity = { on: 'entity', type: 'kind-a', property: 'secret_a' } as const;
    expect(() => state.setPropertyCondition(identity, { ...identity, kind: 'text', op: 'in', values: ['one'] })).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
  });

  it('is not offered when a loaded value is masked by the policy', async () => {
    const withMasked = [held('p1', 'kind-a', prop('secret_a', 'one')), held('p2', 'kind-a', prop('secret_a', 'T•••', 'text', true))];
    await filtersWorkspace(withMasked, ['kind-a', 'kind-b', 'kind-c'], [], false, personalScore);
    openFilters();
    expect(screen.queryByRole('checkbox', { name: 'one' })).toBeNull();
    expect(screen.getByText('No values to filter on yet')).toBeTruthy();
  });

  it('is cleared with the stated reason the moment masking turns on, whatever turned it on, the panel open or closed, and the items it hid come back', async () => {
    const { state } = await filtersWorkspace(people, ['kind-a', 'kind-b', 'kind-c'], [], false, personalScore);
    openFilters();
    await userEvent.click(personalOpener());
    await userEvent.click(within(screen.getByRole('group', { name: /secret_a · personal data, not saved/ })).getByRole('checkbox', { name: 'one' }));
    expect(state.visibleGraph().nodes).toHaveLength(1);
    act(() => state.setMask(true));
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
    expect(document.body.textContent).toContain('Filter on secret_a cleared: masking is on.');
    act(() => state.setMask(false));
    expect(state.presentation.view.getState().typeFilter.properties).toHaveLength(0);
  });

  it('is cleared with the panel closed, and the sentence is announced and kept until the next change of a filter', async () => {
    const { state } = await filtersWorkspace(people, ['kind-a', 'kind-b', 'kind-c'], [], false, personalScore);
    const identity = { on: 'entity', type: 'kind-a', property: 'secret_a' } as const;
    act(() => state.setPropertyCondition(identity, { ...identity, kind: 'text', op: 'in', values: ['one'] }));
    act(() => state.setMask(true));
    expect(state.presentation.view.getState().personalFilterNote).toBe('Filter on secret_a cleared: masking is on.');
    expect(state.presentation.view.getState().moveNote?.text).toBe('Filter on secret_a cleared: masking is on.');
    openFilters();
    expect(within(document.querySelector('.filters-panel') as HTMLElement).getByText('Filter on secret_a cleared: masking is on.')).toBeTruthy();
    act(() => state.setEntityTypeOff('kind-b', true));
    expect(state.presentation.view.getState().personalFilterNote).toBeUndefined();
  });

  it('keeps a filter on a property that is not personal data when masking turns on', async () => {
    const mixed = (profile: SourceProfile): SourceProfile => ({ ...profile, entityTypes: profile.entityTypes.map((type) => (type.type === 'kind-a' ? { ...type, filterable: ['score', 'secret_a'], pii: ['secret_a'], filterKinds: { score: 'unknown' as const, secret_a: 'unknown' as const } } : type)) });
    const nodes = [held('p1', 'kind-a', prop('score', 'x'), prop('secret_a', 'one')), held('p2', 'kind-a', prop('score', 'y'), prop('secret_a', 'two'))];
    const { state } = await filtersWorkspace(nodes, ['kind-a', 'kind-b', 'kind-c'], [], false, mixed);
    const plain = { on: 'entity', type: 'kind-a', property: 'score' } as const;
    const secret = { on: 'entity', type: 'kind-a', property: 'secret_a' } as const;
    act(() => {
      state.setPropertyCondition(plain, { ...plain, kind: 'text', op: 'in', values: ['x'] });
      state.setPropertyCondition(secret, { ...secret, kind: 'text', op: 'in', values: ['one'] });
    });
    act(() => state.setMask(true));
    expect(state.presentation.view.getState().typeFilter.properties.map((condition) => condition.property)).toEqual(['score']);
  });
});

describe('what the lookout found in the controls', () => {
  const numbers = [held('n1', 'kind-a', prop('score', '500', 'number')), held('n2', 'kind-a', prop('score', '2450', 'number'))];

  it('offers only values of the declared class, and says there are none when the loaded values are of another class', async () => {
    await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore({ score: 'text' }));
    openFilters();
    expect(screen.getAllByText('No values to filter on yet').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /KIND-A score · property filter/ })).toBeNull();
  });

  it('does not list a text the stored document would refuse, and says how many are left out', async () => {
    const nodes = [held('n1', 'kind-a', prop('score', 'fine')), held('n2', 'kind-a', prop('score', 'x'.repeat(300))), held('n3', 'kind-a', prop('score', 'bad\u0000value'))];
    await filtersWorkspace(nodes, ['kind-a', 'kind-b', 'kind-c'], [], false, withScore());
    openFilters();
    await userEvent.click(opener());
    expect(boxes().map((item) => item.textContent)).toEqual(['fine']);
    expect(screen.getByText('2 values cannot be chosen: they are empty, too long or not storable')).toBeTruthy();
  });

  it('offers no range, with the same sentence as a choice, when any loaded value is masked', async () => {
    await filtersWorkspace([...numbers, held('n3', 'kind-a', prop('score', '9', 'number', true))], ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    expect(screen.getAllByText('No values to filter on yet').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /KIND-A score · property filter/ })).toBeNull();
  });

  it('puts the bounds of the condition into the fields again after Reset, and never the old ones', async () => {
    await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(screen.getByRole('textbox', { name: /^From$/ }), '10');
    await userEvent.type(screen.getByRole('textbox', { name: /^To$/ }), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByRole('textbox', { name: /^From$/ }) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: /^To$/ }) as HTMLInputElement).value).toBe('');
    await userEvent.type(screen.getByRole('textbox', { name: /^To$/ }), '5');
    expect(opener().textContent).toBe('≤ 5');
  });

  it('keeps what is typed while the condition is set from it, a leading zero included', async () => {
    await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(screen.getByRole('textbox', { name: /^From$/ }), '007');
    expect((screen.getByRole('textbox', { name: /^From$/ }) as HTMLInputElement).value).toBe('007');
  });

  it('asks for a text keyboard on a date range and a numeric one on a number range, and announces a problem politely', async () => {
    await filtersWorkspace([held('d1', 'kind-a', prop('score', '2026-03-01', 'date'))], ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('date'));
    openFilters();
    await userEvent.click(opener());
    expect(screen.getByRole('textbox', { name: /^From$/ }).getAttribute('inputmode')).toBe('text');
    await userEvent.click(screen.getByRole('textbox', { name: /^From$/ }));
    await userEvent.paste('March');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Write it like 2026-03-01').getAttribute('role')).toBe('status');
    cleanup();
    document.body.replaceChildren();
    await filtersWorkspace(numbers, ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    expect(screen.getByRole('textbox', { name: /^From$/ }).getAttribute('inputmode')).toBe('decimal');
  });

  it('counts the entities with no value under an active range, and not the masked ones', async () => {
    await filtersWorkspace([...numbers, held('n3', 'kind-a')], ['kind-a', 'kind-b', 'kind-c'], [], false, ranged('number'));
    openFilters();
    await userEvent.click(opener());
    await userEvent.type(screen.getByRole('textbox', { name: /^From$/ }), '1');
    expect(screen.getByText('1 has no value for score')).toBeTruthy();
  });
});

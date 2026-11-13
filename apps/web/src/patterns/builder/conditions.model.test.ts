import { describe, expect, it } from 'vitest';
import { MAX_FILTER_TEXT, PATTERN_LIMITS, patternProblemsOf } from '@neburyx/contracts';
import { conditionsProfile } from './builder-kit.js';
import { addConditionBlock, conditionSummary, hiddenPersonalCount, offeredProperties, operatorsFor, propertyKind, readRows, readWindow, windowReach, windowTypeLines, type ConditionRow } from './conditions.js';
import { INITIAL, reduce, toDefinition, type Action, type BuilderState, type StepDraft } from './model.js';
import { readValue } from '../../workspace/expand-refine.js';

const profile = conditionsProfile();
const run = (state: BuilderState, ...actions: Action[]): BuilderState => actions.reduce((held, action) => reduce(profile, held, action), state);

const oneStep = (...types: string[]): BuilderState =>
  run(INITIAL, { type: 'start', anchorType: 'c-a' }, { type: 'add' }, { type: 'direction', index: 0, direction: 'out' }, { type: 'arrives', index: 0, arrivesAt: 'c-b' }, ...types.map((relationshipType): Action => ({ type: 'toggle', index: 0, relationshipType })));

describe('what a step offers a condition', () => {
  it('reads the relationship side from the rows that carry the step in its direction', () => {
    const step = (direction: 'out' | 'in' | 'both'): StepDraft => ({ direction, arrivesAt: 'c-d', relationshipTypes: ['k-two'] });
    expect(offeredProperties(profile, 'c-c', step('out'), false).relationship).toEqual(['fwd', 'q-when']);
    expect(offeredProperties(profile, 'c-c', { direction: 'in', arrivesAt: 'c-d', relationshipTypes: ['k-two'] }, false).relationship).toEqual(['back']);
    expect(offeredProperties(profile, 'c-c', step('both'), false).relationship).toEqual([]);
  });

  it('reads which types a window filters from those rows, a type with both kinds of row in both lists', () => {
    expect(windowReach(profile, 'c-c', { direction: 'both', arrivesAt: 'c-d', relationshipTypes: ['k-two'] })).toEqual({ appliesTo: ['k-two'], notAppliedTo: ['k-two'] });
    expect(windowReach(profile, 'c-a', { direction: 'out', arrivesAt: 'c-b', relationshipTypes: ['k-1', 'k-2'] })).toEqual({ appliesTo: ['k-1'], notAppliedTo: ['k-2'] });
  });
});

describe('keeping conditions through a change', () => {
  const withRow = (state: BuilderState): BuilderState => run(state, { type: 'add-condition', index: 0, mask: false }, { type: 'change-condition', index: 0, id: 1, change: { text: 'x' } });

  it('keeps the rows and the window of the step that changed', () => {
    const state = run(withRow(oneStep('k-6')), { type: 'window', index: 0, window: { kind: 'days', text: '7' } });
    const changed = run(state, { type: 'direction', index: 0, direction: 'both' }, { type: 'arrives', index: 0, arrivesAt: 'c-b' });
    expect(changed.draft.steps[0]?.conditions).toHaveLength(1);
    const cleared = run(withRow(oneStep('k-1')), { type: 'direction', index: 0, direction: 'in' });
    expect(cleared.draft.steps[0]?.conditions).toHaveLength(1);
    expect(cleared.draft.steps[0]?.relationshipTypes).toEqual([]);
  });

  it('holds the definition back while a row’s property is not offered and while a value is unread, and sends it when whole', () => {
    const ok = withRow(oneStep('k-6'));
    expect(toDefinition(ok.draft, profile, false)).toMatchObject({ steps: [{ conditions: [{ property: 'b-name' }] }] });
    expect(toDefinition(ok.draft, profile, true)?.steps[0]?.conditions).toHaveLength(1);
    const secret = run(ok, { type: 'change-condition', index: 0, id: 1, change: { property: 'b-secret' } });
    expect(toDefinition(secret.draft, profile, false)).toBeDefined();
    expect(toDefinition(secret.draft, profile, true)).toBeUndefined();
    const unread = run(ok, { type: 'change-condition', index: 0, id: 1, change: { text: '' } });
    expect(toDefinition(unread.draft, profile, false)).toBeUndefined();
    const stale = run(withRow(oneStep('k-1')), { type: 'change-condition', index: 0, id: 1, change: { on: 'relationship', property: 'q-size' } }, { type: 'toggle', index: 0, relationshipType: 'k-1' }, { type: 'toggle', index: 0, relationshipType: 'k-5' });
    expect(toDefinition(stale.draft, profile, false)).toBeUndefined();
  });

  it('drops a window that no chosen type can use, once, and keeps one that a dated type can use', () => {
    const windowed = run(oneStep('k-1'), { type: 'window', index: 0, window: { kind: 'days', text: '7' } });
    const kept = run(windowed, { type: 'toggle', index: 0, relationshipType: 'k-2' });
    expect(kept.draft.steps[0]?.window).toEqual({ kind: 'days', text: '7' });
    expect(kept.windowDropped).toBeUndefined();
    const dropped = run(windowed, { type: 'toggle', index: 0, relationshipType: 'k-1' }, { type: 'toggle', index: 0, relationshipType: 'k-2' });
    expect(dropped.draft.steps[0]?.window).toEqual({ kind: 'none' });
    expect(dropped.windowDropped).toBe(true);
    expect(run(dropped, { type: 'add' }).windowDropped).toBeUndefined();
  });

  it('sends every row, the seventh included, and holds the definition back for an unread seventh', () => {
    let state = oneStep('k-1');
    for (let count = 0; count < PATTERN_LIMITS.conditionsPerElement; count += 1) state = run(state, { type: 'add-condition', index: 0, mask: false }, { type: 'change-condition', index: 0, id: count + 1, change: { text: 'x' } });
    state = run(state, { type: 'add-condition', index: 0, mask: false });
    expect(state.draft.steps[0]?.conditions?.[6]?.on).toBe('relationship');
    expect(toDefinition(state.draft, profile, false)).toBeUndefined();
    state = run(state, { type: 'change-condition', index: 0, id: 7, change: { text: '5' } });
    expect(toDefinition(state.draft, profile, false)?.steps[0]?.conditions).toHaveLength(7);
  });

  it('adds nothing at the caps', () => {
    let state = oneStep('k-6');
    for (let count = 0; count < PATTERN_LIMITS.conditionsPerElement + 2; count += 1) state = run(state, { type: 'add-condition', index: 0, mask: false });
    expect(state.draft.steps[0]?.conditions).toHaveLength(PATTERN_LIMITS.conditionsPerElement);
  });
});

describe('the pattern cap', () => {
  it('blocks Add condition at the cap of conditions in a pattern, whatever the step', () => {
    const row = (id: number): ConditionRow => ({ id, on: 'neighbor', property: 'b-name', op: 'eq', text: 'x', from: '', to: '', kind: 'auto' });
    const rows = (from: number, count: number): ConditionRow[] => Array.from({ length: count }, (_, i) => row(from + i));
    const full: StepDraft[] = [
      { direction: 'out', arrivesAt: 'c-b', relationshipTypes: ['k-1'], conditions: [...rows(1, 6), ...rows(7, 6).map((r) => ({ ...r, on: 'relationship' as const, property: 'q-size' }))] },
      { direction: 'out', arrivesAt: 'c-b', relationshipTypes: ['k-1'], conditions: [...rows(13, 6), ...rows(19, 6).map((r) => ({ ...r, on: 'relationship' as const, property: 'q-size' }))] },
    ];
    expect(PATTERN_LIMITS.conditionsPerPattern).toBe(24);
    const offered = offeredProperties(profile, 'c-a', full[0] as StepDraft, false);
    expect(addConditionBlock(offered, { ...(full[0] as StepDraft), conditions: [] }, full)).toEqual({ kind: 'pattern-cap' });
  });
});

describe('reading as the contract does', () => {
  const definitionWith = (filter: unknown) => ({ anchorType: 'x', steps: [{ relationshipTypes: ['r'], direction: 'out', arrivesAt: 'y', conditions: [filter] }] });
  const row = (change: Partial<ConditionRow>): ConditionRow => ({ id: 1, on: 'neighbor', property: 'p', op: 'eq', text: '', from: '', to: '', kind: 'auto', ...change });

  it('never passes a condition the contract refuses, and never refuses one it accepts', () => {
    const cases: Partial<ConditionRow>[] = [
      { text: 'a' },
      { text: '12' },
      { text: 'true' },
      { text: '2026-03-01' },
      { op: 'in', text: 'a, b, c' },
      { op: 'in', text: '1, 2' },
      { op: 'between', from: '1', to: '2' },
      { op: 'between', from: '2026-03-01' },
      { op: 'between', to: '10:30:00', kind: 'time' },
      { text: 'x'.repeat(MAX_FILTER_TEXT) },
      { text: 'x'.repeat(MAX_FILTER_TEXT + 1) },
      { op: 'in', text: Array.from({ length: 21 }, (_, i) => `v${i}`).join(',') },
      { op: 'in', text: '1, a' },
      { op: 'between', from: 'true', kind: 'boolean' },
      { op: 'between', from: '1', to: 'a' },
      { text: '' },
    ];
    for (const change of cases) {
      const read = readRows([row(change)]);
      const accepted = read.problems.size === 0 && read.filters.length === 1;
      if (accepted) expect(patternProblemsOf(definitionWith(read.filters[0])), JSON.stringify(change)).toEqual([]);
    }
    expect(readValue('x'.repeat(MAX_FILTER_TEXT + 1), 'text').ok).toBe(false);
    expect(patternProblemsOf(definitionWith({ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'text', value: 'x'.repeat(MAX_FILTER_TEXT + 1) } })).length).toBeGreaterThan(0);
  });

  it('reads a window as the contract does', () => {
    const withWindow = (window: unknown) => ({ anchorType: 'x', steps: [{ relationshipTypes: ['r'], direction: 'out', arrivesAt: 'y', window }] });
    for (const [draft, window] of [
      [{ kind: 'days', text: '30' }, { days: 30 }],
      [{ kind: 'dates', from: '2026-03-01', to: '2026-03-31' }, { from: '2026-03-01', to: '2026-03-31' }],
    ] as const) {
      const read = readWindow(draft);
      expect(read).toEqual({ ok: true, window });
      expect(patternProblemsOf(withWindow(window))).toEqual([]);
    }
    for (const draft of [{ kind: 'days', text: '3651' }, { kind: 'dates', from: '2026-04-01', to: '2026-03-01' }, { kind: 'dates', from: '2010-01-01', to: '2026-01-01' }] as const) expect(readWindow(draft).ok).toBe(false);
  });
});

describe('the kinds of properties, the lines of a condition and the reading of a window', () => {
  const kinds = {
    ...profile,
    entityTypes: profile.entityTypes.map((entity) => (entity.type === 'c-b' ? { ...entity, filterKinds: { 'b-name': 'text', 'b-count': 'number' } } : entity)),
    relationshipTypes: profile.relationshipTypes.map((row) => (row.type === 'k-1' ? { ...row, filterKinds: { 'q-size': 'number' } } : row.type === 'k-2' ? { ...row, filterKinds: { 'q-size': 'text' } } : row)),
  } as typeof profile;
  const step = (types: string[]) => ({ direction: 'out' as const, arrivesAt: 'c-b', relationshipTypes: types });

  it('reads the kind of a property from the arriving type, and of a relationship property from the rows, unknown where they differ and nothing without kinds', () => {
    expect(propertyKind(kinds, 'c-a', step(['k-1']), 'neighbor', 'b-count')).toBe('number');
    expect(propertyKind(kinds, 'c-a', step(['k-1']), 'relationship', 'q-size')).toBe('number');
    expect(propertyKind(kinds, 'c-a', step(['k-1', 'k-2']), 'relationship', 'q-size')).toBe('unknown');
    expect(propertyKind(profile, 'c-a', step(['k-1']), 'neighbor', 'b-count')).toBeUndefined();
    expect(propertyKind(kinds, 'c-a', step(['k-1']), 'neighbor', 'b-secret')).toBeUndefined();
  });

  it('gives true or false no range, and counts the personal-data properties that masking hides', () => {
    expect(operatorsFor('boolean')).toEqual(['eq', 'in']);
    expect(operatorsFor('number')).toEqual(['eq', 'in', 'between']);
    expect(hiddenPersonalCount(profile, step(['k-1']), true)).toBe(1);
    expect(hiddenPersonalCount(profile, step(['k-1']), false)).toBe(0);
  });

  it('writes a condition as a line', () => {
    const row: ConditionRow = { id: 1, on: 'neighbor', property: 'p', op: 'eq', text: ' 5 ', from: '', to: '', kind: 'auto' };
    expect(conditionSummary(row)).toBe('p is 5');
    expect(conditionSummary({ ...row, op: 'in', text: 'a, b,, c' })).toBe('p is one of a, b, c');
    expect(conditionSummary({ ...row, op: 'between', from: '1', to: '9' })).toBe('p is between 1 and 9');
    expect(conditionSummary({ ...row, op: 'between', from: '1' })).toBe('p is 1 or more');
    expect(conditionSummary({ ...row, op: 'eq', text: '' })).toBe('p has no value yet');
  });

  it('says what is wrong with a window and at which field', () => {
    expect(readWindow({ kind: 'days', text: '0' })).toMatchObject({ ok: false, at: 'days' });
    expect(readWindow({ kind: 'dates', from: '2026-02-30', to: '2026-03-01' })).toMatchObject({ ok: false, at: 'from', reason: 'Enter a calendar date like 2026-03-01.' });
    expect(readWindow({ kind: 'dates', from: '2026-03-01', to: 'x' })).toMatchObject({ ok: false, at: 'to' });
    expect(readWindow({ kind: 'dates', from: '2026-03-02', to: '2026-03-01' })).toMatchObject({ ok: false, at: 'to', reason: 'Before the start date' });
    expect(readWindow({ kind: 'dates', from: '2010-01-01', to: '2026-01-01' })).toMatchObject({ ok: false, at: 'range', reason: 'At most 3,650 days apart.' });
    expect(readWindow({ kind: 'dates', from: '2026-03-01', to: '2026-03-01' })).toEqual({ ok: true, window: { from: '2026-03-01', to: '2026-03-01' } });
  });

  it('lists for each chosen type its date properties and whether a row of it has none', () => {
    expect(windowTypeLines(profile, 'c-a', step(['k-1', 'k-2']))).toEqual([
      { type: 'k-1', datedOn: ['q-when'], undated: false },
      { type: 'k-2', datedOn: [], undated: true },
    ]);
  });
});

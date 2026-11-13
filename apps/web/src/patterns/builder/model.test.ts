import { describe, expect, it } from 'vitest';
import { PATTERN_LIMITS } from '@neburyx/contracts';
import { builderProfile, conditionsProfile } from './builder-kit.js';
import { breakText, doesNotLeave, leavingText } from './copy.js';
import { addStepBlock, arrivalTypes, breaksOf, type Break, EMPTY_DRAFT, INITIAL, reduce, relationshipChoices, stepLimitOf, toDefinition, typeOptions, type Action, type BuilderState } from './model.js';

const profile = builderProfile();
const run = (state: BuilderState, ...actions: Action[]): BuilderState => actions.reduce((held, action) => reduce(profile, held, action), state);

const twoSteps = (): BuilderState =>
  run(
    INITIAL,
    { type: 'start', anchorType: 'n-a' },
    { type: 'add' },
    { type: 'direction', index: 0, direction: 'out' },
    { type: 'arrives', index: 0, arrivesAt: 'n-b' },
    { type: 'toggle', index: 0, relationshipType: 'r-1' },
    { type: 'add' },
    { type: 'direction', index: 1, direction: 'out' },
    { type: 'arrives', index: 1, arrivesAt: 'n-c' },
    { type: 'toggle', index: 1, relationshipType: 'r-3' },
  );

describe('what a step may choose', () => {
  it('reaches the types the mapping joins in the direction, each once, in the profile’s order', () => {
    expect(arrivalTypes(profile, 'n-a', 'out')).toEqual(['n-a', 'n-b']);
    expect(arrivalTypes(profile, 'n-b', 'out')).toEqual(['n-c']);
    expect(arrivalTypes(profile, 'n-b', 'in')).toEqual(['n-a']);
    expect(arrivalTypes(profile, 'n-b', 'both')).toEqual(['n-a', 'n-c']);
    expect(arrivalTypes(profile, 'n-e', 'both')).toEqual([]);
  });

  it('lists the relationship types that join two types in a direction, each once', () => {
    expect(relationshipChoices(profile, 'n-a', 'n-b', 'out')).toEqual(['r-1', 'r-2']);
    expect(relationshipChoices(profile, 'n-a', 'n-b', 'in')).toEqual([]);
    expect(relationshipChoices(profile, 'n-b', 'n-a', 'in')).toEqual(['r-1', 'r-2']);
    expect(relationshipChoices(profile, 'n-b', 'n-a', 'both')).toEqual(['r-1', 'r-2']);
    expect(relationshipChoices(profile, 'n-a', 'n-a', 'out')).toEqual(['r-self']);
  });
});

describe('keeping the chain valid', () => {
  it('builds a definition only from a complete pattern', () => {
    expect(toDefinition(EMPTY_DRAFT, profile, false)).toBeUndefined();
    expect(toDefinition(run(INITIAL, { type: 'start', anchorType: 'n-a' }, { type: 'add' }).draft, profile, false)).toBeUndefined();
    expect(toDefinition(twoSteps().draft, profile, false)).toEqual({ anchorType: 'n-a', steps: [{ relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' }, { relationshipTypes: ['r-3'], direction: 'out', arrivesAt: 'n-c' }] });
  });

  it('removes nothing when a change leaves a later part unfollowed: it keeps it, lists it, and keeps the draft as it was for Undo', () => {
    const before = twoSteps();
    const changed = run(before, { type: 'direction', index: 0, direction: 'in' });
    expect(changed.draft.steps).toHaveLength(2);
    expect(changed.draft.steps[0]).toEqual({ direction: 'in', arrivesAt: 'n-b', relationshipTypes: ['r-1'] });
    expect(breaksOf(profile, changed.draft, false).map((found) => `${found.kind}@${found.step}`)).toEqual(['arrival@0', 'types-leave@0']);
    expect(changed.undo).toEqual({ draft: before.draft, changed: 0 });
  });

  it('undoes to exactly the draft before the change, and the marks and the undo go together', () => {
    const before = twoSteps();
    const broken = run(before, { type: 'arrives', index: 0, arrivesAt: 'n-a' });
    expect(breaksOf(profile, broken.draft, false).map((found) => `${found.kind}@${found.step}`)).toEqual(['types-lead@0', 'arrival@1', 'types-leave@1']);
    const undone = run(broken, { type: 'undo' });
    expect(undone.draft).toEqual(before.draft);
    expect(undone.undo).toBeUndefined();
    const fixed = run(broken, { type: 'arrives', index: 0, arrivesAt: 'n-b' });
    expect(breaksOf(profile, fixed.draft, false)).toEqual([]);
    expect(fixed.undo).toBeUndefined();
    expect(run(before, { type: 'undo' })).toBe(before);
  });

  it('keeps the first snapshot while later changes pile on, and says where the change began', () => {
    const before = twoSteps();
    const first = run(before, { type: 'start', anchorType: 'n-c' });
    expect(first.undo?.changed).toBe('start');
    const more = run(first, { type: 'direction', index: 1, direction: 'in' });
    expect(more.undo).toEqual({ draft: before.draft, changed: 'start' });
    expect(run(more, { type: 'undo' }).draft).toEqual(before.draft);
  });

  it('keeps later steps when a middle step is removed, and marks them', () => {
    const removed = run(twoSteps(), { type: 'remove', index: 0 });
    expect(removed.draft.steps).toHaveLength(1);
    expect(breaksOf(profile, removed.draft, false).map((found) => found.kind)).toEqual(['arrival', 'types-leave']);
    expect(removed.undo?.changed).toBe(0);
  });

  it('keeps a change that breaks nothing out of the undo, and holds the definition back while anything is broken', () => {
    const kept = run(twoSteps(), { type: 'toggle', index: 0, relationshipType: 'r-2' });
    expect(kept.draft.steps).toHaveLength(2);
    expect(kept.undo).toBeUndefined();
    expect(toDefinition(run(twoSteps(), { type: 'direction', index: 0, direction: 'in' }).draft, profile, false)).toBeUndefined();
  });

  it('removes the last step only, and refuses a seventh relationship type', () => {
    expect(run(twoSteps(), { type: 'remove' }).draft.steps).toHaveLength(1);
    const full = run(INITIAL, { type: 'start', anchorType: 'n-c' }, { type: 'add' }, { type: 'direction', index: 0, direction: 'out' }, { type: 'arrives', index: 0, arrivesAt: 'n-d' }, ...Array.from({ length: PATTERN_LIMITS.relationshipTypesPerStep + 1 }, (_, index): Action => ({ type: 'toggle', index: 0, relationshipType: `r-d${index + 1}` })));
    expect(full.draft.steps[0]?.relationshipTypes).toHaveLength(PATTERN_LIMITS.relationshipTypesPerStep);
  });
});

describe('why a step cannot be added', () => {
  it('says why, in the order the person meets it', () => {
    expect(addStepBlock(profile, EMPTY_DRAFT, 4)).toEqual({ kind: 'start' });
    expect(addStepBlock(profile, run(INITIAL, { type: 'start', anchorType: 'n-e' }).draft, 4)).toEqual({ kind: 'dead-end', type: 'n-e' });
    expect(addStepBlock(profile, run(INITIAL, { type: 'start', anchorType: 'n-a' }, { type: 'add' }).draft, 4)).toEqual({ kind: 'incomplete' });
    expect(addStepBlock(profile, twoSteps().draft, 2)).toEqual({ kind: 'limit', limit: 2 });
    expect(addStepBlock(profile, twoSteps().draft, 4)).toBeUndefined();
  });

  it('takes the source’s limit, never above the contract’s', () => {
    expect(stepLimitOf(2)).toBe(2);
    expect(stepLimitOf(undefined)).toBe(PATTERN_LIMITS.steps);
    expect(stepLimitOf(99)).toBe(PATTERN_LIMITS.steps);
  });
});

describe('removing a step by its place', () => {
  it('removes the last step with no index and the step at an index', () => {
    expect(run(twoSteps(), { type: 'remove' }).draft.steps).toHaveLength(1);
    expect(run(twoSteps(), { type: 'remove', index: 1 }).draft.steps).toHaveLength(1);
    expect(run(twoSteps(), { type: 'remove', index: 0 }).draft.steps[0]?.arrivesAt).toBe('n-c');
  });

  it('does nothing for a step that is not there', () => {
    const held = twoSteps();
    expect(run(held, { type: 'remove', index: 5 })).toBe(held);
    expect(run(INITIAL, { type: 'remove' })).toBe(INITIAL);
  });
});

describe('the relationship types a step may take', () => {
  it('lists each type with the type it leads to, once however many rows, and only to the arrival once it is chosen', () => {
    expect(typeOptions(profile, 'n-a', 'out', undefined).map((option) => `${option.type}>${option.arrival}`)).toEqual(['r-1>n-b', 'r-2>n-b', 'r-self>n-a']);
    expect(typeOptions(profile, 'n-a', 'out', 'n-b').map((option) => option.type)).toEqual(['r-1', 'r-2']);
    expect(typeOptions(profile, 'n-b', 'both', undefined).map((option) => `${option.type}>${option.arrival}`)).toEqual(['r-1>n-a', 'r-2>n-a', 'r-3>n-c']);
    expect(typeOptions(profile, 'n-e', 'both', undefined)).toEqual([]);
  });

  it('says whether the mapping gives a type an observed time', () => {
    expect(typeOptions(profile, 'n-a', 'out', 'n-b').every((option) => !option.dated)).toBe(true);
    const dated = { ...profile, relationshipTypes: profile.relationshipTypes.map((row) => (row.type === 'r-1' ? { ...row, observedAt: 'when' } : row)) };
    expect(typeOptions(dated, 'n-a', 'out', 'n-b').map((option) => option.dated)).toEqual([true, false]);
  });
});

describe('what a change leaves unfollowed, said once', () => {
  it('merges conditions on the same property into one break with their number, and says it', () => {
    const base = conditionsProfile();
    const row = (id: number) => ({ id, on: 'neighbor' as const, property: 'b-name', op: 'eq' as const, text: 'x', from: '', to: '', kind: 'auto' as const });
    const draft = { anchorType: 'c-a', steps: [{ direction: 'out' as const, arrivesAt: 'c-c', relationshipTypes: ['k-1'], conditions: [row(1), row(2), row(3)] }] };
    const found = breaksOf(base, draft, false).filter((candidate) => candidate.kind === 'condition');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rows: 3 });
    expect(breakText(found[0] as Break, (type) => (type === undefined ? '' : type.toUpperCase()))).toBe('Step 1: the condition on b-name is not available on C-C (3 conditions).');
  });

  it('writes a or an before a type by its first letter', () => {
    expect(leavingText('Account', 'out')).toBe('Leaving an Account, outgoing');
    expect(leavingText('Customer', 'in')).toBe('Leaving a Customer, incoming');
    expect(doesNotLeave('SENT', 'Bank')).toBe('SENT does not leave a Bank.');
    expect(doesNotLeave('SENT', 'Address')).toBe('SENT does not leave an Address.');
  });
});

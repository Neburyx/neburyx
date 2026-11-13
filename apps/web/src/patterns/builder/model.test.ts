import { describe, expect, it } from 'vitest';
import { PATTERN_LIMITS } from '@neburyx/contracts';
import { builderProfile } from './builder-kit.js';
import { addStepBlock, arrivalTypes, EMPTY_DRAFT, INITIAL, reduce, relationshipChoices, stepLimitOf, toDefinition, type Action, type BuilderState } from './model.js';

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
    expect(toDefinition(EMPTY_DRAFT)).toBeUndefined();
    expect(toDefinition(run(INITIAL, { type: 'start', anchorType: 'n-a' }, { type: 'add' }).draft)).toBeUndefined();
    expect(toDefinition(twoSteps().draft)).toEqual({ anchorType: 'n-a', steps: [{ relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' }, { relationshipTypes: ['r-3'], direction: 'out', arrivesAt: 'n-c' }] });
  });

  it('keeps the arrival type and the types that still join when the direction changes, and clears the rest', () => {
    const keeps = run(twoSteps(), { type: 'direction', index: 0, direction: 'both' });
    expect(keeps.draft.steps[0]).toEqual({ direction: 'both', arrivesAt: 'n-b', relationshipTypes: ['r-1'] });
    expect(keeps.removed).toBe(0);
    const clears = run(twoSteps(), { type: 'direction', index: 0, direction: 'in' });
    expect(clears.draft.steps).toHaveLength(1);
    expect(clears.draft.steps[0]).toEqual({ direction: 'in', relationshipTypes: [] });
    expect(clears.removed).toBe(1);
  });

  it('removes the steps after a step whose arrival type changes so that they no longer follow, and keeps them while they still join', () => {
    const broken = run(twoSteps(), { type: 'arrives', index: 0, arrivesAt: 'n-a' });
    expect(broken.draft.steps).toHaveLength(1);
    expect(broken.removed).toBe(1);
    const kept = run(twoSteps(), { type: 'toggle', index: 0, relationshipType: 'r-2' });
    expect(kept.draft.steps).toHaveLength(2);
    expect(kept.removed).toBe(0);
  });

  it('applies the same rules from the first step when the start type changes', () => {
    const changed = run(twoSteps(), { type: 'start', anchorType: 'n-c' });
    expect(changed.draft.steps).toHaveLength(1);
    expect(changed.draft.steps[0]).toEqual({ direction: 'out', relationshipTypes: [] });
    expect(changed.removed).toBe(1);
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

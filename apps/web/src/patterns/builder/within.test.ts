import { describe, expect, it } from 'vitest';
import type { PatternDefinition } from '@neburyx/contracts';
import { extensionTags, withinTag } from '../copy.js';
import { builderProfile } from './builder-kit.js';
import { draftWords } from './draft-words.js';
import { fromDefinition } from './from-definition.js';
import { breaksOf, reduce, toDefinition, type Action, type BuilderState } from './model.js';

const base = builderProfile();
const profile = { ...base, relationshipTypes: base.relationshipTypes.map((row) => ({ ...row, observedAt: 'when' })) };
const bounded = (within: PatternDefinition['steps'][number]['within']): PatternDefinition => ({
  anchorType: 'n-a',
  steps: [
    { relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' },
    { relationshipTypes: ['r-3'], direction: 'out', arrivesAt: 'n-c', after: 'previous', ...(within === undefined ? {} : { within }) },
  ],
});
const stateOf = (definition: PatternDefinition): BuilderState => ({ draft: fromDefinition(definition).draft });
const run = (state: BuilderState, ...actions: Action[]): BuilderState => actions.reduce((held, action) => reduce(profile, held, action), state);
const nameOf = (type: string | undefined): string => type ?? '';

describe('the bound of a step ordered after the previous one, in the builder', () => {
  it.each([
    [{ hours: 24 }, 'within 24 h'],
    [{ minutes: 90 }, 'within 90 min'],
    [{ days: 3 }, 'within 3 days'],
    [{ days: 1 }, 'within 1 day'],
  ])('is the tag %j next to the order', (within, tag) => {
    expect(withinTag(within)).toBe(tag);
    expect(extensionTags({ after: 'previous', within })).toEqual(['after previous', tag]);
  });

  it('has no tag when the step has none, and the order alone is as it was', () => {
    expect(extensionTags({ after: 'previous' })).toEqual(['after previous']);
    expect(extensionTags({})).toEqual([]);
  });

  it.each([{ hours: 24 }, { minutes: 90 }, { days: 3 }])('is held by the draft and given back as the definition had it: %j', (within) => {
    const definition = bounded(within);
    const opened = fromDefinition(definition);
    expect(opened.whole).toBe(true);
    expect(opened.draft.steps[1]?.within).toEqual(within);
    expect(toDefinition(opened.draft, profile, false)).toEqual(definition);
  });

  it('is said in the words the client writes when the source’s words cannot be had', () => {
    const lines = draftWords(profile, stateOf(bounded({ hours: 24 })).draft, nameOf, [], []);
    expect(lines[2]?.text).toBe('Step 2: follow r-3 forward to n-c, after the previous step (by when), within 24 hours');
    expect(draftWords(profile, stateOf(bounded({ minutes: 1 })).draft, nameOf, [], [])[2]?.text).toContain('within 1 minute');
  });

  it('is kept and the step marked when the step before is removed and it becomes the first, the definition is held back, and Undo gives the draft back', () => {
    const before = stateOf(bounded({ hours: 24 }));
    const removed = run(before, { type: 'remove', index: 0 });
    expect(removed.draft.steps).toHaveLength(1);
    expect(removed.draft.steps[0]?.within).toEqual({ hours: 24 });
    expect(breaksOf(profile, removed.draft, false).map((found) => `${found.kind}@${found.step}`)[0]).toBe('order-first@0');
    expect(toDefinition(removed.draft, profile, false)).toBeUndefined();
    expect(run(removed, { type: 'undo' }).draft).toEqual(before.draft);
  });

  it('goes with the step when that step itself is deleted, and Undo brings it back', () => {
    const three: PatternDefinition = { anchorType: 'n-a', steps: [...bounded({ days: 3 }).steps, { relationshipTypes: ['r-d1'], direction: 'out', arrivesAt: 'n-d' }] };
    const before = stateOf(three);
    const removed = run(before, { type: 'remove', index: 1 });
    expect(removed.draft.steps).toHaveLength(2);
    expect(JSON.stringify(removed.draft)).not.toContain('within');
    const undone = run(removed, { type: 'undo' });
    expect(undone.draft).toEqual(before.draft);
    expect(undone.draft.steps[1]?.within).toEqual({ days: 3 });
    expect(toDefinition(undone.draft, profile, false)).toEqual(three);
  });
});

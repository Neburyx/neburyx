import { describe, expect, it } from 'vitest';
import type { PatternDefinition } from '@neburyx/contracts';
import { listed } from '../patterns-kit.js';
import { anchorChange, needsEntity } from './saved-model.js';

const definition = (anchorType: string): PatternDefinition => ({ anchorType, steps: [{ relationshipTypes: ['r'], direction: 'out', arrivesAt: 'y' }] });
const held = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha', askForStartingEntity: false, anchor: { entityType: 'x', stableId: 'old' }, definition: definition('x') });
const asking = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta', askForStartingEntity: true, anchor: null, definition: definition('x') });
const chosen = { entityType: 'x', stableId: 'now' };

describe('what a change says of the starting entity', () => {
  it('says nothing while the start type and the choice are as stored, whatever entity is chosen or loaded', () => {
    expect(anchorChange(held, definition('x'), false, undefined)).toEqual({ send: false });
    expect(anchorChange(held, definition('x'), false, chosen)).toEqual({ send: false });
    expect(anchorChange(asking, definition('x'), true, undefined)).toEqual({ send: false });
  });

  it('sends the entity chosen now when the pattern that asked each time now holds one, and null when the choice goes back to asking', () => {
    expect(anchorChange(asking, definition('x'), false, chosen)).toEqual({ send: true, anchor: chosen });
    expect(anchorChange(held, definition('x'), true, chosen)).toEqual({ send: true, anchor: null });
  });

  it('sends the entity chosen now, or null, when the start type changed', () => {
    expect(anchorChange(held, definition('z'), false, { entityType: 'z', stableId: 'new' })).toEqual({ send: true, anchor: { entityType: 'z', stableId: 'new' } });
    expect(anchorChange(held, definition('z'), true, undefined)).toEqual({ send: true, anchor: null });
  });

  it('needs the person to choose an entity when the pattern asks each time or the start type changed, and not otherwise', () => {
    expect(needsEntity(asking, definition('x'))).toBe(true);
    expect(needsEntity(held, definition('z'))).toBe(true);
    expect(needsEntity(held, definition('x'))).toBe(false);
  });
});

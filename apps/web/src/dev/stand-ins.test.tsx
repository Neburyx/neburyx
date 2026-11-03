import { describe, expect, it } from 'vitest';
import { createSlotRegistry, SLOT_NAMES, type SlotName } from '../workspace/slots.js';
import { registerStandIns } from './stand-ins.js';

const BUILT_LATER: readonly SlotName[] = SLOT_NAMES.filter((name) => name !== 'ask' && name !== 'summarize');

describe('the slot stand-ins', () => {
  it('fill every slot whose occupant is not built, and not Ask or Summarize', () => {
    const registry = createSlotRegistry();
    registerStandIns(registry);
    expect([...registry.view.getState().keys()].sort()).toEqual([...BUILT_LATER].sort());
  });

  it('leave an occupied slot as it is, fill the free ones and do not throw', () => {
    const registry = createSlotRegistry();
    const save = () => null;
    registry.register('save', save);
    expect(() => registerStandIns(registry)).not.toThrow();
    expect(registry.view.getState().get('save')).toBe(save);
    expect(registry.view.getState().size).toBe(BUILT_LATER.length);
  });

  it('fill a slot that was freed when asked again, and add nothing twice', () => {
    const registry = createSlotRegistry();
    const remove = registry.register('save', () => null);
    registerStandIns(registry);
    remove();
    registerStandIns(registry);
    registerStandIns(registry);
    expect(registry.view.getState().size).toBe(BUILT_LATER.length);
  });

  it('are taken out by the function they return, and only what they put in', () => {
    const registry = createSlotRegistry();
    const save = () => null;
    registry.register('save', save);
    const remove = registerStandIns(registry);
    remove();
    expect([...registry.view.getState().keys()]).toEqual(['save']);
  });
});

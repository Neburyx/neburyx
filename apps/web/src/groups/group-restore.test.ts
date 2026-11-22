import { describe, expect, it } from 'vitest';
import { restoredGroups } from './group-restore.js';

const keys = new Map([['t\u00001', 'k1'], ['t\u00002', 'k2'], ['u\u00003', 'k3']]);
const lookup = (type: string, id: string) => keys.get(`${type}\u0000${id}`);
const member = (t: string, id: string) => ({ t, id });

describe('restoredGroups', () => {
  it('keeps the members that are loaded, in order, and reads a missing collapsed flag as expanded', () => {
    expect(restoredGroups([{ id: 'g', by: 'entityType', members: [member('t', '1'), member('t', '9'), member('t', '2')] }], lookup)).toEqual([{ id: 'g', by: 'entityType', members: ['k1', 'k2'], collapsed: false }]);
  });

  it('keeps the collapsed flag when it is stored', () => {
    expect(restoredGroups([{ id: 'g', by: 'component', members: [member('t', '1')], collapsed: true }], lookup)[0]?.collapsed).toBe(true);
  });

  it('drops a mode this client does not know, an empty group and a group none of whose members is loaded', () => {
    const stored = [
      { id: 'a', by: 'something-new', members: [member('t', '1')] },
      { id: 'b', by: 'entityType', members: [] },
      { id: 'c', by: 'entityType', members: [member('t', '8')] },
    ];
    expect(restoredGroups(stored, lookup)).toEqual([]);
  });

  it('puts an entity in the first group that names it only', () => {
    const stored = [
      { id: 'a', by: 'entityType', members: [member('t', '1')] },
      { id: 'b', by: 'component', members: [member('t', '1'), member('u', '3')] },
    ];
    expect(restoredGroups(stored, lookup).map((group) => [group.id, group.members])).toEqual([['a', ['k1']], ['b', ['k3']]]);
  });

  it('accepts a property mode, whose eligibility the guard decides later', () => {
    expect(restoredGroups([{ id: 'p', by: 'property:currency', members: [member('t', '1')], collapsed: true }], lookup)).toHaveLength(1);
  });
});

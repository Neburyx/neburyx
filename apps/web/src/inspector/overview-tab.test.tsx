import { describe, expect, it } from 'vitest';
import { entity, inInspector, inspectorRig, profileOf, property, select } from './inspector-kit.js';

const open = (node = entity('n1'), profile = profileOf()) => {
  const rig = inspectorRig({ nodes: [node], profile });
  select(rig.state, 'n1');
  return rig;
};
const rowText = (): string[] => [...document.querySelectorAll('.inspector-overview > dl .inspector-row')].map((row) => row.textContent ?? '');

describe('the Overview tab', () => {
  it('lists the key properties in the profile order, "unavailable" for one the node lacks, and no other property', () => {
    open(entity('n1', [property('opened', 'x'), property('holder', 'Jordan'), property('secret', 'hidden')]));
    expect(rowText()).toEqual(['holderJordan', 'openedx']);
    expect(inInspector().queryByText('hidden')).toBeNull();
  });

  it('shows "unavailable" for a key property the node does not carry', () => {
    open(entity('n1', [property('holder', 'Jordan')]));
    expect(rowText()).toEqual(['holderJordan', 'openedunavailable']);
  });

  it('shows a dateTime as UTC with seconds, across a change of day in UTC', () => {
    open(entity('n1', [property('holder', '2024-02-06T09:00:00Z', 'dateTime'), property('opened', '2024-02-06T23:59:59-05:00', 'dateTime')]));
    expect(rowText()).toEqual(['holder6 Feb 2024, 09:00:00 UTC', 'opened7 Feb 2024, 04:59:59 UTC']);
  });

  it('shows a date as read and a localDateTime as read with its note', () => {
    open(entity('n1', [property('holder', '2024-02-06', 'date'), property('opened', '2024-02-06T09:00:00', 'localDateTime')]));
    expect(rowText()).toEqual(['holder2024-02-06', 'opened2024-02-06T09:00:00 (no time zone)']);
  });

  it('shows a time as read and a localTime as read with its note', () => {
    open(entity('n1', [property('holder', '09:00:00Z', 'time'), property('opened', '09:00:00', 'localTime')]));
    expect(rowText()).toEqual(['holder09:00:00Z', 'opened09:00:00 (no time zone)']);
  });

  it('turns a dateTime with a named zone after its offset into UTC and drops the name', () => {
    open(entity('n1', [property('holder', '2024-02-06T09:00:00Z[Europe/London]', 'dateTime'), property('opened', '2024-02-06T00:30:00+02:00[Africa/Cairo]', 'dateTime')]));
    expect(rowText()).toEqual(['holder6 Feb 2024, 09:00:00 UTC', 'opened5 Feb 2024, 22:30:00 UTC']);
  });

  it('shows an unparsable dateTime as read and a masked date as its mask', () => {
    open(entity('n1', [property('holder', 'not a date', 'dateTime'), property('opened', '•• ••• ••••', 'date', true)]));
    expect(rowText()).toEqual(['holdernot a date', 'opened•• ••• ••••']);
  });

  it('shows a masked property as the mask the server returned', () => {
    open(entity('n1', [property('holder', 'J••• L•••', 'name', true)]));
    expect(rowText()[0]).toBe('holderJ••• L•••');
  });

  it('shows the state property in the header with its caption, and nothing when the type declares none', () => {
    open(entity('n1', [property('status', 'Review required')]));
    expect(document.querySelector('.inspector-status')?.textContent).toBe('Review requiredstatus from source');
  });

  it('draws no status line when the type declares no state property', () => {
    open(entity('n1', [property('status', 'Review required')]), profileOf(['holder'], null));
    expect(document.querySelector('.inspector-status')).toBeNull();
  });

  it('lists the source records as plain text and draws nothing for none', () => {
    open(entity('n1', [], { provenanceRefs: ['AUTH-1', 'AUTH-2'] }));
    expect(inInspector().getByRole('region', { name: 'Source records' }).textContent).toContain('AUTH-2');
  });

  it('draws no source records section when there are none', () => {
    open();
    expect(inInspector().queryByRole('region', { name: 'Source records' })).toBeNull();
  });

  it('says so when the type maps no key properties, and keeps the other sections', () => {
    open(entity('n1'), profileOf([], null));
    expect(inInspector().getByText('No key properties are mapped for this type.')).toBeTruthy();
  });

  it('draws no key-property rows, no message and no status while the profile has not been read', () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Jordan'), property('status', 'x')])], profile: undefined });
    select(rig.state, 'n1');
    expect(rowText()).toEqual([]);
    expect(inInspector().queryByText('No key properties are mapped for this type.')).toBeNull();
    expect(document.querySelector('.inspector-status')).toBeNull();
    expect(inInspector().queryByText('Jordan')).toBeNull();
  });

  it('shows a label for each known quality flag at once, and none for a flag it does not know', () => {
    open(entity('n1', [], { qualityFlags: ['missing-property', 'title-incomplete', 'made-up-flag'] }));
    expect(inInspector().getByText('Some mapped properties are missing')).toBeTruthy();
    expect(inInspector().getByText('The title is incomplete')).toBeTruthy();
    expect(document.querySelectorAll('.inspector-quality li')).toHaveLength(2);
  });
});

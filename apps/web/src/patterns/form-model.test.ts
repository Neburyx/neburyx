import { paramsJsonSchemaOf } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildParams, fieldsOf, FORM_ERRORS, plainName, windowKey } from './form-model.js';
import { CONNECTED, SHARED_DEVICES } from './patterns-kit.js';

const choices = { entityTypes: [{ value: 'kind-b', text: 'B' }], relationshipTypes: [{ value: 'USES', text: 'USES' }] };
const anchor = { entityType: 'kind-a', stableId: 'acc-1' };

describe('the fields of a pattern', () => {
  it('are the schema’s parameters minus the anchor and what the preset binds', () => {
    const shared = fieldsOf(SHARED_DEVICES, paramsJsonSchemaOf('shared-attribute'), choices);
    expect(shared.map((field) => field.name)).toEqual(['window', 'minShared', 'limit']);
    const linked = fieldsOf(CONNECTED, paramsJsonSchemaOf('linked-entities'), choices);
    expect(linked.map((field) => field.name)).toEqual(['direction', 'maxHops', 'window', 'limit']);
  });

  it('shows a free type or relationship as a choice from the mapping and uses the preset label or the plain name', () => {
    const free = { ...SHARED_DEVICES, bind: { anchor: 'kind-a' } };
    const fields = fieldsOf(free, paramsJsonSchemaOf('shared-attribute'), choices);
    expect(fields.map((field) => [field.name, field.kind])).toEqual([['attributeType', 'choice'], ['via', 'choice'], ['window', 'window'], ['minShared', 'integer'], ['limit', 'integer']]);
    expect(fields.find((field) => field.name === 'minShared')?.label).toBe('Min shared');
    expect(fields.find((field) => field.name === 'limit')?.label).toBe('Max matching accounts');
    expect(plainName('maxHops')).toBe('Max hops');
  });

  it('takes the bounds of a number from the schema', () => {
    const fields = fieldsOf(SHARED_DEVICES, paramsJsonSchemaOf('shared-attribute'), choices);
    expect(fields.find((field) => field.name === 'minShared')).toMatchObject({ min: 1, max: 50 });
    expect(fields.find((field) => field.name === 'limit')).toMatchObject({ min: 1 });
  });
});

describe('the parameters sent', () => {
  const fields = fieldsOf(SHARED_DEVICES, paramsJsonSchemaOf('shared-attribute'), choices);
  it('hold only the ref when nothing was filled', () => {
    expect(buildParams(fields, {}, anchor)).toEqual({ ok: true, params: { ref: anchor } });
  });
  it('send a window of two dates, a limit and minShared as numbers', () => {
    expect(buildParams(fields, { [windowKey('window', 'from')]: '2026-10-21', [windowKey('window', 'to')]: '2026-10-28', limit: '25', minShared: '2' }, anchor)).toEqual({ ok: true, params: { ref: anchor, window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25, minShared: 2 } });
  });
  it('refuse a window with one date, reversed, not a date or too wide', () => {
    const w = (from: string, to: string) => buildParams(fields, { [windowKey('window', 'from')]: from, [windowKey('window', 'to')]: to }, anchor);
    expect(w('2026-10-21', '')).toEqual({ ok: false, errors: { window: FORM_ERRORS.windowBoth } });
    expect(w('2026-10-28', '2026-10-21')).toEqual({ ok: false, errors: { window: FORM_ERRORS.windowOrder } });
    expect(w('2026-02-31', '2026-03-01')).toEqual({ ok: false, errors: { window: FORM_ERRORS.windowDate } });
    expect(w('2000-01-01', '2026-01-01')).toEqual({ ok: false, errors: { window: FORM_ERRORS.windowWide } });
  });
  it('refuse a limit below 1, text, and minShared above the schema’s maximum', () => {
    expect(buildParams(fields, { limit: '0' }, anchor).ok).toBe(false);
    expect(buildParams(fields, { limit: 'many' }, anchor).ok).toBe(false);
    expect(buildParams(fields, { minShared: '51' }, anchor)).toEqual({ ok: false, errors: { minShared: FORM_ERRORS.whole(1, 50) } });
  });
  it('wrap a relationship choice that is a list in the schema as a list of one', () => {
    const linked = fieldsOf({ ...CONNECTED, bind: { anchor: 'kind-a', target: 'kind-a' } }, paramsJsonSchemaOf('linked-entities'), choices);
    expect(buildParams(linked, { via: 'USES', maxHops: '2' }, anchor)).toEqual({ ok: true, params: { ref: anchor, via: ['USES'], maxHops: 2 } });
    expect(buildParams(linked, { maxHops: '5' }, anchor).ok).toBe(false);
  });
});

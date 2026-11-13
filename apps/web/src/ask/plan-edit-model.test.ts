import type { AskPlan, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { buildParams, editFieldsOf, initialValues } from './plan-edit-model.js';
import type { TemplatePlan } from './plan-model.js';

const REF = { entityType: 'kind-a', stableId: 'a-1' };
const plan = (templateId: string, params: object): TemplatePlan => ({ kind: 'plan', templateId, templateVersion: 1, rationale: 'x', params }) as AskPlan as TemplatePlan;
const profile: SourceProfile = testProfile('demo');
const build = (p: TemplatePlan, values: Record<string, string | string[]>) => buildParams(p, editFieldsOf(p, profile), { ...initialValues(p, editFieldsOf(p, profile)), ...values }, 'demo');

describe('a value the form refuses', () => {
  const shared = plan('shared-attribute', { ref: REF, attributeType: 'kind-b', via: 'link-a', limit: 25 });

  it.each([
    ['a limit of zero', { limit: '0' }, 'limit'],
    ['a limit that is not a whole number', { limit: '2.5' }, 'limit'],
    ['a limit of text', { limit: 'many' }, 'limit'],
    ['a minimum shared above the contract\'s', { minShared: '1000' }, 'minShared'],
    ['days of zero in a window', { windowKind: 'days', windowDays: '0' }, 'window'],
    ['days above the contract\'s', { windowKind: 'days', windowDays: '99999' }, 'window'],
    ['dates out of order', { windowKind: 'range', windowFrom: '2026-02-01', windowTo: '2026-01-01' }, 'window'],
    ['dates that are not dates', { windowKind: 'range', windowFrom: 'soon', windowTo: 'later' }, 'window'],
  ])('is refused for %s, and nothing is built', (_name, values, key) => {
    const built = build(shared, values);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(Object.keys(built.errors)).toEqual([key]);
  });

  it('refuses an expand with no neighbor type, a rule with none, and a search with no type or text, each at its own field', () => {
    const expand = plan('expand', { ref: REF, neighborTypes: ['kind-b'] });
    expect(build(expand, { neighborTypes: [] })).toMatchObject({ ok: false, errors: { neighborTypes: expect.any(String) } });
    expect(build(plan('derived-rule-run', { ref: REF, ruleId: 'rule-1' }), { ruleId: '' })).toMatchObject({ ok: false, errors: { ruleId: expect.any(String) } });
    const search = plan('search', { entityTypes: ['kind-a'], text: 'ref 77' });
    expect(build(search, { entityTypes: [], text: '' })).toMatchObject({ ok: false, errors: { entityTypes: expect.any(String), text: expect.any(String) } });
    expect(build(search, { text: 'x'.repeat(201) })).toMatchObject({ ok: false, errors: { text: expect.any(String) } });
  });
});

describe('the parameters an edit sends', () => {
  it('carry the source on the reference, keep the plan’s own parameters and apply each field', () => {
    const shared = plan('shared-attribute', { ref: REF, attributeType: 'kind-b', via: 'link-a', limit: 25 });
    expect(build(shared, { limit: '10', windowKind: 'days', windowDays: '7', minShared: '2' })).toEqual({ ok: true, params: { ref: { sourceId: 'demo', ...REF }, attributeType: 'kind-b', via: 'link-a', limit: 10, window: { days: 7 }, minShared: 2 } });
  });

  it('drops a parameter whose field was emptied, so the source’s default applies', () => {
    const shared = plan('shared-attribute', { ref: REF, attributeType: 'kind-b', via: 'link-a', limit: 25 });
    expect(build(shared, { limit: '' })).toEqual({ ok: true, params: { ref: { sourceId: 'demo', ...REF }, attributeType: 'kind-b', via: 'link-a' } });
  });

  it('carry the source on both ends of a derived edge, which has only its rule to change', () => {
    const edge = plan('derived-edge-support', { ruleId: 'rule-1', ends: [REF, { entityType: 'kind-a', stableId: 'a-2' }] });
    expect(editFieldsOf(edge, profile).map((field) => field.key)).toEqual(['ruleId']);
    expect(build(edge, {})).toEqual({ ok: true, params: { ruleId: 'rule-1', ends: [{ sourceId: 'demo', ...REF }, { sourceId: 'demo', entityType: 'kind-a', stableId: 'a-2' }] } });
  });

  it('build the types of an expand and a search from the choices, and a window of dates', () => {
    const expand = plan('expand', { ref: REF, neighborTypes: ['kind-b'] });
    expect(build(expand, { neighborTypes: ['kind-b', 'kind-c'], relTypes: ['link-a'], direction: 'out', sort: 'observed', windowKind: 'range', windowFrom: '2026-01-01', windowTo: '2026-02-01' })).toMatchObject({ ok: true, params: { neighborTypes: ['kind-b', 'kind-c'], relTypes: ['link-a'], direction: 'out', sort: 'observed', window: { from: '2026-01-01', to: '2026-02-01' } } });
    expect(build(plan('search', { entityTypes: ['kind-a'], text: 'ref 77' }), { text: 'ref 88' })).toEqual({ ok: true, params: { entityTypes: ['kind-a'], text: 'ref 88' } });
  });

  it('are never built with a field the plan does not have, and a reference is never a field', () => {
    for (const template of ['entity', 'degree-preview']) expect(editFieldsOf(plan(template, { ref: REF }), profile)).toEqual([]);
    const keys = ['shared-attribute', 'linked-entities', 'expand', 'derived-rule-run', 'derived-edge-support', 'search'].flatMap((template) => editFieldsOf(plan(template, { ref: REF, neighborTypes: ['kind-b'], ruleId: 'rule-1', entityTypes: ['kind-a'], text: 'x', ends: [REF, REF] }), profile).map((field) => field.key));
    expect(keys).not.toContain('ref');
    expect(keys).not.toContain('ends');
  });
});

describe('the choices of a field', () => {
  it('come from the source’s own profile, with the display names of its entity types', () => {
    const fields = editFieldsOf(plan('shared-attribute', { ref: REF }), profile);
    const attribute = fields.find((field) => field.key === 'attributeType');
    expect(attribute?.kind === 'choice' ? attribute.options.map((option) => option.value) : []).toEqual(['kind-a', 'kind-b', 'kind-c']);
    const rules = editFieldsOf(plan('derived-rule-run', { ref: REF, ruleId: 'rule-1' }), profile).find((field) => field.key === 'ruleId');
    expect(rules?.kind === 'choice' ? rules.options.map((option) => option.value) : []).toEqual(['rule-1']);
  });

  it('keep the value the plan holds when the profile is not there, so the plan can be saved as it is', () => {
    const held = plan('shared-attribute', { ref: REF, attributeType: 'kind-b', via: 'link-a' });
    const attribute = editFieldsOf(held, undefined).find((field) => field.key === 'attributeType');
    expect(attribute?.kind === 'choice' ? attribute.options.map((option) => option.value) : []).toEqual(['kind-b']);
    expect(buildParams(held, editFieldsOf(held, undefined), initialValues(held, editFieldsOf(held, undefined)), 'demo')).toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from 'vitest';
import { bindQueryIntent, bindTemplateIntent, checkTemplateSettings, placeholderNames } from './ask-bind.js';

const REF = { entityType: 'widget', stableId: '$id' };
const SHARED = { template: 'shared-attribute' as const, parameters: ['id'], settings: { ref: REF, attributeType: 'shape', via: 'USES_SHAPE' } };

describe('the placeholders of a template intent', () => {
  it('are the strings that are exactly $name, in any value position and never a key', () => {
    expect(placeholderNames({ a: '$one', b: ['$two', { c: '$three' }], $four: 'x', d: '$a$b', e: '$', f: 'x $id', g: '$1', h: 5, i: null })).toEqual(['one', 'two', 'three']);
  });
});

describe('the settings of a template intent, checked at start-up', () => {
  const check = (over: Record<string, unknown>) => checkTemplateSettings({ intent: 'named', template: 'shared-attribute', parameters: ['id'], settings: SHARED.settings, ...over });

  it('pass when the placeholders are the parameters and the settings fit the template with each placeholder as text', () => {
    expect(check({})).toEqual([]);
  });

  it('name a parameter without a placeholder and a placeholder that is no parameter', () => {
    expect(check({ parameters: ['id', 'other'] }).join(' ')).toContain('the parameter other has no placeholder');
    expect(check({ settings: { ...SHARED.settings, via: '$rel' } }).join(' ')).toContain('the placeholder rel, which is not a parameter');
  });

  it('refuse settings that do not fit the template, naming the path and never a value', () => {
    const problems = check({ settings: { ref: { entityType: 'SENTINEL', stableId: '$id', extra: 1 }, attributeType: 'shape' } }).join(' ');
    expect(problems).toContain('do not fit the template');
    expect(problems).not.toContain('SENTINEL');
  });

  it('refuse a placeholder where the schema takes no text: a number, an enum and the window', () => {
    expect(check({ parameters: ['id', 'n'], settings: { ...SHARED.settings, limit: '$n' } }).join(' ')).toContain('limit');
    expect(checkTemplateSettings({ intent: 'x', template: 'expand', parameters: ['id', 'd'], settings: { ref: REF, neighborTypes: ['t'], direction: '$d' } }).join(' ')).toContain('direction');
    expect(checkTemplateSettings({ intent: 'x', template: 'expand', parameters: ['id', 'w'], settings: { ref: REF, neighborTypes: ['t'], window: '$w' } }).join(' ')).toContain('window');
  });

  it('take a placeholder as one element of an array of text, and refuse one that stands for the whole array', () => {
    expect(checkTemplateSettings({ intent: 'x', template: 'expand', parameters: ['id', 't'], settings: { ref: REF, neighborTypes: ['$t'] } })).toEqual([]);
    expect(checkTemplateSettings({ intent: 'x', template: 'expand', parameters: ['id', 't'], settings: { ref: REF, neighborTypes: '$t' } }).join(' ')).toContain('neighborTypes');
    expect(checkTemplateSettings({ intent: 'x', template: 'search', parameters: ['t', 'q'], settings: { entityTypes: ['$t'], text: '$q' } })).toEqual([]);
    expect(checkTemplateSettings({ intent: 'x', template: 'linked-entities', parameters: ['id', 'v'], settings: { ref: REF, targetType: 'widget', via: ['$v'] } }).join(' ')).not.toContain('via');
  });

  it('pass for each of the eight templates with a placeholder in a text position', () => {
    const ends = [{ entityType: 'widget', stableId: '$a' }, { entityType: 'widget', stableId: '$b' }];
    const cases: readonly (readonly [string, readonly string[], Record<string, unknown>])[] = [
      ['entity', ['id'], { ref: REF }],
      ['degree-preview', ['id'], { ref: REF }],
      ['derived-rule-run', ['id'], { ref: REF, ruleId: 'shared-shape' }],
      ['derived-edge-support', ['a', 'b'], { ruleId: 'shared-shape', ends }],
      ['search', ['q'], { entityTypes: ['widget'], text: '$q' }],
      ['expand', ['id'], { ref: REF, neighborTypes: ['shape'] }],
    ];
    for (const [template, parameters, settings] of cases) expect(checkTemplateSettings({ intent: 'x', template, parameters, settings }), template).toEqual([]);
  });
});

describe('binding the entities of a question to a template intent', () => {
  it('replaces each placeholder with the text of that name and gives the template and its parameters', () => {
    const bound = bindTemplateIntent(SHARED, { id: 'A-1' });
    expect(bound).toMatchObject({ ok: true, template: 'shared-attribute', params: { ref: { entityType: 'widget', stableId: 'A-1' }, attributeType: 'shape', via: 'USES_SHAPE' } });
  });

  it('binds the pair of ends of a derived edge and an element of an array', () => {
    const ends = [{ entityType: 'widget', stableId: '$a' }, { entityType: 'widget', stableId: '$b' }];
    expect(bindTemplateIntent({ template: 'derived-edge-support', parameters: ['a', 'b'], settings: { ruleId: 'r', ends } }, { a: 'A', b: 'B' })).toMatchObject({ ok: true, params: { ends: [{ stableId: 'A' }, { stableId: 'B' }] } });
    expect(bindTemplateIntent({ template: 'expand', parameters: ['id', 't'], settings: { ref: REF, neighborTypes: ['$t'] } }, { id: 'A', t: 'shape' })).toMatchObject({ ok: true, params: { neighborTypes: ['shape'] } });
  });

  it('refuses a missing entity, an extra one and both, with names only', () => {
    expect(bindTemplateIntent(SHARED, {})).toEqual({ ok: false, cause: 'missing-inputs', parameters: ['id'], found: [], missing: ['id'], extra: [] });
    expect(bindTemplateIntent(SHARED, { id: 'SENTINEL', more: 'SENTINEL' })).toEqual({ ok: false, cause: 'extra-inputs', parameters: ['id'], found: ['id', 'more'], missing: [], extra: ['more'] });
    expect(bindTemplateIntent(SHARED, { other: 'SENTINEL' })).toMatchObject({ ok: false, cause: 'missing-inputs', missing: ['id'], extra: ['other'] });
    expect(JSON.stringify(bindTemplateIntent(SHARED, { id: 'SENTINEL', more: 'SENTINEL' }))).not.toContain('SENTINEL"');
  });

  it('refuses a text the template does not take, as invalid inputs', () => {
    const search = { template: 'search' as const, parameters: ['q'], settings: { entityTypes: ['widget'], text: '$q' } };
    expect(bindTemplateIntent(search, { q: 'x'.repeat(300) })).toMatchObject({ ok: false, cause: 'invalid-inputs' });
  });

  it('does not substitute a key, a text that only holds a placeholder, or a value of an entity that looks like one', () => {
    const bound = bindTemplateIntent({ template: 'search', parameters: ['q'], settings: { entityTypes: ['widget'], text: '$q' } }, { q: '$q' });
    expect(bound).toMatchObject({ ok: true, params: { text: '$q' } });
  });
});

describe('binding the entities of a question to a file-query intent', () => {
  const intent = { parameters: ['name', 'kind'] };

  it('gives the entities as the values when they are exactly the intent\'s parameters', () => {
    expect(bindQueryIntent(intent, { name: 'Ada', kind: 'x' })).toEqual({ ok: true, values: { name: 'Ada', kind: 'x' } });
  });

  it('refuses a missing entity, an extra one and both, with names only', () => {
    expect(bindQueryIntent(intent, { name: 'Ada' })).toEqual({ ok: false, cause: 'missing-inputs', parameters: ['name', 'kind'], found: ['name'], missing: ['kind'], extra: [] });
    expect(bindQueryIntent(intent, { name: 'SENTINEL', kind: 'x', more: 'SENTINEL' })).toEqual({ ok: false, cause: 'extra-inputs', parameters: ['name', 'kind'], found: ['name', 'kind', 'more'], missing: [], extra: ['more'] });
    expect(bindQueryIntent(intent, { other: 'x' })).toMatchObject({ ok: false, cause: 'missing-inputs', missing: ['name', 'kind'], extra: ['other'] });
  });
});

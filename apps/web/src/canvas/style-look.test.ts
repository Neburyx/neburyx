import type { GraphNode, SourceProfile, StyleRuleProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testProfile } from '../dev/test-profile.js';
import { node } from '../state/test-data.js';
import { entityLook } from './entity-look.js';
import { DERIVED_COLOR, NODE_OUTLINE, STYLE_TONE_COLORS } from './look.js';
import { styleLookOf } from './style-look.js';

const rule = (id: string, effect: StyleRuleProfile['effect'], overrides: Partial<StyleRuleProfile> = {}): StyleRuleProfile => ({ id, label: id.toUpperCase(), appliesTo: 'type-a', effect, condition: 'status = x', ...overrides });

function profileOf(...rules: StyleRuleProfile[]): SourceProfile {
  const base = testProfile('source-a');
  const first = base.entityTypes[0];
  if (first === undefined) throw new Error('the test profile has no entity type');
  return { ...base, entityTypes: [{ ...first, type: 'type-a', label: 'Alpha', displayName: 'Alpha', icon: 'money', stateProperty: 'status' }, ...base.entityTypes.slice(1)], styleRules: rules };
}

const withIds = (ids: string[] | undefined, properties: GraphNode['properties'] = []): GraphNode => ({ ...node('source-a', 'n1'), display: { title: 'ACC-1', type: 'type-a', ...(ids === undefined ? {} : { styleRules: ids }) }, properties });

describe('the look the style rules give a node', () => {
  it('gives a node no look when it matched no rule, the profile lists none or has not answered, or every id is unknown', () => {
    expect(styleLookOf(withIds(undefined), profileOf(rule('a', { badge: 'amber' })))).toBeUndefined();
    expect(styleLookOf(withIds([]), profileOf(rule('a', { badge: 'amber' })))).toBeUndefined();
    expect(styleLookOf(withIds(['a']), undefined)).toBeUndefined();
    expect(styleLookOf(withIds(['a']), { ...profileOf(), styleRules: undefined })).toBeUndefined();
    expect(styleLookOf(withIds(['a']), profileOf())).toBeUndefined();
    expect(styleLookOf(withIds(['unlisted']), profileOf(rule('a', { badge: 'amber' })))).toBeUndefined();
  });

  it('lets the first rule of an effect kind in the profile order decide it, whatever the order of the ids, and lets another kind apply beside it', () => {
    const profile = profileOf(rule('first', { badge: 'amber' }), rule('second', { badge: 'red' }), rule('color', { color: 'green' }), rule('icon', { icon: 'shield' }), rule('size', { size: 'larger' }), rule('again', { color: 'blue' }));
    const look = styleLookOf(withIds(['again', 'size', 'second', 'icon', 'color', 'first']), profile);
    expect(look).toEqual({ badge: 'amber', color: 'green', icon: 'shield', larger: true, labels: ['FIRST', 'COLOR', 'ICON', 'SIZE'] });
  });

  it('ignores a rule that applies to another type, and an id the profile does not list', () => {
    const profile = profileOf(rule('mine', { badge: 'amber' }), rule('theirs', { color: 'red' }, { appliesTo: 'type-b' }));
    expect(styleLookOf(withIds(['theirs', 'mine', 'gone']), profile)).toEqual({ badge: 'amber', labels: ['MINE'] });
  });

  it('puts the rule icon in the node look in place of the type icon, and names the rules in the hover tip', () => {
    const look = entityLook(withIds(['a', 'b'], [{ key: 'status', value: 'Open', dataClass: 'text', masked: false }]), profileOf(rule('a', { icon: 'shield' }, { label: 'Review required' }), rule('b', { badge: 'amber' }, { label: 'High' })));
    expect(look.iconKey).toBe('shield');
    expect(look.line2).toBe('Alpha · Open');
    expect(look.tip).toEqual({ title: 'ACC-1', detail: 'Alpha · Open\nStyle: Review required, High' });
    expect(look.style?.badge).toBe('amber');
  });

  it('gives a node with no look exactly the look it had before the feature', () => {
    expect(entityLook(withIds(undefined), profileOf(rule('a', { badge: 'amber' })))).toEqual({ iconKey: 'money', line1: 'ACC-1', line2: 'Alpha' });
  });
});

describe('the tones', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

  it('are the colours of the page tokens', () => {
    for (const [tone, color] of Object.entries(STYLE_TONE_COLORS)) expect(css).toContain(`--style-tone-${tone}: ${color};`);
  });

  it('differ from the plain outline and from the accent of the selection and the focus ring, and from one another', () => {
    const colors = Object.values(STYLE_TONE_COLORS).map((color) => color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(NODE_OUTLINE.toLowerCase());
    expect(colors).not.toContain(DERIVED_COLOR.toLowerCase());
  });
});

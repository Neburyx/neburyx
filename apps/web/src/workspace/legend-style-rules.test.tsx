import type { SourceProfile, StyleRuleProfile } from '@neburyx/contracts';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { glyphUri } from '../canvas/glyphs.js';
import { STYLE_TONE_COLORS } from '../canvas/look.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import type { ProfileState, ProfileStore } from '../canvas/profile-store.js';
import { testProfile } from '../dev/test-profile.js';
import { STYLE_RULES_GUIDE } from '../help/links.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createStore, readable } from '../state/store.js';
import { LegendPanel } from './legend-panel.js';

const rule = (id: string, label: string, effect: StyleRuleProfile['effect'], overrides: Partial<StyleRuleProfile> = {}): StyleRuleProfile => ({ id, label, appliesTo: 'kind-a', effect, condition: 'status = review', ...overrides });

const profileOf = (...rules: StyleRuleProfile[]): SourceProfile => ({ ...testProfile('s', ['kind-a', 'kind-b']), styleRules: rules });

function controlled(initial: ProfileState['request']) {
  const store = createStore<ProfileState>({ sourceId: 's', request: initial });
  const profile: ProfileStore = { ...readable(store), reload: () => undefined };
  const state = createClientState();
  state.bindSource('s');
  const view = render(
    <ClientStateProvider state={state}>
      <ProfileProvider store={profile}>
        <LegendPanel />
      </ProfileProvider>
    </ClientStateProvider>,
  );
  return { ...view, set: (request: ProfileState['request']): void => act(() => store.setState({ sourceId: 's', request })) };
}

const rows = (container: HTMLElement) => [...container.querySelectorAll('.legend-rule')];
const text = (row: Element | undefined, selector: string) => row?.querySelector(selector)?.textContent;

describe('the legend\'s style rules', () => {
  const rules = [
    rule('review', 'review required', { badge: 'amber' }, { condition: 'flag_x = value_y' }),
    rule('score', 'high score', { size: 'larger' }, { appliesTo: 'kind-b', condition: 'score > 2,000' }),
    rule('tint', 'watch', { color: 'red' }),
    rule('mark', 'shield', { icon: 'shield' }),
  ];

  it('lists each rule in mapping order after a divider, as the frame: the effect and the label, then the condition and the type name', () => {
    const { container } = controlled({ phase: 'ready', data: profileOf(...rules) });
    expect(screen.getByRole('heading', { name: 'STYLE RULES from neburyx.yaml' })).toBeTruthy();
    expect(rows(container).map((row) => [text(row, '.legend-rule-title'), text(row, '.legend-rule-detail')])).toEqual([
      ['Amber badge: review required', 'flag_x = value_y · KIND-A'],
      ['Larger node: high score', 'score > 2,000 · KIND-B'],
      ['Red color: watch', 'status = review · KIND-A'],
      ['Icon shield: shield', 'status = review · KIND-A'],
    ]);
  });

  it('draws a sample of each effect: the badge in its tone, the colour on the outline and the glyph, the icon of the rule, and a larger swatch', () => {
    const { container } = controlled({ phase: 'ready', data: profileOf(...rules) });
    const [badge, size, color, icon] = rows(container);
    expect(badge?.querySelector('.legend-rule-badge')?.className).toContain('legend-tone-amber');
    expect(size?.className).toContain('legend-rule-larger');
    expect(color?.querySelector('.legend-swatch')?.className).toContain('legend-tone-red');
    expect(color?.querySelector('img')?.getAttribute('src')).toBe(glyphUri('generic', STYLE_TONE_COLORS.red));
    expect(icon?.querySelector('img')?.getAttribute('src')).toBe(glyphUri('shield', '#747a85'));
    expect(container.querySelectorAll('.legend-rule-badge')).toHaveLength(1);
    expect(badge?.querySelector('img')).toBeNull();
    expect(size?.querySelector('img')).toBeNull();
  });

  it('says which rule applies where two rules of one type and one effect kind both match, and nothing for other rules', () => {
    const { container } = controlled({ phase: 'ready', data: profileOf(rule('a', 'First', { badge: 'amber' }), rule('b', 'Second', { badge: 'red' }), rule('c', 'Third', { badge: 'blue' }, { appliesTo: 'kind-b' }), rule('d', 'Fourth', { color: 'red' })) });
    const details = rows(container).map((row) => [...row.querySelectorAll('.legend-rule-detail')].map((line) => line.textContent));
    expect(details[0]).toEqual(['status = review · KIND-A']);
    expect(details[1]).toEqual(['status = review · KIND-A', 'Where both match, First applies.']);
    expect(details[2]).toEqual(['status = review · KIND-B']);
    expect(details[3]).toEqual(['status = review · KIND-A']);
  });

  it('ends with the footnote and the link that opens the mapping guide in a new tab without an opener', () => {
    controlled({ phase: 'ready', data: profileOf(...rules) });
    expect(screen.getByText('Rules run after your access policy. A rule on a masked property never changes how an item looks.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Edit rules in neburyx.yaml' });
    expect(link.getAttribute('href')).toBe(STYLE_RULES_GUIDE);
    expect(STYLE_RULES_GUIDE.endsWith('/docs/mapping-guide.md#style-rules')).toBe(true);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('gives every row an accessible name that holds the label and the condition', () => {
    const { container } = controlled({ phase: 'ready', data: profileOf(...rules) });
    expect(rows(container)[0]?.getAttribute('aria-label')).toBe('Amber badge: review required, flag_x = value_y');
  });

  it('shows no section for a mapping with no rules, an empty list, or a profile from an older answer, and the rest of the legend is as before', () => {
    for (const data of [profileOf(), { ...profileOf(), styleRules: undefined }]) {
      const { container, unmount } = controlled({ phase: 'ready', data });
      expect(screen.queryByRole('heading', { name: /STYLE RULES/ })).toBeNull();
      expect(container.querySelector('.legend-rules')).toBeNull();
      expect(container.querySelectorAll('.legend-relationship')).toHaveLength(4);
      unmount();
    }
  });

  it('keeps the section from the last answer while the profile is read again and when a re-read fails, and has none before the first answer or after a first read that failed', () => {
    const { container, set, unmount } = controlled({ phase: 'ready', data: profileOf(...rules) });
    set({ phase: 'loading', data: profileOf(...rules) });
    expect(rows(container)).toHaveLength(4);
    set({ phase: 'ready', data: profileOf(...rules), failure: { code: 'SOURCE_UNAVAILABLE', message: 'unavailable', retryable: true, traceId: 't' } });
    expect(rows(container)).toHaveLength(4);
    set({ phase: 'ready', data: profileOf(rule('only', 'Only', { badge: 'gray' })) });
    expect(rows(container)).toHaveLength(1);
    unmount();
    const first = controlled({ phase: 'loading' });
    expect(first.container.querySelector('.legend-rules')).toBeNull();
    first.unmount();
    const failed = controlled({ phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(failed.container.querySelector('.legend-rules')).toBeNull();
  });

  it('names a type the profile does not list by its raw name', () => {
    const { container } = controlled({ phase: 'ready', data: profileOf(rule('x', 'Orphan', { badge: 'amber' }, { appliesTo: 'gone' })) });
    expect(text(rows(container)[0], '.legend-rule-detail')).toBe('status = review · gone');
  });
});

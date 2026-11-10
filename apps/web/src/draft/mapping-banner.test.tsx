import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BannerProvider } from '../banner/banner-context.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { StatusBanner } from '../banner/status-banner.js';
import { ClientStateProvider } from '../state/context.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { key, ref, result } from '../state/test-data.js';
import { MappingChangeBanner } from './mapping-banner.js';
import { mappingNoticesOf, type MappingNotice } from './mapping-notice.js';

afterEach(cleanup);

const ID = '0192f000-0000-7000-8000-0000000000a1';

function started(notice: MappingNotice | undefined, mask = false) {
  const state: ClientState = createClientState();
  state.bindSource('demo');
  state.setMask(mask);
  const read = result('demo', ['A']);
  state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  mappingNoticesOf(state).set(notice);
  const banner = createBuiltInBannerController();
  render(
    <ClientStateProvider state={state}>
      <BannerProvider controller={banner}>
        <StatusBanner />
        <MappingChangeBanner />
      </BannerProvider>
    </ClientStateProvider>,
  );
  return { banner, state };
}

const notice = (droppedFilters: MappingNotice['droppedFilters'], hasUnmapped = false, extra: Partial<MappingNotice> = {}): MappingNotice => ({ investigationId: ID, droppedFilters, hasUnmapped, canChange: true, ...extra });
const text = (): string => document.body.textContent ?? '';

describe('the mapping-changed banner', () => {
  it('names each dropped filter with its reason, and says unmapped items show as placeholders', () => {
    started(notice([{ kind: 'property', name: 'status', reason: 'not-filterable' }, { kind: 'property', name: 'quantity', reason: 'property-removed' }], true));
    expect(screen.getByText('The mapping changed since this view was saved.')).toBeDefined();
    expect(text()).toContain('Dropped filters: status (no longer a filterable property) and quantity (property removed).');
    expect(text()).toContain('Items that are no longer mapped show as “No longer mapped”.');
    expect(text()).not.toContain('newly sensitive');
  });

  it('names a type filter by its display name while the mapping has the type, and by the saved name when it does not', () => {
    started(notice([{ kind: 'entityType', name: 'type-gone', reason: 'type-removed' }]));
    expect(text()).toContain('Dropped filters: type-gone (type removed).');
  });

  it('says that fields are newly sensitive only for a now-personal filter and a masked session', () => {
    const personal = notice([{ kind: 'property', name: 'phone', reason: 'now-personal' }]);
    started(personal, true);
    expect(text()).toContain('Some fields are newly sensitive and are shown masked.');
    expect(text()).toContain('phone (now a sensitive field)');
    cleanup();
    started(personal, false);
    expect(text()).not.toContain('newly sensitive');
  });

  it('says nothing was changed when nothing was dropped and nothing is unmapped', () => {
    started(notice([]));
    expect(text()).toContain('Nothing in this view had to change.');
  });

  it('shows nothing when the notice is of another investigation, or when there is none', () => {
    started({ ...notice([]), investigationId: 'another' });
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
    cleanup();
    started(undefined);
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
  });

  it('can be dismissed, and a banner of a request replaces it and gives it back when that one is dismissed', () => {
    const { banner } = started(notice([]));
    act(() => banner.show({ id: 'request', tone: 'warning', chip: 'Busy', headline: 'A request banner.', text: 'x', actions: [] }));
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
    act(() => banner.dismiss('request'));
    expect(screen.getByText('The mapping changed since this view was saved.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
  });

  it('stays gone after it was dismissed, also when the mask is switched on', () => {
    const { state } = started(notice([{ kind: 'property', name: 'phone', reason: 'now-personal' }]));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
    act(() => state.setMask(true));
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
  });

  it('is not shown for an investigation that cannot be changed', () => {
    started(notice([], false, { canChange: false }));
    expect(screen.queryByText('The mapping changed since this view was saved.')).toBeNull();
  });

  it('tells the write it may go only once it has been on screen, and not while a banner of a request holds the place', () => {
    const calls: number[] = [];
    const notified = notice([], false, { onShown: () => calls.push(1) });
    const state: ClientState = createClientState();
    state.bindSource('demo');
    const read = result('demo', ['A']);
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
    const banner = createBuiltInBannerController();
    banner.show({ id: 'request', tone: 'warning', chip: 'Busy', headline: 'A request banner.', text: 'x', actions: [] });
    mappingNoticesOf(state).set(notified);
    render(
      <ClientStateProvider state={state}>
        <BannerProvider controller={banner}>
          <StatusBanner />
          <MappingChangeBanner />
        </BannerProvider>
      </ClientStateProvider>,
    );
    expect(calls).toEqual([]);
    act(() => banner.dismiss('request'));
    expect(calls).toEqual([1]);
  });
});

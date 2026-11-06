import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { openById } from '../investigations/open-flow.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from '../investigations/test-data.js';
import { me, renderApp, source } from '../test-utils.js';
import { testProfile } from './test-profile.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };

async function chooseSource(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Source source-a' }));
  return screen.findByRole('form', { name: 'Open an entity' });
}

describe('the open-entity page', () => {
  it('lists the entity types of the chosen source by their display names and opens the entity in Explore without a second read', async () => {
    const { client, calls } = knowing([A]);
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['KIND-A', 'KIND-B', 'KIND-C']);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.type(screen.getByLabelText('Case reference (optional)'), 'CASE-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByText('CASE-1')).toBeTruthy();
    expect(calls).toEqual({ openInvestigation: [1], getEntity: [], getInvestigation: [] });
  });

  it('submits once however often Open is pressed while the request is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: unknown[] = [];
    const { client } = knowing([A], {
      openInvestigation: async (body) => {
        sent.push(body);
        await gate;
        return { ok: true, value: openedOf(A.investigation, A.node) };
      },
    });
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    const open = screen.getByRole('button', { name: 'Open' });
    await user.click(open);
    await user.click(open);
    await user.keyboard('{Enter}');
    expect(sent).toHaveLength(1);
    expect(open.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
  });

  describe('an opening that is still in flight when the person has moved on', () => {
    const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

    async function slowStart() {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { client } = knowing([A, B], {
        openInvestigation: async () => {
          await gate;
          return { ok: true, value: openedOf(A.investigation, A.node) };
        },
      });
      const state = createClientState();
      const view = renderApp('/dev/open-entity', client, state);
      const user = userEvent.setup();
      await chooseSource(user);
      await user.type(screen.getByLabelText('Stable ID'), 'A-1');
      await user.click(screen.getByRole('button', { name: 'Open' }));
      const finish = () =>
        act(async () => {
          release();
          await gate;
        });
      return { state, view, user, finish };
    }

    it('shows nothing and goes nowhere when the person opened another investigation meanwhile', async () => {
      const { state, view, finish } = await slowStart();
      await act(async () => {
        await view.router.navigate(`/explore/${INVESTIGATION_B}`);
      });
      expect(await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 })).toBeTruthy();
      await finish();
      expect(state.investigation.getState().id).toBe(INVESTIGATION_B);
      expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_B}`);
      expect(state.holds(INVESTIGATION_A, false)).toBe(false);
    });

    it('shows nothing and goes nowhere when the person chose another source meanwhile', async () => {
      const { state, view, user, finish } = await slowStart();
      await user.click(screen.getByRole('button', { name: 'Source source-b' }));
      await finish();
      expect(state.investigation.getState().id).toBeNull();
      expect(view.router.state.location.pathname).toBe('/dev/open-entity');
    });
  });

  it('shows the failure, moves the focus to it and keeps the form as typed, when the API refuses', async () => {
    const { client } = knowing([]);
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-404');
    await user.type(screen.getByLabelText('Case reference (optional)'), 'CASE-9');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const failure = await screen.findByRole('group', { name: 'Opening failed' });
    expect(failure.textContent).toContain('NOT_FOUND');
    await waitFor(() => expect(document.activeElement).toBe(failure));
    expect(screen.getByLabelText('Stable ID')).toHaveProperty('value', 'A-404');
    expect(screen.getByLabelText('Case reference (optional)')).toHaveProperty('value', 'CASE-9');
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows SOURCE_MISMATCH from the API, keeps the form as typed and leaves the investigation on screen as it was', async () => {
    const { client } = knowing([A], { openInvestigation: async () => ({ ok: false, failure: { code: 'SOURCE_MISMATCH', message: 'The request mixes more than one source.', retryable: false, traceId: 'tr-9' } }) });
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, { principalId: 'principal-1', mask: false });
    const shown = state.investigation.getState();
    renderApp('/dev/open-entity', client, state);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'C-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const failure = await screen.findByRole('group', { name: 'Opening failed' });
    expect(failure.textContent).toContain('SOURCE_MISMATCH');
    expect(screen.getByLabelText('Stable ID')).toHaveProperty('value', 'C-1');
    expect(state.investigation.getState()).toBe(shown);
  });

  it('sends the reference of the entity under the source twice, and a case reference only when one is typed', async () => {
    const sent: unknown[] = [];
    const { client } = knowing([A], { openInvestigation: async (body) => (sent.push(body), { ok: true, value: openedOf(A.investigation, A.node) }) });
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toEqual([{ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, mask: false }]);
  });

  it('sends the case reference when one is typed', async () => {
    const sent: unknown[] = [];
    const { client } = knowing([A], { openInvestigation: async (body) => (sent.push(body), { ok: true, value: openedOf(A.investigation, A.node) }) });
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.type(screen.getByLabelText('Case reference (optional)'), 'CASE-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toEqual([{ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1', mask: false }]);
  });

  it('tells in Explore that an existing investigation was resumed', async () => {
    const { client } = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf(A.investigation, A.node, false) }) });
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('An existing investigation for this case reference was opened.')).toBeTruthy();
  });

  it('says that the source is not available as it was when the investigation that was resumed has a source that changed', async () => {
    const { client } = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf({ ...A.investigation, sourceState: 'repointed' }, undefined, false) }) });
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    await user.type(screen.getByLabelText('Stable ID'), 'A-1');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing is read from it.');
  });

  it('opens with Enter from the stable ID field, and reaches every control in reading order with the keyboard', async () => {
    const { client } = knowing([A]);
    renderApp('/dev/open-entity', client);
    const user = userEvent.setup();
    await chooseSource(user);
    const order = [screen.getByRole('combobox'), screen.getByLabelText('Stable ID'), screen.getByLabelText('Case reference (optional)'), screen.getByRole('button', { name: 'Open' })];
    order[0]?.focus();
    for (const control of order.slice(1)) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
    await user.click(screen.getByLabelText('Stable ID'));
    await user.keyboard('A-1{Enter}');
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
  });

  it('does not open until the principal is known', async () => {
    const { client } = knowing([A], { getMe: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    renderApp('/dev/open-entity', client);
    await chooseSource(userEvent.setup());
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(true);
  });

  it('says so when the sources cannot be read, when there is none, and when the source has no entity type', async () => {
    renderApp('/dev/open-entity', fakeClient({ getMe: async () => ({ ok: true, value: me() }) }));
    expect(await screen.findByText('NETWORK_UNAVAILABLE')).toBeTruthy();
  });

  it('says so when no source is configured', async () => {
    renderApp('/dev/open-entity', fakeClient({ getMe: async () => ({ ok: true, value: me() }), getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }) }));
    expect(await screen.findByText('No sources are configured.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Open an entity' })).toBeNull();
  });

  it('says so when the source has no entity type, with no form', async () => {
    renderApp(
      '/dev/open-entity',
      fakeClient({
        getMe: async () => ({ ok: true, value: me() }),
        getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }),
        getProfile: async () => ({ ok: true, value: { ...testProfile('source-a'), entityTypes: [] } }),
      }),
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Source source-a' }));
    expect(await screen.findByText('This source has no entity types.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Open an entity' })).toBeNull();
  });

  it('says so when the profile cannot be read', async () => {
    renderApp(
      '/dev/open-entity',
      fakeClient({
        getMe: async () => ({ ok: true, value: me() }),
        getSources: async () => ({ ok: true, value: { items: [source('source-a')], nextCursor: null } }),
      }),
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Source source-a' }));
    expect(await screen.findByText('NETWORK_UNAVAILABLE')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Open an entity' })).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InvestigationResponse } from '@neburyx/contracts';
import { createClientState } from '../state/client-state.js';
import { useClientState } from '../state/context.js';
import { ClientStateProvider } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { openById } from '../investigations/open-flow.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { createSlotRegistry, Slot, SlotsProvider } from '../workspace/slots.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const draft: InvestigationResponse['draft'] = { version: 1, notes: null, basedOnViewId: null, layout: { schemaVersion: 1, layout: 'force', nodes: [{ t: 'kind-a', id: 'A-1', pinned: false, hidden: false, groupId: null }], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'kind-a', id: 'A-1' }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } };

async function opened(status: 'open' | 'closed' | 'archived', version: number) {
  const base = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');
  const { client } = knowing([], {
    getInvestigation: async () => ({ ok: true, value: { investigation: { ...base, status, version }, draft , save: { state: 'unsaved' as const, savedAt: null } } }),
    getEntity: async (ref) => ({ ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) }),
  });
  const state = createClientState();
  await openById(client, state, INVESTIGATION_A, CONTEXT);
  return state;
}

describe('the client record of an investigation that is read', () => {
  it.each([
    ['open', false],
    ['closed', true],
    ['archived', true],
  ] as const)('holds the status, the read-only flag and the version of a %s investigation', async (status, readOnly) => {
    const state = await opened(status, 6);
    expect(state.investigation.getState().record).toMatchObject({ status, readOnly, version: 6 });
  });
});

// Stand-ins for the Save and Export buttons of later work: they exist only here, and read the flag the way the real ones will.
function StandInSave() {
  const readOnly = useStoreSelector(useClientState().investigation, (held) => held.record?.readOnly === true);
  return (
    <button type="button" disabled={readOnly}>
      Save
    </button>
  );
}

function StandInExport() {
  return <button type="button">Export</button>;
}

describe('the controls that read the read-only flag', () => {
  async function shown(status: 'open' | 'closed') {
    const state = await opened(status, 2);
    const slots = createSlotRegistry();
    slots.register('save', StandInSave);
    slots.register('export', StandInExport);
    render(
      <ClientStateProvider state={state}>
        <SlotsProvider registry={slots}>
          <Slot name="save" />
          <Slot name="export" />
        </SlotsProvider>
      </ClientStateProvider>,
    );
  }

  it('dims Save and leaves Export alone for a closed investigation', async () => {
    await shown('closed');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables both for an open investigation', async () => {
    await shown('open');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

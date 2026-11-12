import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { RecentRow } from '../home/recent-row.js';
import { investigationOf, INVESTIGATION_A, listItemOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge as stored, edgeRef, key, node, ref } from '../state/test-data.js';
import { idsOfSelection } from './copy-ids.js';
import { menuHeader } from './menu-header.js';

const TOKEN = 'p1.opaque-token';
const VALUE = '+1-212-555-0100';

function keyedProfile(): SourceProfile {
  const profile = testProfile('a', ['type-a', 'type-b']);
  return { ...profile, entityTypes: profile.entityTypes.map((entry) => (entry.type === 'type-a' ? { ...entry, keyed: true, stableIdProperty: 'phoneNumber', pii: ['phoneNumber'] } : entry)) };
}

const keyedNode = (unmaskedValue: string | null = VALUE): GraphNode => ({
  ...node('a', TOKEN),
  display: { title: unmaskedValue ?? '•••', type: 'type-a' },
  properties: unmaskedValue === null ? [] : [{ key: 'phoneNumber', value: unmaskedValue, dataClass: 'phone', masked: false }],
});
const plainNode = (): GraphNode => ({ ...node('a', 'N-1'), ref: ref('a', 'type-b', 'N-1'), display: { title: 'N-1', type: 'type-b' } });

function graphOf(nodes: readonly GraphNode[]) {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [...nodes], edges: [] });
  state.setLoaded([key('a')], nodes.map((item) => item.ref), []);
  return state.loadedGraph();
}

describe('the menu header of a keyed entity', () => {
  it('is the display title, never the reference, and the stable ID for any other entity', () => {
    const graph = graphOf([keyedNode(), plainNode()]);
    const profile = keyedProfile();
    expect(menuHeader({ kind: 'node', key: elementKey(ref('a', 'type-a', TOKEN)), x: 0, y: 0 }, graph, profile)?.title).toBe(VALUE);
    expect(menuHeader({ kind: 'node', key: elementKey(ref('a', 'type-b', 'N-1')), x: 0, y: 0 }, graph, profile)?.title).toBe('N-1');
  });

  it('shows the masked display title the server gave under a mask, and never the token', () => {
    const graph = graphOf([{ ...keyedNode(null), display: { title: '+1-•••-•••-0100', type: 'type-a' } }]);
    const header = menuHeader({ kind: 'node', key: elementKey(ref('a', 'type-a', TOKEN)), x: 0, y: 0 }, graph, keyedProfile());
    expect(header?.title).toBe('+1-•••-•••-0100');
    expect(JSON.stringify(header)).not.toContain(TOKEN);
  });
});

describe('the menu header of a relationship', () => {
  const named = (): GraphNode => ({ ...plainNode(), display: { title: 'Plain Name', type: 'type-b' } });
  const header = (nodes: readonly GraphNode[], from: GraphNode, to: GraphNode) => {
    const link = { ...stored('a', 'R-1', 'x', 'y'), ref: edgeRef('a', 'R-1', 'rel-a', 'type-a', 'type-b'), from: from.ref, to: to.ref };
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), { sourceId: 'a', nodes: [...nodes], edges: [link] });
    state.setLoaded([key('a')], nodes.map((item) => item.ref), [link.ref]);
    return menuHeader({ kind: 'relationship', key: edgeKey(link.ref), x: 0, y: 0 }, state.loadedGraph(), keyedProfile());
  };

  it('names each loaded end by its display title, the masked one under a mask, and never by its token or its stable ID', () => {
    const masked = { ...keyedNode(null), display: { title: '+1-•••-•••-0100', type: 'type-a' } };
    const result = header([masked, named()], masked, named());
    expect(result?.detail).toContain('+1-•••-•••-0100');
    expect(result?.detail).toContain('Plain Name');
    expect(result?.detail).not.toContain('N-1');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('names an end that is not loaded by its stable ID, and a keyed one by its type, never by its token', () => {
    const unloadedPlain = header([keyedNode()], keyedNode(), plainNode());
    expect(unloadedPlain?.detail).toContain('N-1');
    const unloadedKeyed = header([named()], keyedNode(), named());
    expect(unloadedKeyed?.detail).toContain('TYPE-A');
    expect(JSON.stringify(unloadedKeyed)).not.toContain(TOKEN);
  });
});

describe('Copy IDs of a keyed entity', () => {
  const selection = (item: GraphNode) => new Set([elementKey(item.ref)]);

  it('copies the value of the stable-ID property when the view is unmasked, and the reference when it is masked', () => {
    const graph = graphOf([keyedNode()]);
    expect(idsOfSelection(graph, selection(keyedNode()), keyedProfile(), false).ids).toEqual([VALUE]);
    expect(idsOfSelection(graph, selection(keyedNode()), keyedProfile(), true).ids).toEqual([TOKEN]);
  });

  it('copies the reference when the property is absent, and the ID of any other entity as before, masked or not', () => {
    const graph = graphOf([keyedNode(null), plainNode()]);
    expect(idsOfSelection(graph, selection(keyedNode(null)), keyedProfile(), false).ids).toEqual([TOKEN]);
    expect(idsOfSelection(graph, selection(plainNode()), keyedProfile(), false).ids).toEqual(['N-1']);
    expect(idsOfSelection(graph, selection(plainNode()), keyedProfile(), true).ids).toEqual(['N-1']);
  });

  it('copies the exact text of a numeric stable-ID value when unmasked, and the reference when masked', () => {
    const numeric: GraphNode = { ...keyedNode(), properties: [{ key: 'phoneNumber', value: 42, dataClass: 'number', masked: false }] };
    const graph = graphOf([numeric]);
    expect(idsOfSelection(graph, selection(numeric), keyedProfile(), false).ids).toEqual(['42']);
    expect(idsOfSelection(graph, selection(numeric), keyedProfile(), true).ids).toEqual([TOKEN]);
  });

  it('copies the stable ID when no profile is known', () => {
    expect(idsOfSelection(graphOf([keyedNode()]), selection(keyedNode())).ids).toEqual([TOKEN]);
  });
});

describe('the Recent row of an investigation that starts at a keyed entity', () => {
  const item = listItemOf({ ...investigationOf(INVESTIGATION_A, 'a', 'type-a', TOKEN), title: 'Phone +1-•••-•••-0100' });
  const draw = (profile: SourceProfile | undefined) =>
    render(
      <MemoryRouter>
        <ul>
          <RecentRow item={item} now={Date.now()} source={undefined} profile={profile} />
        </ul>
      </MemoryRouter>,
    );

  it('shows the investigation title and no reference', () => {
    draw(keyedProfile());
    expect(screen.getByRole('link', { name: 'Phone +1-•••-•••-0100' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('shows the stable ID of an entity that is not keyed, as before', () => {
    cleanup();
    draw({ ...keyedProfile(), entityTypes: keyedProfile().entityTypes.map((entry) => ({ ...entry, keyed: false })) });
    expect(document.body.textContent).toContain(TOKEN);
  });
});

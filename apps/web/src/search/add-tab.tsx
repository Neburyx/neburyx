import { useEffect, useMemo, useState, type RefObject } from 'react';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { useApiClient } from '../api/client-context.js';
import type { ApiClient } from '../api/client.js';
import { leaveFocus } from '../canvas/focus-commands.js';
import { FOCUS_LEFT } from '../state/presentation-state.js';
import { neighborhoodOf } from '../state/loaded-graph.js';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { useProfile } from '../canvas/profile-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { elementKey } from '../state/keys.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { AddResults } from './add-results.js';
import { addedNote, SEARCH_PANEL_COPY, shownByFiltersText, TOO_LONG } from './copy.js';
import { useAddEntity } from './use-add-entity.js';
import { useTypeahead } from './use-typeahead.js';
import { useMorePages } from './use-more-pages.js';
import type { GraphNode } from '@neburyx/contracts';

interface TabProps {
  readonly epoch: number;
  readonly box: RefObject<HTMLInputElement | null>;
  readonly id: string;
  readonly labelledBy: string;
  readonly hidden: boolean;
}

function TypeaheadBox({ client, sourceId, mask, box }: { readonly client: ApiClient; readonly sourceId: string; readonly mask: boolean; readonly box: RefObject<HTMLInputElement | null> }) {
  const state = useClientState();
  const canvas = useCanvasCommands();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const shell = useShellData();
  const [text, setText] = useState('');
  const typeahead = useTypeahead(client, sourceId, mask, text);
  // a page is kept only while the text typed, the source and the mask are those of the answer shown; the mask and the source remount this box
  const identityOf = (typed: string): string => JSON.stringify(['typeahead', sourceId, mask, typed]);
  const answered = typeahead.answered;
  const pages = useMorePages(client, answered === undefined ? undefined : { identity: identityOf(answered.text), sourceId, text: answered.text, mask, entityTypes: [], result: answered.result }, identityOf(text));
  const principalId = answeredData(shell.me)?.principal.id;
  const adding = useAddEntity(client, state, sourceId, principalId, mask);
  const alias = answeredData(shell.sources)?.items.find((item) => item.id === sourceId)?.alias ?? sourceId;
  const [found, setFound] = useState('');
  useEffect(() => setFound(''), [adding.added]);
  const [centerAfterShown, setCenterAfterShown] = useState<string | undefined>(undefined);
  const drawn = useVisibleGraph();
  useEffect(() => {
    if (centerAfterShown === undefined || !drawn.nodes.some((candidate) => elementKey(candidate.ref) === centerAfterShown)) return;
    canvas?.centerOn(centerAfterShown);
    setCenterAfterShown(undefined);
  }, [centerAfterShown, drawn, canvas]);
  const find = (node: GraphNode): void => {
    const key = elementKey(node.ref);
    const { neighborhoodFocus, hidden, typeFilter } = state.presentation.view.getState();
    const outside = neighborhoodFocus !== undefined && !neighborhoodOf(graph, neighborhoodFocus).has(key);
    const typeName = profile?.entityTypes.find((candidate) => candidate.type === node.ref.entityType)?.displayName ?? node.ref.entityType;
    const offByFilter = typeFilter.offEntityTypes.has(node.ref.entityType);
    const byHand = hidden.has(key);
    if (offByFilter) state.setEntityTypeOff(node.ref.entityType, false);
    state.presentation.select([key]);
    if (outside) leaveFocus(state);
    if (byHand) state.presentation.showHidden([key]);
    if (byHand || offByFilter) {
      const said = [...(byHand ? [`Shown again: ${node.display.title}`] : []), ...(offByFilter ? [shownByFiltersText(typeName)] : [])].join('; ');
      state.presentation.announceMove(`${outside ? `${FOCUS_LEFT} ` : ''}${said}`);
      setFound(said);
      setCenterAfterShown(key);
      return;
    }
    setFound('');
    if (outside) setCenterAfterShown(key);
    else canvas?.centerOn(key);
  };
  return (
    <>
      <input ref={box} type="search" className="search-panel-box" aria-label={SEARCH_PANEL_COPY.addBoxLabel} autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} />
      {typeahead.length === 'long' ? (
        <p role="status" className="search-panel-note">
          {TOO_LONG}
        </p>
      ) : null}
      <AddResults sourceAlias={alias} text={text} typeahead={typeahead} pages={pages} env={{ sourceId, profile, loaded: new Set(graph.nodes.map((node) => elementKey(node.ref))), adding, mask, onFind: find }} />
      <p role="status" className="search-panel-status">
        {found !== '' || adding.added === undefined ? found : `${addedNote(adding.added)}${adding.shownAgain === undefined ? '' : ` ${shownByFiltersText(profile?.entityTypes.find((candidate) => candidate.type === adding.shownAgain)?.displayName ?? adding.shownAgain)}`}`}
      </p>
    </>
  );
}

/** The content is keyed by the context epoch, so a change of investigation, source or mask drops what was typed and aborts what was started. */
export function AddFromSourceTab({ epoch, box, id, labelledBy, hidden }: TabProps) {
  const state = useClientState();
  const open = useApiClient();
  // the box searches the source, which is not read while it is re-pointed or removed
  const client = useMemo(() => withoutReadsWhileSourceChanged(open, state), [open, state]);
  const mask = useSessionMask();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  return (
    <div role="tabpanel" id={id} aria-labelledby={labelledBy} className="search-tabpanel" hidden={hidden}>
      {sourceId === null ? (
        <p className="search-panel-note">{SEARCH_PANEL_COPY.noInvestigation}</p>
      ) : (
        <TypeaheadBox key={epoch} client={client} sourceId={sourceId} mask={mask} box={box} />
      )}
    </div>
  );
}

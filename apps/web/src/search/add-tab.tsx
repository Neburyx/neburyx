import { useState, type RefObject } from 'react';
import { useApiClient } from '../api/client-context.js';
import type { ApiClient } from '../api/client.js';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { useProfile } from '../canvas/profile-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { elementKey } from '../state/keys.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { AddResults } from './add-results.js';
import { addedNote, SEARCH_PANEL_COPY, TOO_LONG } from './copy.js';
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
  const find = (node: GraphNode): void => {
    state.presentation.select([elementKey(node.ref)]);
    canvas?.centerOn(elementKey(node.ref));
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
        {adding.added === undefined ? '' : addedNote(adding.added)}
      </p>
    </>
  );
}

/** The content is keyed by the context epoch, so a change of investigation, source or mask drops what was typed and aborts what was started. */
export function AddFromSourceTab({ epoch, box, id, labelledBy, hidden }: TabProps) {
  const state = useClientState();
  const client = useApiClient();
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

import { useEffect, useId, useState } from 'react';
import type { ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { SUMMARY_COPY } from '../summary/copy.js';
import { pressOf, type CitationEntry } from '../summary/summary-model.js';
import { ASSISTANT_COPY } from './copy.js';
import type { SourcesControl } from './view-answer-card.js';
import { SourcesList } from './sources-list.js';
import { rowStateOf } from './row-state.js';
import { useRowSelection, useSourceSelection } from './source-selection-context.js';
import { useRefReads, type RefReads } from './stored-reads.js';

type Ref = Parameters<typeof useRefReads>[0][number];

const titleOf = (node: GraphNode | undefined, ref: ElementRef): string => (node === undefined || node.display.title === '' ? ref.stableId : node.display.title);

/** The entry of a cited element as the read just made gives it: the label and the shape of a relationship come from the elements read now, never from the thread; an element the read did not return has no label. */
function entryFromRead(entry: CitationEntry, ref: Ref, reads: RefReads): CitationEntry {
  if ('entityType' in ref) {
    const node = reads.nodes.get(elementKey(ref));
    return { ...entry, label: node === undefined ? undefined : titleOf(node, ref) };
  }
  const edge: GraphEdge | undefined = reads.edges.get(edgeKey(ref));
  if (edge === undefined) return { ...entry, label: undefined };
  const from = reads.nodes.get(elementKey(edge.from));
  const to = reads.nodes.get(elementKey(edge.to));
  const label = `${titleOf(from, edge.from)} → ${titleOf(to, edge.to)} · ${edge.type}`;
  if (from === undefined || to === undefined) return { ...entry, label };
  const end = (node: GraphNode) => ({ key: elementKey(node.ref), type: node.display.type, typeName: node.display.type, title: titleOf(node, node.ref) });
  return { ...entry, label, shape: { relationshipType: edge.type, from: end(from), to: end(to) } };
}

/**
 * The Sources control of a stored answer: a count of the elements the answer cites, which opens a list read by reference through the application's route under the session's current mask when it is opened. The labels are those of the current read, an element
 * the read did not return is listed as not available and cannot be selected, and a read that fails shows a failure with a way to try again and no partial list.
 */
export function StoredSources({ entries, refs, open, onOpenChange, focusRequest, onFocusHandled }: { readonly entries: readonly CitationEntry[]; readonly refs: readonly Ref[]; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly focusRequest: SourcesControl['focusRequest']; readonly onFocusHandled: () => void }) {
  const listId = useId();
  const listOwner = listId;
  const [note, setNote] = useState('');
  const reads = useRefReads(refs, open);
  // a list that is closed forgets what it read, so that each opening reads anew and nothing read at an earlier opening is listed
  useEffect(() => {
    if (!open) reads.reset();
  }, [open]);
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const page = useSourceSelection();
  const rowSelection = useRowSelection();
  if (entries.length === 0) return null;
  const drawn = drawnKeys(graph);
  const held = new Set([...investigation.nodeRefs.map(elementKey), ...investigation.edgeRefs.map(edgeKey)]);
  const available = (entry: CitationEntry): boolean => !reads.missing.has(entry.graphKey) && (reads.nodes.has(entry.graphKey) || reads.edges.has(entry.graphKey));
  const listed = entries.map((entry, index) => {
    const ref = refs[index];
    return ref === undefined ? entry : entryFromRead(entry, ref, reads);
  });
  const status = (entry: CitationEntry): string => (!available(entry) ? ASSISTANT_COPY.sourceUnavailable : drawn.has(entry.graphKey) || (page !== undefined && held.has(entry.graphKey)) ? SUMMARY_COPY.select : held.has(entry.graphKey) ? SUMMARY_COPY.outsideView : SUMMARY_COPY.gone);
  const press = (entry: CitationEntry): void => {
    if (!available(entry)) {
      setNote(ASSISTANT_COPY.sourceUnavailable);
      return;
    }
    if (page !== undefined) {
      if (held.has(entry.graphKey)) {
        setNote('');
        page.selection.select(entry.graphKey, listOwner);
      } else setNote(SUMMARY_COPY.gone);
      return;
    }
    const outcome = pressOf(entry, drawn, held, SUMMARY_COPY);
    if (outcome.kind === 'note') {
      setNote(outcome.text);
      return;
    }
    setNote('');
    state.presentation.select([entry.graphKey]);
  };
  const showList = open && !reads.loading && !reads.failed;
  return (
    <div className="assistant-sources">
      <button type="button" className="assistant-sources-toggle" aria-expanded={open} aria-controls={listId} onClick={() => onOpenChange(!open)}>
        <span aria-hidden="true" className="icon icon-layers" />
        <span>{`${ASSISTANT_COPY.sources} · ${entries.length}`}</span>
        <span aria-hidden="true" className="assistant-sources-caret">{open ? '▴' : '▾'}</span>
      </button>
      <div id={listId} className="assistant-sources-list" hidden={!open}>
        {open && reads.loading ? <p className="ask-note" role="status">{ASSISTANT_COPY.sourcesLoading}</p> : null}
        {open && reads.failed ? (
          <p className="ask-note" role="alert">
            {ASSISTANT_COPY.sourcesFailed}{' '}
            <button type="button" className="ask-continue" onClick={reads.retry}>
              {ASSISTANT_COPY.tryAgain}
            </button>
          </p>
        ) : null}
        {showList ? <SourcesList entries={listed} labelOf={(entry) => entry.label ?? ASSISTANT_COPY.sourceUnavailable} statusOf={status} isSelectable={(entry) => available(entry) && (drawn.has(entry.graphKey) || (page !== undefined && held.has(entry.graphKey)))} rowStateOf={page === undefined ? undefined : (entry) => (available(entry) && held.has(entry.graphKey) ? rowStateOf(entry.graphKey, listOwner, rowSelection, SUMMARY_COPY.select, () => page.openGraph(entry.graphKey)) : undefined)} onPress={press} focusRequest={focusRequest} onFocusHandled={onFocusHandled} /> : null}
      </div>
      <p className={note === '' ? 'summary-note visually-hidden' : 'summary-note'} role="status">{note}</p>
    </div>
  );
}

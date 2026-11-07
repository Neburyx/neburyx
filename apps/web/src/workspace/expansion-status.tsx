import { cursorWasRefused, type NodeExpansion } from '../api/expand-store.js';
import { useStoreSelector } from '../state/store.js';
import { useLoadedGraph } from '../state/context.js';
import { nodeRefOfKey } from '../state/keys.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { RETRY, expandingText } from './expand-copy.js';
import { useExpandStoreWhenProvided } from './expand-context.js';

/** What the expansions that were started outside the submenu are doing: the number running, each failure with Retry for its node, and what was said about an item that cannot be expanded. Draws nothing when there is none. */
export function ExpansionStatus() {
  const store = useExpandStoreWhenProvided();
  const graph = useLoadedGraph();
  const view = useStoreSelector(store?.view ?? EMPTY, (current) => current);
  const notes = useStoreSelector(store?.notes ?? NO_NOTE_STORE, (current) => current);
  if (store === undefined) return null;
  const entries = [...view.keys()].flatMap((key) => {
    const ref = nodeRefOfKey(key);
    return ref === undefined ? [] : [{ ref, expansion: store.of(ref) }];
  });
  const running = entries.filter((entry) => entry.expansion.status === 'loading').length;
  const failed = entries.filter((entry) => entry.expansion.status === 'failed' && entry.expansion.failure !== undefined);
  if (running === 0 && failed.length === 0 && notes.length === 0) return null;
  const titleOf = (entityType: string, stableId: string): string => graph.nodes.find((node) => node.ref.entityType === entityType && node.ref.stableId === stableId)?.display.title ?? stableId;
  return (
    <div className="expansion-status">
      {running === 0 ? null : (
        <p role="status" className="expansion-status-line">
          {expandingText(running)}
        </p>
      )}
      {notes.map((note) => (
        <p key={note} role="status" className="expansion-status-line">
          {note}
        </p>
      ))}
      {failed.map(({ ref, expansion }) =>
        expansion.failure === undefined ? null : (
          <div key={`${ref.entityType}/${ref.stableId}`} className="expansion-status-failure">
            <span className="expansion-status-line">{titleOf(ref.entityType, ref.stableId)}</span>
            <FailureNotice failure={expansion.failure} />
            {cursorWasRefused(expansion) || !canRetry(expansion.failure) ? null : (
              <button type="button" className="neighbor-types-link" onClick={() => void store.retry(ref)}>
                {RETRY}
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

const NO_EXPANSIONS: ReadonlyMap<string, NodeExpansion> = new Map();
const NO_NOTES: readonly string[] = [];
const EMPTY = { getState: () => NO_EXPANSIONS, subscribe: () => () => undefined } as const;
const NO_NOTE_STORE = { getState: () => NO_NOTES, subscribe: () => () => undefined } as const;

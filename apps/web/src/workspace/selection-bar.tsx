import { useRef, useState } from 'react';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { runSelectionCommand } from '../canvas/selection-commands.js';
import { copyText, CLIPBOARD_UNAVAILABLE } from './clipboard.js';
import { idsOfSelection } from './copy-ids.js';
import { formatNumber } from './scope-text.js';
import { useSelectionActions } from './selection-actions.js';

const MIN_ITEMS = 2;

type CopyStatus =
  | { readonly kind: 'copied'; readonly count: number; readonly withoutId: number }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'failed' };

const statusText = (status: CopyStatus): string => {
  switch (status.kind) {
    case 'copied':
      return `Copied ${formatNumber(status.count)} ${status.count === 1 ? 'ID' : 'IDs'}${status.withoutId === 0 ? '' : ` (${formatNumber(status.withoutId)} selected ${status.withoutId === 1 ? 'item has' : 'items have'} no ID)`}`;
    case 'nothing':
      return 'No IDs to copy';
    case 'failed':
      return CLIPBOARD_UNAVAILABLE;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

export function SelectionBar() {
  const state = useClientState();
  const graph = useLoadedGraph();
  const actions = useSelectionActions();
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  const requests = useRef(0);
  const [copy, setCopy] = useState<{ readonly selection: ReadonlySet<string>; readonly status: CopyStatus } | undefined>(undefined);
  const drawn = drawnKeys(graph);
  const selected = [...selection].filter((key) => drawn.has(key));
  if (selected.length < MIN_ITEMS) return null;
  const status = copy?.selection === selection ? copy.status : undefined;

  const copyIds = async (): Promise<void> => {
    const request = (requests.current += 1);
    const show = (status: CopyStatus): void => {
      if (request === requests.current) setCopy({ selection, status });
    };
    const { ids, withoutId } = idsOfSelection(graph, new Set(selected));
    if (ids.length === 0) {
      show({ kind: 'nothing' });
      return;
    }
    try {
      await copyText(ids.join('\n'));
      show({ kind: 'copied', count: ids.length, withoutId });
    } catch {
      show({ kind: 'failed' });
    }
  };

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions">
      <span className="selection-count">{formatNumber(selected.length)} selected</span>
      <span className="selection-separator" aria-hidden="true" />
      {actions.map((action) => (
        <button key={action.id} type="button" className="selection-action" onClick={() => action.run(selected)}>
          {action.icon}
          {action.label}
        </button>
      ))}
      <button type="button" className="selection-action" onClick={() => void copyIds()}>
        <span className="icon icon-copy" aria-hidden="true" />
        Copy IDs
      </button>
      <span className="selection-separator" aria-hidden="true" />
      <button type="button" className="selection-action selection-clear" aria-label="Clear selection" onClick={() => runSelectionCommand(state, 'clear-selection')}>
        <span className="icon icon-clear" aria-hidden="true" />
      </button>
      {status === undefined ? null : (
        <span className="selection-status" role={status.kind === 'failed' ? 'alert' : 'status'}>
          {statusText(status)}
        </span>
      )}
    </div>
  );
}

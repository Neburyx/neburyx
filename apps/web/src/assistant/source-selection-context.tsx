import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useStoreSelector } from '../state/store.js';
import { useOtherWindowRoles, useWindowChannel, useWindowScope } from '../windows/use-window-channel.js';
import { createSourceSelection, type RowSelection, type SourceSelection } from './source-selection.js';

interface PageSelection {
  readonly selection: SourceSelection;
  /** Opens the graph of the investigation with the element selected: the key travels in the navigation state, never in the address. */
  readonly openGraph: (key: string) => void;
}

const SelectionContext = createContext<PageSelection | undefined>(undefined);

/** On the Assistant page the rows of the sources select on a graph window; in the panel, which is in the graph window itself, there is none of this and a row selects on its own canvas. */
export function SourceSelectionProvider({ openGraph, children }: { readonly openGraph: (key: string) => void; readonly children: ReactNode }) {
  const channel = useWindowChannel(useWindowScope());
  const roles = useOtherWindowRoles();
  const graphOpen = roles.has('graph');
  const selection = useMemo(
    () =>
      createSourceSelection({
        graphOpen: () => channel !== undefined && channel.available && channel.others.getState().has('graph'),
        send: (key) => channel?.sendSelection([key]),
        onAnswer: (listener) => channel?.onSelectionResult(listener) ?? (() => undefined),
      }),
    [channel],
  );
  useEffect(() => () => selection.dispose(), [selection]);
  useEffect(() => {
    if (!graphOpen) selection.graphClosed();
  }, [graphOpen, selection]);
  const value = useMemo(() => ({ selection, openGraph }), [selection, openGraph]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The selection of the page's rows, or none in a window that has no page around it. */
export function useSourceSelection(): PageSelection | undefined {
  return useContext(SelectionContext);
}

/** What the page's one selected row holds: undefined when nothing is selected or there is no page. */
export function useRowSelection(): RowSelection | undefined {
  const page = useSourceSelection();
  return useStoreSelector(page?.selection.state ?? EMPTY, (current) => current);
}

const EMPTY = { getState: () => undefined, subscribe: () => () => undefined } as const;

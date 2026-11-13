import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SourceSummary, TemplateListResponse } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import { useRequest, type RequestState } from '../api/use-request.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { currentSource, sourceNameOf } from '../shell/current-source.js';
import { answeredData, useShellData } from '../shell/shell-data.js';

export interface SourceChoice {
  readonly sources: readonly SourceSummary[];
  readonly chosenId: string | undefined;
  readonly choose: (sourceId: string) => void;
}

/** What Home knows of the patterns of its current source: nothing to show, a source that is not configured, a source still to be chosen, or the list read for one source. */
export type HomePatterns =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'not-configured'; readonly sourceId: string }
  | { readonly kind: 'choose'; readonly choice: SourceChoice }
  | { readonly kind: 'list'; readonly sourceId: string; readonly sourceName: string; readonly list: RequestState<TemplateListResponse>; readonly reload: () => void; readonly choice: SourceChoice | undefined };

const HIDDEN: HomePatterns = { kind: 'hidden' };
const Context = createContext<HomePatterns>(HIDDEN);

export const useHomePatterns = (): HomePatterns => useContext(Context);

function Reader({ sourceId, sourceName, choice, children }: { readonly sourceId: string; readonly sourceName: string; readonly choice: SourceChoice | undefined; readonly children: ReactNode }) {
  const client = useApiClient();
  const load = useCallback((signal: AbortSignal) => client.listTemplates(sourceId, signal), [client, sourceId]);
  const { state, reload } = useRequest(load);
  const value = useMemo<HomePatterns>(() => ({ kind: 'list', sourceId, sourceName, list: state, reload, choice }), [sourceId, sourceName, state, reload, choice]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Reads the preset list of the one source Home's patterns belong to (the source of the held investigation, else the only source, else the one chosen) and shares it, so that one read serves every card. */
export function HomePatternsProvider({ children }: { readonly children: ReactNode }) {
  const items = answeredData(useShellData().sources)?.items;
  // a source that is bound with no investigation and nothing loaded (bare Explore, or just left) holds nothing, so it does not decide which source the card is for
  const boundId = useStoreSelector(useClientState().investigation, (held) => (held.id === null && held.nodeRefs.length === 0 && held.edgeRefs.length === 0 ? null : held.sourceId));
  const current = items === undefined ? undefined : currentSource(items, boundId);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const choice = useMemo<SourceChoice | undefined>(() => (items === undefined ? undefined : { sources: items, chosenId, choose: setChosenId }), [items, chosenId]);
  if (current === undefined || items === undefined || current.kind === 'none') return <Context.Provider value={HIDDEN}>{children}</Context.Provider>;
  switch (current.kind) {
    case 'bound':
    case 'only':
      return (
        <Reader key={current.source.id} sourceId={current.source.id} sourceName={current.source.alias} choice={undefined}>
          {children}
        </Reader>
      );
    case 'bound-unknown':
      return <Context.Provider value={{ kind: 'not-configured', sourceId: current.sourceId }}>{children}</Context.Provider>;
    case 'summary': {
      const chosen = chosenId === undefined ? undefined : items.find((item) => item.id === chosenId);
      if (chosen === undefined || choice === undefined) return <Context.Provider value={choice === undefined ? HIDDEN : { kind: 'choose', choice }}>{children}</Context.Provider>;
      return (
        <Reader key={chosen.id} sourceId={chosen.id} sourceName={sourceNameOf(items, chosen.id)} choice={choice}>
          {children}
        </Reader>
      );
    }
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}

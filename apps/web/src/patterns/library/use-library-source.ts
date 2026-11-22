import { useState } from 'react';
import type { SourceSummary } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';
import { currentSource } from '../../shell/current-source.js';
import { answeredData, retainedFailure, useShellData } from '../../shell/shell-data.js';
import { useClientState } from '../../state/context.js';
import { useStoreSelector } from '../../state/store.js';

export type LibrarySource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly retry: () => void }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly sourceId: string }
  | { readonly kind: 'choose'; readonly sources: readonly SourceSummary[]; readonly choose: (sourceId: string) => void }
  | { readonly kind: 'ready'; readonly source: SourceSummary };

/** The source the library is about: the one the link names, else the source bound to the investigation, else the only one, else the one the person chooses. */
export function useLibrarySource(named: string | null): LibrarySource {
  const { sources, reloadSources } = useShellData();
  const bound = useStoreSelector(useClientState().investigation, (held) => held.sourceId);
  const [chosen, choose] = useState<string | undefined>(undefined);
  const answer = answeredData(sources);
  if (answer === undefined) {
    const failure = retainedFailure(sources);
    return failure === undefined ? { kind: 'loading' } : { kind: 'failed', failure, retry: reloadSources };
  }
  const items = answer.items;
  if (named !== null) {
    const source = items.find((item) => item.id === named);
    return source === undefined ? { kind: 'unknown', sourceId: named } : { kind: 'ready', source };
  }
  const current = currentSource(items, bound);
  switch (current.kind) {
    case 'bound':
    case 'only':
      return { kind: 'ready', source: current.source };
    case 'bound-unknown':
      return { kind: 'unknown', sourceId: current.sourceId };
    case 'none':
      return { kind: 'none' };
    case 'summary': {
      const picked = items.find((item) => item.id === chosen);
      return picked === undefined ? { kind: 'choose', sources: items, choose } : { kind: 'ready', source: picked };
    }
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}

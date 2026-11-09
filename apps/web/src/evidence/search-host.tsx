import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoredEdgeRef } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import { registerViewEvidence } from '../search/evidence-action.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { createEdgeReadStore, EdgeReadProvider } from './edge-read.js';
import { EVIDENCE_PANEL_TITLE } from './copy.js';
import { EvidencePanelView } from './evidence-panel.js';
import { createEvidenceKindRegistry } from './evidence-kinds.js';
import { storedEvidenceKind } from './stored-evidence.js';

const KINDS = createEvidenceKindRegistry();
KINDS.register(storedEvidenceKind);

interface Opened {
  readonly ref: StoredEdgeRef;
  readonly choice: number;
  readonly opener: HTMLElement | null;
}

/**
 * The search page's host of the relationship evidence panel: it registers what **View evidence** does while the page is shown and draws the panel in a column beside the results, reading the edge by its reference.
 * Nothing is loaded into an investigation and none is made. It is keyed by the source and the masking of the page, so a change of either closes the panel and its own store of reads, which cancels a read in flight and drops what it held.
 */
export function SearchEvidenceHost({ mask, children }: { readonly mask: boolean; readonly children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  const client = useApiClient();
  const person = answeredData(useShellData().me)?.principal.id ?? '';
  const personNow = useRef(person);
  useEffect(() => {
    personNow.current = person;
  }, [person]);
  const [reads] = useState(() => createEdgeReadStore(client, () => personNow.current, () => ''));
  useEffect(() => () => reads.clear(), [reads]);
  useEffect(
    () =>
      registerViewEvidence((supports) => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpened((previous) => ({ ref: supports, choice: (previous?.choice ?? 0) + 1, opener }));
      }),
    [],
  );
  const close = (): void => {
    const back = opened?.opener ?? null;
    setOpened(undefined);
    if (back !== null && back.isConnected) back.focus();
  };
  return (
    <div className={opened === undefined ? undefined : 'search-with-evidence'}>
      <div className="search-results-column">{children}</div>
      {opened === undefined ? null : (
        <aside className="search-evidence" aria-label={EVIDENCE_PANEL_TITLE}>
          <EdgeReadProvider store={reads}>
            <EvidencePanelView edge={opened.ref} kinds={KINDS} mask={mask} selected={false} choice={opened.choice} onClose={close} />
          </EdgeReadProvider>
        </aside>
      )}
    </div>
  );
}

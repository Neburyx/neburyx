import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EdgeRef } from '@neburyx/contracts';
import { CLOSE_EVIDENCE, EVIDENCE_PANEL_TITLE, READ_ONLY, SELECTED_READ_ONLY, TAB_EVIDENCE, TAB_PROPERTIES, TAB_SOURCE } from './copy.js';
import { kindOf, useEvidenceKinds, type EvidenceKindRegistry } from './evidence-kinds.js';
import { SourceTab } from './source-tab.js';

const TABS = [
  { id: 'evidence', label: TAB_EVIDENCE },
  { id: 'properties', label: TAB_PROPERTIES },
  { id: 'source', label: TAB_SOURCE },
] as const;
type TabId = (typeof TABS)[number]['id'];

export const captionOf = (edge: EdgeRef): string => ('stableId' in edge ? edge.type : 'aggregate' in edge ? edge.aggregate.type : edge.derived.ruleId);
const sourceIdOf = (edge: EdgeRef): string => edge.sourceId;

export interface EvidencePanelViewProps {
  readonly edge: EdgeRef;
  readonly kinds: EvidenceKindRegistry;
  readonly mask: boolean;
  /** Whether the relationship shown is the one selected on the canvas, which the caption says. */
  readonly selected: boolean;
  readonly onClose: () => void;
  /** Opens the panel on another relationship, as the host does when a relationship is chosen. */
  readonly onOpen?: (ref: EdgeRef) => void;
  /** Changes each time the person chooses to open the panel; the panel then takes focus. Left as it is, it takes none. */
  readonly choice: number;
}

/** The relationship evidence panel as every host draws it: the heading, the ends, the sub-tabs and the content of the kind that builds this relationship's evidence. */
export function EvidencePanelView({ edge, kinds, mask, selected, onClose, onOpen, choice }: EvidencePanelViewProps) {
  const registered = useEvidenceKinds(kinds);
  const kind = kindOf(registered, edge);
  const [tab, setTab] = useState<TabId>('evidence');
  const handled = useRef(0);
  useEffect(() => {
    if (handled.current === choice) return;
    handled.current = choice;
    setTab('evidence');
    queueMicrotask(() => document.getElementById('evidence-tab-evidence')?.focus());
  }, [choice]);
  if (kind === undefined) return null;
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = TABS.findIndex((candidate) => candidate.id === tab);
    const next = TABS[(at + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    event.preventDefault();
    setTab(next.id);
    queueMicrotask(() => document.getElementById(`evidence-tab-${next.id}`)?.focus());
  };
  const props = { edge, mask, ...(onOpen === undefined ? {} : { open: onOpen }) };
  return (
    <div
      className="evidence-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="evidence-header">
        <p className="evidence-caption">{`${captionOf(edge)} →`}</p>
        <div className="evidence-heading">
          <h2 className="evidence-title">{EVIDENCE_PANEL_TITLE}</h2>
          <button type="button" className="legend-close" aria-label={CLOSE_EVIDENCE} onClick={onClose}>
            <span className="icon icon-clear" aria-hidden="true" />
          </button>
        </div>
        <kind.Endpoints {...props} />
        <p className="evidence-readonly">{selected ? SELECTED_READ_ONLY : READ_ONLY}</p>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label={EVIDENCE_PANEL_TITLE} onKeyDown={move}>
        {TABS.map((entry) => (
          <button key={entry.id} id={`evidence-tab-${entry.id}`} type="button" role="tab" className="inspector-tab" aria-selected={entry.id === tab} aria-controls="evidence-tabpanel" tabIndex={entry.id === tab ? 0 : -1} onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div id="evidence-tabpanel" role="tabpanel" aria-labelledby={`evidence-tab-${tab}`} className="evidence-body">
        {tab === 'evidence' ? <kind.Evidence {...props} /> : tab === 'properties' ? <kind.Properties {...props} /> : <SourceTab sourceId={sourceIdOf(edge)} />}
      </div>
    </div>
  );
}

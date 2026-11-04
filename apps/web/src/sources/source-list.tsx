import type { SourceSummary } from '@neburyx/contracts';
import { COPY } from './copy.js';
import { StatePill } from './state-pill.js';

interface SourceListProps {
  readonly items: readonly SourceSummary[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}

export function SourceList({ items, selectedId, onSelect }: SourceListProps) {
  return (
    <div className="source-list">
      <ul aria-label={COPY.listLabel}>
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => onSelect(item.id)}>
              <span className="source-identity">
                <span className="icon icon-sources" aria-hidden="true" />
                <span className="source-alias">{item.alias}</span>
              </span>
              <StatePill state={item.state} />
              {item.stateReason === null ? null : <span className="source-reason">{item.stateReason}</span>}
              <span className="source-meta">{COPY.readOnly}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="source-footnote">{COPY.footnote}</p>
    </div>
  );
}

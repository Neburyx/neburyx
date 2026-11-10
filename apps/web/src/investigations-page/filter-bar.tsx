import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SourceSummary } from '@neburyx/contracts';
import { ALL_SOURCES, ARCHIVED_HIDDEN, FILTERS_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUS_OPTIONS, TEXT_LABEL, TEXT_PLACEHOLDER, TEXT_TOO_SHORT } from './copy.js';
import type { ListFilters } from './use-investigation-list.js';

const TYPING_DELAY_MS = 300;
const MIN_TEXT_LENGTH = 2;

export interface FilterBarProps {
  readonly filters: ListFilters;
  readonly sources: readonly SourceSummary[];
  readonly onChange: (next: ListFilters) => void;
  /** Controls that belong beside the filters, such as another chip. */
  readonly chips?: ReactNode;
}

/** Status, Source and a text box for a fragment of the title or the referral. Text is applied after a pause in typing and on Enter; one character is not sent. */
export function FilterBar({ filters, sources, onChange, chips }: FilterBarProps) {
  const [typed, setTyped] = useState(filters.text ?? '');
  const statusId = useId();
  const sourceId = useId();
  const textId = useId();
  const problemId = useId();
  const latest = useRef(filters);
  latest.current = filters;
  const length = Array.from(typed.trim()).length;
  const tooShort = length > 0 && length < MIN_TEXT_LENGTH;

  // a change of the address (Back, Clear filters) shows in the box
  useEffect(() => setTyped(filters.text ?? ''), [filters.text]);

  useEffect(() => {
    const wanted = length >= MIN_TEXT_LENGTH ? typed.trim() : length === 0 ? undefined : latest.current.text;
    if (wanted === latest.current.text) return undefined;
    const timer = setTimeout(() => onChange({ ...latest.current, text: wanted }), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, length, onChange]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (length === 0) onChange({ ...filters, text: undefined });
      else if (length >= MIN_TEXT_LENGTH) onChange({ ...filters, text: typed.trim() });
    } else if (event.key === 'Escape' && typed !== '') {
      event.preventDefault();
      setTyped('');
      onChange({ ...filters, text: undefined });
    }
  };

  return (
    <div role="group" aria-label={FILTERS_LABEL} className="investigations-filters">
      <div className="investigations-filter">
        <label htmlFor={statusId}>{STATUS_LABEL}</label>
        <select id={statusId} value={filters.status} onChange={(event) => onChange({ ...filters, status: STATUS_OPTIONS.find((option) => option.value === event.target.value)?.value ?? 'open' })}>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="investigations-filter">
        <label htmlFor={sourceId}>{SOURCE_LABEL}</label>
        <select id={sourceId} value={filters.sourceId ?? ''} onChange={(event) => onChange({ ...filters, sourceId: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{ALL_SOURCES}</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.alias}
            </option>
          ))}
        </select>
      </div>
      <div className="investigations-filter investigations-filter-text">
        <label htmlFor={textId}>{TEXT_LABEL}</label>
        <input id={textId} type="search" value={typed} placeholder={TEXT_PLACEHOLDER} maxLength={200} autoComplete="off" aria-invalid={tooShort ? true : undefined} aria-describedby={tooShort ? problemId : undefined} onChange={(event) => setTyped(event.target.value)} onKeyDown={onKeyDown} />
        {tooShort ? (
          <p id={problemId} className="investigations-problem">
            {TEXT_TOO_SHORT}
          </p>
        ) : null}
      </div>
      {chips}
      {filters.status === 'open' ? <p className="investigations-filter-note">{ARCHIVED_HIDDEN}</p> : null}
    </div>
  );
}

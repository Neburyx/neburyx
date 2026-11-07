import type { DegreePreview, ElementRef, SourceProfile } from '@neburyx/contracts';
import { useEffect, useId, useState } from 'react';
import { FALLBACK_PAGE_SIZE, cursorWasRefused } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { degreeCountText } from './degree-text.js';
import {
  ALL_SOURCED_TYPES,
  CHOOSE_A_TYPE,
  COUNTS_ARE_OF_RELATIONSHIPS,
  DUPLICATE_IDS,
  INVERT_SELECTION,
  LOADING_NEIGHBORS,
  MOST_RECENT,
  NEIGHBOR_TYPES_LABEL,
  NO_COUNT_FOR_COMBINATION,
  NO_RELATIONSHIPS,
  PAGE_SIZE_LABEL,
  PANEL_FOOTNOTE,
  RANK_BY_LABEL,
  RANK_NOTE_MIXED,
  RANK_NOTE_NONE,
  RANK_NOTE_TIME,
  RELATIONSHIP_TYPE_LABEL,
  RETRY,
  SELECT_ALL,
  SEPARATE_READS,
  ceilingLoweredText,
  leftOutText,
  loadPerTypeLabel,
  pageSizeRange,
  summaryText,
} from './expand-copy.js';
import { neighborTypesOf, useExpandStore } from './expand-context.js';
import { allNeighborTypes, neighborCount, relationshipCounts, relationshipOptions, sameTypes, type DirectionCount } from './supernode-options.js';
import { usePreviewStore } from './preview-context.js';

export const PANEL_FIRST_CONTROL = 'data-panel-first';

const displayNameOf = (profile: SourceProfile | undefined, entityType: string): string => profile?.entityTypes.find((entry) => entry.type === entityType)?.displayName ?? entityType;
const directionsText = (counts: readonly DirectionCount[]): string => counts.map((entry) => `${entry.direction} ${degreeCountText(entry.count)}`).join('; ');

function neighborCountText(preview: DegreePreview | undefined, type: string, relationshipType: string | undefined): string | undefined {
  const found = neighborCount(preview, type, relationshipType);
  if (found.over === 'all') return found.count === undefined ? undefined : degreeCountText(found.count);
  return found.counts.length === 0 ? NO_COUNT_FOR_COMBINATION : directionsText(found.counts);
}

const parsedSize = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text) : Number.NaN);

/** What the panel asks and shows for one node: the relationship type, the neighbor types, how the pages are ranked and how many of each type to load, with the counts the preview gave and the failure of whatever is read. */
export function ExpandForm({ node, only }: { readonly node: ElementRef; /** The neighbor type to have ticked alone, when the panel was opened from its aggregate node. */ readonly only?: string | undefined }) {
  const previews = usePreviewStore();
  const expansions = useExpandStore();
  const profile = useProfileWhenProvided();
  const mask = useSessionMask();
  const request = previews.forNode(node, mask);
  const state = useStoreSelector(request, (current) => current);
  const expansion = useStoreSelector(expansions.view, () => expansions.of(node));
  const preview = state.phase === 'ready' ? state.data : undefined;
  const [relationshipType, setRelationshipType] = useState<string | undefined>(undefined);
  const [unticked, setUnticked] = useState<ReadonlySet<string> | undefined>(undefined);
  const [sizeText, setSizeText] = useState<string | undefined>(undefined);
  const fieldId = useId();
  const options = relationshipOptions(profile, node.entityType);
  const chosen = options.find((option) => option.type === relationshipType);
  const all = allNeighborTypes(preview, neighborTypesOf(profile, node.entityType));
  const listed = chosen === undefined ? all : all.filter((type) => chosen.neighborTypes.includes(type));
  // until a tick is changed the types are ticked by default, or only the type the panel was opened for
  const cleared: ReadonlySet<string> = unticked ?? new Set(only === undefined ? [] : all.filter((type) => type !== only));
  const ticked = listed.filter((type) => !cleared.has(type));
  const leftOut = chosen === undefined ? [] : all.filter((type) => !cleared.has(type) && !listed.includes(type));
  const ceiling = expansions.ceilingOf(node.sourceId);
  const shown = sizeText ?? String(expansion.chosenPageSize ?? expansion.pageSize ?? preview?.pageSize ?? FALLBACK_PAGE_SIZE);
  const size = parsedSize(shown);
  const sizeValid = Number.isInteger(size) && size >= 1 && size <= ceiling;
  const busy = expansion.status === 'loading';
  const budgetLowered = expansion.failure?.code === 'QUERY_BUDGET_EXCEEDED';
  const refused = cursorWasRefused(expansion);
  const dated = chosen?.observed ?? (options.length === 0 ? 'none' : options.every((option) => option.observed === 'all') ? 'all' : options.every((option) => option.observed === 'none') ? 'none' : 'some');
  const capped = preview?.warnings.find((warning) => warning.code === 'counts-capped');
  const anyLoaded = [...expansion.types.values()].some((progress) => progress.loaded > 0);
  const changedCeiling = expansion.chosenPageSize;

  useEffect(() => {
    if (budgetLowered && changedCeiling !== undefined) setSizeText(String(changedCeiling));
  }, [budgetLowered, changedCeiling]);

  const edit = (text: string): void => {
    setSizeText(text);
    const value = parsedSize(text);
    if (Number.isInteger(value) && value >= 1 && value <= ceiling) expansions.setPageSize(node, value);
  };
  const toggle = (type: string): void => setUnticked(cleared.has(type) ? new Set([...cleared].filter((other) => other !== type)) : new Set(cleared).add(type));
  const asked = relationshipType === undefined ? undefined : [relationshipType];
  const load = (): void => {
    if (!sizeValid || ticked.length === 0 || busy) return;
    expansions.setPageSize(node, size);
    const more = ticked.filter((type) => {
      const progress = expansion.types.get(type);
      return progress !== undefined && progress.hasMore && !progress.restartNeeded && progress.cursor !== undefined && sameTypes(expansions.relTypesOf(node, type), asked);
    });
    void expansions.load(node, { first: ticked.filter((type) => !more.includes(type)), more, relTypes: asked });
  };

  return (
    <div className="supernode-form">
      {state.phase === 'failed' ? (
        <div className="supernode-block">
          <FailureNotice failure={state.failure} />
          {canRetry(state.failure) ? (
            <button type="button" className="neighbor-types-link" onClick={request.reload}>
              {RETRY}
            </button>
          ) : null}
        </div>
      ) : state.phase !== 'ready' ? (
        <p className="neighbor-types-note" role="status">
          {LOADING_NEIGHBORS}
        </p>
      ) : null}

      <label className="supernode-field">
        <span className="supernode-label">{RELATIONSHIP_TYPE_LABEL}</span>
        <select
          {...{ [PANEL_FIRST_CONTROL]: '' }}
          value={relationshipType ?? ''}
          onChange={(event) => setRelationshipType(event.target.value === '' ? undefined : event.target.value)}
        >
          <option value="">{ALL_SOURCED_TYPES}</option>
          {options.map((option) => {
            const counts = relationshipCounts(preview, option.type);
            return (
              <option key={option.type} value={option.type}>
                {counts.length === 0 ? option.type : `${option.type} (${directionsText(counts)})`}
              </option>
            );
          })}
        </select>
      </label>

      <div className="supernode-field" role="group" aria-labelledby={`${fieldId}-types`}>
        <span className="supernode-label" id={`${fieldId}-types`}>
          {NEIGHBOR_TYPES_LABEL}
        </span>
        <p className="neighbor-types-note supernode-summary">{summaryText(ticked.map((type) => displayNameOf(profile, type)), ticked.length, listed.length)}</p>
        {state.phase === 'ready' && listed.length === 0 ? (
          <p className="neighbor-types-note">{NO_RELATIONSHIPS}</p>
        ) : (
          <ul className="neighbor-types-list" aria-label={NEIGHBOR_TYPES_LABEL}>
            {listed.map((type) => {
              const count = neighborCountText(preview, type, relationshipType);
              return (
                <li key={type} className="neighbor-types-item">
                  <button type="button" role="checkbox" aria-checked={!cleared.has(type)} className="neighbor-types-row" onClick={() => toggle(type)}>
                    <span className="neighbor-types-check" aria-hidden="true" />
                    <span className="menu-label">{displayNameOf(profile, type)}</span>
                    {count === undefined ? null : <span className="neighbor-types-count">{count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {listed.length === 0 ? null : (
          <div className="supernode-links">
            <button type="button" className="neighbor-types-link" onClick={() => setUnticked(new Set([...[...cleared].filter((type) => !listed.includes(type)), ...ticked]))}>
              {INVERT_SELECTION}
            </button>
            <button type="button" className="neighbor-types-link" onClick={() => setUnticked(new Set([...cleared].filter((type) => !listed.includes(type))))}>
              {SELECT_ALL}
            </button>
          </div>
        )}
      </div>

      <label className="supernode-field">
        <span className="supernode-label">{RANK_BY_LABEL}</span>
        <select value="observed" onChange={() => undefined}>
          <option value="observed">{MOST_RECENT}</option>
        </select>
        <span className="neighbor-types-note">{dated === 'all' ? RANK_NOTE_TIME : dated === 'some' ? RANK_NOTE_MIXED : RANK_NOTE_NONE}</span>
      </label>

      <div className="supernode-field">
        <label className="supernode-label" htmlFor={`${fieldId}-size`}>
          {PAGE_SIZE_LABEL}
        </label>
        <input id={`${fieldId}-size`} className="supernode-number" type="number" inputMode="numeric" min={1} max={ceiling} step={1} value={shown} aria-invalid={sizeValid ? undefined : true} aria-describedby={`${fieldId}-range`} onChange={(event) => edit(event.target.value)} />
        <p id={`${fieldId}-range`} className="neighbor-types-note" role={sizeValid ? undefined : 'alert'}>
          {sizeValid ? '' : pageSizeRange(ceiling)}
          {budgetLowered ? ` ${ceilingLoweredText(ceiling)}` : ''}
        </p>
      </div>

      {leftOut.length === 0 || relationshipType === undefined ? null : <p className="neighbor-types-note">{leftOutText(leftOut.map((type) => displayNameOf(profile, type)), relationshipType)}</p>}
      <button type="button" className="primary supernode-load" disabled={!sizeValid || ticked.length === 0} aria-disabled={busy ? true : undefined} onClick={load}>
        {loadPerTypeLabel(sizeValid ? size : (expansion.chosenPageSize ?? FALLBACK_PAGE_SIZE))}
      </button>
      {ticked.length === 0 ? <p className="neighbor-types-note">{CHOOSE_A_TYPE}</p> : null}

      {busy ? (
        <p className="neighbor-types-note" role="status">
          {LOADING_NEIGHBORS}
        </p>
      ) : null}
      {expansion.status === 'failed' && expansion.failure !== undefined ? (
        <div className="supernode-block">
          <FailureNotice failure={expansion.failure} />
          {refused || !canRetry(expansion.failure) ? null : (
            <button type="button" className="neighbor-types-link" onClick={() => void expansions.retry(node)}>
              {RETRY}
            </button>
          )}
        </div>
      ) : null}

      <div className="neighbor-types-notes">
        <p className="neighbor-types-note">{PANEL_FOOTNOTE}</p>
        <p className="neighbor-types-note">{COUNTS_ARE_OF_RELATIONSHIPS}</p>
        {capped === undefined ? null : <p className="neighbor-types-note">{capped.reason}.</p>}
        {anyLoaded ? <p className="neighbor-types-note">{SEPARATE_READS}</p> : null}
        {expansion.duplicates ? <p className="neighbor-types-note">{DUPLICATE_IDS}</p> : null}
        {expansion.warnings.map((warning) => (
          <p key={warning} className="neighbor-types-note">
            {warning}
          </p>
        ))}
      </div>
    </div>
  );
}

import type { DegreePreview, ElementRef, SourceProfile } from '@neburyx/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { FALLBACK_PAGE_SIZE, cursorWasRefused, refinementKey, type Refinement } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { filteredKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { degreeCountText } from './degree-text.js';
import {
  ALL_SOURCED_TYPES,
  CHOOSE_A_TYPE,
  COUNTS_ARE_OF_RELATIONSHIP_ENDS,
  DUPLICATE_IDS,
  INVERT_SELECTION,
  LOADING_NEIGHBORS,
  FILTERS_CLEARED_BY_MASK,
  FILTERS_NEED_VALUES,
  NOTHING_MATCHES,
  CLEAR_FILTERS,
  PERSONAL_DATA_NOT_OFFERED,
  matchingLine,
  NEIGHBOR_TYPES_LABEL,
  NO_COUNT_FOR_COMBINATION,
  NO_RELATIONSHIPS,
  PAGE_SIZE_LABEL,
  PANEL_FOOTNOTE,
  RANK_BY_LABEL,
  RANK_NOTE_MIXED,
  RANK_NOTE_NONE,
  RANK_NOTE_TIME,
  SHOW_THESE_TYPES,
  hiddenByFiltersNote,
  selectedInFiltersLabel,
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
import { neighborTypesOf, startUntickedTypes, useExpandStore } from './expand-context.js';
import { allNeighborTypes, neighborCount, relationshipCounts, relationshipOptions, sameTypes, type DirectionCount } from './supernode-options.js';
import { usePreviewStore } from './preview-context.js';
import { declaredProperties, readDrafts, type FilterDraft } from './expand-refine.js';
import { FilterField, RankField, type RankChoice } from './expand-refine-fields.js';

export const PANEL_FIRST_CONTROL = 'data-panel-first';

/** The value of the relationship type choice that stands for the types the filters leave on. */
const FILTERS_CHOICE = '\u0000filters';

const displayNameOf = (profile: SourceProfile | undefined, entityType: string): string => profile?.entityTypes.find((entry) => entry.type === entityType)?.displayName ?? entityType;
const directionsText = (counts: readonly DirectionCount[]): string => counts.map((entry) => `${entry.direction} ${degreeCountText(entry.count)}`).join('; ');

function neighborCountText(preview: DegreePreview | undefined, type: string, relationshipType: string | undefined): string | undefined {
  const found = neighborCount(preview, type, relationshipType);
  if (found.over === 'all') return found.count === undefined ? undefined : degreeCountText(found.count);
  return found.counts.length === 0 ? NO_COUNT_FOR_COMBINATION : directionsText(found.counts);
}

/** The total that the filtered count stands beside: the one count of the choice, or the counts of the directions when it has more than one. */
function totalForLine(preview: DegreePreview | undefined, type: string, relationshipType: string | undefined): string | undefined {
  const found = neighborCount(preview, type, relationshipType);
  if (found.over === 'all') return found.count === undefined ? undefined : degreeCountText(found.count);
  const [only] = found.counts;
  return found.counts.length === 1 && only !== undefined ? degreeCountText(only.count) : found.counts.length === 0 ? undefined : directionsText(found.counts);
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
  const client = useClientState();
  const typeFilter = useStoreSelector(client.presentation.view, (current) => current.typeFilter);
  const graph = useLoadedGraph();
  const options = relationshipOptions(profile, node.entityType);
  const onOptions = options.filter((option) => !typeFilter.offRelationshipTypes.has(option.type));
  // exactly one relationship type left on of several: it is chosen at the start; two or more left: the choice "Selected in Filters" is offered
  const filtersChoose = onOptions.length >= 2 && onOptions.length < options.length;
  const [relationshipType, setRelationshipType] = useState<string | undefined>(() => (onOptions.length === 1 && options.length > 1 ? onOptions[0]?.type : undefined));
  const [unticked, setUnticked] = useState<ReadonlySet<string> | undefined>(undefined);
  const [sizeText, setSizeText] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<readonly FilterDraft[]>([]);
  const [rankChoice, setRankChoice] = useState<RankChoice | undefined>(undefined);
  const [maskNote, setMaskNote] = useState(false);
  const draftIds = useRef(0);
  const fieldId = useId();
  const askedTypes: readonly string[] | undefined = relationshipType === FILTERS_CHOICE ? onOptions.map((option) => option.type) : relationshipType === undefined ? undefined : [relationshipType];
  const chosenOptions = askedTypes === undefined ? [] : options.filter((option) => askedTypes.includes(option.type));
  const chosen = chosenOptions.length === 1 ? chosenOptions[0] : undefined;
  const mapped = neighborTypesOf(profile, node.entityType);
  const all = allNeighborTypes(preview, mapped);
  const listed = askedTypes === undefined ? all : all.filter((type) => chosenOptions.some((option) => option.neighborTypes.includes(type)));
  // until a tick is changed the types are ticked as the filters have them (all of them when the filters leave this node nothing), or only the type the panel was opened for
  const startUnticked = startUntickedTypes(profile, typeFilter, node.entityType, all);
  const cleared: ReadonlySet<string> = unticked ?? new Set(only === undefined ? startUnticked : all.filter((type) => type !== only));
  const ticked = listed.filter((type) => !cleared.has(type));
  const leftOut = chosen === undefined ? [] : all.filter((type) => !cleared.has(type) && !listed.includes(type));
  const neighborName = ticked.length === 1 ? displayNameOf(profile, ticked[0] ?? '') : 'Neighbor';
  const declaredSortable = declaredProperties(profile, node.entityType, ticked, askedTypes, 'sortable', mask);
  const declaredFilterable = declaredProperties(profile, node.entityType, ticked, askedTypes, 'filterable', mask);
  const personalHidden = mask && declaredProperties(profile, node.entityType, ticked, askedTypes, 'filterable', false).neighbor.length + declaredProperties(profile, node.entityType, ticked, askedTypes, 'sortable', false).neighbor.length > declaredFilterable.neighbor.length + declaredSortable.neighbor.length;
  // a rank on a property the chosen types do not all declare is not asked for: the order falls back to the observed time
  const rank = rankChoice === undefined || !(rankChoice.on === 'neighbor' ? declaredSortable.neighbor : declaredSortable.relationship).includes(rankChoice.property) ? undefined : rankChoice;
  const read = readDrafts(drafts.filter((draft) => (draft.on === 'neighbor' ? declaredFilterable.neighbor : declaredFilterable.relationship).includes(draft.property)));
  const refinement: Refinement = { filters: read.filters, rank };
  const ceiling = expansions.ceilingOf(node.sourceId);
  const shown = sizeText ?? String(expansion.chosenPageSize ?? expansion.pageSize ?? preview?.pageSize ?? FALLBACK_PAGE_SIZE);
  const size = parsedSize(shown);
  const sizeValid = Number.isInteger(size) && size >= 1 && size <= ceiling;
  const busy = expansion.status === 'loading';
  const budgetLowered = expansion.failure?.code === 'QUERY_BUDGET_EXCEEDED';
  const refused = cursorWasRefused(expansion);
  const datedOptions = chosenOptions.length === 0 ? options : chosenOptions;
  const dated = chosen?.observed ?? (datedOptions.length === 0 ? 'none' : datedOptions.every((option) => option.observed === 'all') ? 'all' : datedOptions.every((option) => option.observed === 'none') ? 'none' : 'some');
  const capped = preview?.warnings.find((warning) => warning.code === 'counts-capped');
  const anyLoaded = [...expansion.types.values()].some((progress) => progress.loaded > 0);
  const changedCeiling = expansion.chosenPageSize;

  useEffect(() => {
    if (budgetLowered && changedCeiling !== undefined) setSizeText(String(changedCeiling));
  }, [budgetLowered, changedCeiling]);

  // when masking is turned on, what filters or ranks by personal data is taken off, and the person is told
  const maskSeen = useRef(mask);
  useEffect(() => {
    if (maskSeen.current === mask) return;
    maskSeen.current = mask;
    if (!mask) {
      setMaskNote(false);
      return;
    }
    const keepDraft = (draft: FilterDraft): boolean => (draft.on === 'neighbor' ? declaredFilterable.neighbor : declaredFilterable.relationship).includes(draft.property);
    const droppedFilters = drafts.some((draft) => !keepDraft(draft));
    const droppedRank = rankChoice !== undefined && !(rankChoice.on === 'neighbor' ? declaredSortable.neighbor : declaredSortable.relationship).includes(rankChoice.property);
    if (droppedFilters) setDrafts(drafts.filter(keepDraft));
    if (droppedRank) setRankChoice(undefined);
    setMaskNote(droppedFilters || droppedRank);
  }, [mask, drafts, rankChoice, declaredFilterable, declaredSortable]);

  const filteredNow = filteredKeys(graph, typeFilter);
  const handHidden = useStoreSelector(client.presentation.view, (current) => current.hidden);
  const hiddenEnds = graph.edges.flatMap((edge) => {
    const from = elementKey(edge.from);
    const to = elementKey(edge.to);
    const here = elementKey(node);
    return from === here ? [edge.to] : to === here ? [edge.from] : [];
  }).filter((end) => filteredNow.has(elementKey(end)) && !handHidden.has(elementKey(end)));
  const hiddenNeighbors = new Set(hiddenEnds.map(elementKey)).size;
  const showHiddenTypes = (): void => {
    for (const type of new Set(hiddenEnds.map((end) => end.entityType))) client.setEntityTypeOff(type, false);
  };
  const edit = (text: string): void => {
    setSizeText(text);
    const value = parsedSize(text);
    if (Number.isInteger(value) && value >= 1 && value <= ceiling) expansions.setPageSize(node, value);
  };
  const toggle = (type: string): void => setUnticked(cleared.has(type) ? new Set([...cleared].filter((other) => other !== type)) : new Set(cleared).add(type));
  const asked = askedTypes;
  const load = (): void => {
    if (!sizeValid || ticked.length === 0 || busy || read.problems.size > 0) return;
    expansions.setPageSize(node, size);
    const more = ticked.filter((type) => {
      const progress = expansion.types.get(type);
      return progress !== undefined && progress.hasMore && !progress.restartNeeded && progress.cursor !== undefined && sameTypes(expansions.relTypesOf(node, type), asked) && refinementKey(expansions.refinementOf(node, type)) === refinementKey(refinement);
    });
    void expansions.load(node, { first: ticked.filter((type) => !more.includes(type)), more, relTypes: asked, refinement });
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
          {filtersChoose ? <option value={FILTERS_CHOICE}>{selectedInFiltersLabel(onOptions.length)}</option> : null}
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
              const count = relationshipType === FILTERS_CHOICE ? undefined : neighborCountText(preview, type, relationshipType);
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

      <RankField declared={declaredSortable} neighborName={neighborName} rank={rank} onChange={setRankChoice} observedNote={dated === 'all' ? RANK_NOTE_TIME : dated === 'some' ? RANK_NOTE_MIXED : RANK_NOTE_NONE} />
      <FilterField declared={declaredFilterable} neighborName={neighborName} drafts={drafts} problems={read.problems} next={() => ++draftIds.current} onChange={setDrafts} />
      {personalHidden ? <p className="neighbor-types-note">{PERSONAL_DATA_NOT_OFFERED}</p> : null}
      {maskNote ? (
        <p className="neighbor-types-note" role="status">
          {FILTERS_CLEARED_BY_MASK}
        </p>
      ) : null}

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

      {leftOut.length === 0 || relationshipType === undefined || relationshipType === FILTERS_CHOICE ? null : <p className="neighbor-types-note">{leftOutText(leftOut.map((type) => displayNameOf(profile, type)), relationshipType)}</p>}
      <button type="button" className="primary supernode-load" disabled={!sizeValid || ticked.length === 0 || read.problems.size > 0} aria-disabled={busy ? true : undefined} onClick={load}>
        {loadPerTypeLabel(sizeValid ? size : (expansion.chosenPageSize ?? FALLBACK_PAGE_SIZE))}
      </button>
      {ticked.length === 0 ? <p className="neighbor-types-note">{CHOOSE_A_TYPE}</p> : null}
      {read.problems.size > 0 ? <p className="neighbor-types-note">{FILTERS_NEED_VALUES}</p> : null}
      {ticked.flatMap((type) => {
        const progress = expansion.types.get(type);
        const chainRefinement = expansions.refinementOf(node, type);
        // what a chain counted is shown while the panel still asks what the chain was started with
        if (progress === undefined || (chainRefinement?.filters.length ?? 0) === 0 || progress.matching === undefined || refinementKey(chainRefinement) !== refinementKey(refinement)) return [];
        const total = relationshipType === FILTERS_CHOICE ? undefined : totalForLine(preview, type, relationshipType);
        return [
          <p key={`matching-${type}`} className="neighbor-types-note" role="status">
            {matchingLine(displayNameOf(profile, type), degreeCountText(progress.matching), total)}
          </p>,
        ];
      })}
      {ticked.some((type) => {
        const progress = expansion.types.get(type);
        return progress !== undefined && !progress.hasMore && progress.inChain === 0 && (expansions.refinementOf(node, type)?.filters.length ?? 0) > 0 && refinementKey(expansions.refinementOf(node, type)) === refinementKey(refinement) && !busy;
      }) ? (
        <p className="neighbor-types-note" role="status">
          {NOTHING_MATCHES}{' '}
          <button type="button" className="neighbor-types-link" onClick={() => setDrafts([])}>
            {CLEAR_FILTERS}
          </button>
        </p>
      ) : null}

      {hiddenNeighbors === 0 ? null : (
        <p className="neighbor-types-note">
          {hiddenByFiltersNote(hiddenNeighbors)}{' '}
          <button type="button" className="neighbor-types-link" onClick={showHiddenTypes}>
            {SHOW_THESE_TYPES}
          </button>
        </p>
      )}
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
        <p className="neighbor-types-note">{COUNTS_ARE_OF_RELATIONSHIP_ENDS}</p>
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

import type { GraphNode, GroupFailure, SearchResult, SourceProfile } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import { elementKey } from '../state/keys.js';
import { ADD_COPY, captionOf, exactIdText, groupFailureText, groupNotRead, NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, RETRY, SEARCH_COPY, showingResultsFor, startsWithText } from './copy.js';
import { secondsText } from './count-label.js';
import { summaryOf } from './hit-summary.js';
import { EntityFailure, SearchFailure } from './add-failure.js';
import type { AddEntity } from './use-add-entity.js';
import type { Typeahead } from './use-typeahead.js';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

interface RowProps {
  readonly node: GraphNode;
  readonly type: EntityTypeProfile | undefined;
  readonly onCanvas: boolean;
  readonly adding: boolean;
  readonly failure: ApiFailure | undefined;
  readonly onAdd: (node: GraphNode) => void;
  readonly onFind: (node: GraphNode) => void;
}

function HitRow({ node, type, onCanvas, adding, failure, onAdd, onFind }: RowProps) {
  const summary = [type?.displayName ?? node.display.type, ...summaryOf(node, type)].join(' · ');
  return (
    <li className="search-panel-hit" data-on-canvas={onCanvas}>
      <div className="search-panel-hit-line">
        <div className="search-panel-hit-text">
          <span className="search-panel-row-title">{node.display.title}</span>
          <span className="search-panel-row-type">{summary}</span>
        </div>
        {onCanvas ? (
          <button type="button" className="search-panel-pill" aria-label={`${ADD_COPY.onCanvas}: ${node.display.title}`} onClick={() => onFind(node)}>
            {ADD_COPY.onCanvas}
          </button>
        ) : (
          <button type="button" className="search-panel-add" aria-label={`${ADD_COPY.add} ${node.display.title}`} aria-disabled={adding} onClick={() => onAdd(node)}>
            <span className="icon icon-plus" aria-hidden="true" />
            {adding ? ADD_COPY.adding : ADD_COPY.add}
          </button>
        )}
      </div>
      {failure === undefined ? null : <EntityFailure failure={failure} />}
    </li>
  );
}

export interface Environment {
  readonly sourceId: string;
  readonly profile: SourceProfile | undefined;
  readonly loaded: ReadonlySet<string>;
  readonly adding: AddEntity;
  readonly mask: boolean;
  readonly onFind: (node: GraphNode) => void;
}

function Group({ label, nodes, env }: { readonly label: string; readonly nodes: readonly GraphNode[]; readonly env: Environment }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="search-panel-rows" aria-label={label}>
      {nodes.map((node) => {
        const key = elementKey(node.ref);
        return <HitRow key={key} node={node} type={env.profile?.entityTypes.find((candidate) => candidate.type === node.ref.entityType)} onCanvas={env.loaded.has(key)} adding={env.adding.loading.has(key)} failure={env.adding.failures.get(key)} onAdd={env.adding.add} onFind={env.onFind} />;
      })}
    </ul>
  );
}

function GroupFailureLine({ failure, onRetry }: { readonly failure: GroupFailure; readonly onRetry: (() => void) | undefined }) {
  return (
    <div className="search-failure" role="alert">
      <p>{groupFailureText(failure.group, failure.code, failure.timeoutMs)}</p>
      {onRetry === undefined ? null : (
        <button type="button" onClick={onRetry}>
          {RETRY}
        </button>
      )}
    </div>
  );
}

/** `onRetry` is absent for an answer that is not the one for the text typed now: a newer search is already on its way. */
function Answer({ result, env, onRetry }: { readonly result: SearchResult; readonly env: Environment; readonly onRetry: (() => void) | undefined }) {
  const startsWith = result.startsWith;
  const typeOf = (entityType: string) => env.profile?.entityTypes.find((candidate) => candidate.type === entityType)?.displayName ?? entityType;
  const failureOf = (group: GroupFailure['group']) => result.failures.find((failure) => failure.group === group);
  const exactFailure = failureOf('exact');
  const prefixFailure = failureOf('startsWith');
  const counts = [exactFailure === undefined ? exactIdText(result.counts.exact) : groupNotRead('exact'), startsWith === undefined ? undefined : prefixFailure === undefined ? startsWithText(startsWith.count) : groupNotRead('startsWith')].filter((text): text is string => text !== undefined);
  const warnings = [...result.warnings.map((text) => ({ group: 'exact', text })), ...(startsWith?.warnings ?? []).map((text) => ({ group: 'startsWith', text }))];
  const found = result.exact.length + (startsWith?.nodes.length ?? 0);
  const allDisabled = !result.searchable && result.disabledTypes.length > 0;
  return (
    <>
      {result.searchable ? <p className="search-panel-summary">{counts.join(' · ')} · <span className="search-panel-summary-time">{secondsText(result.elapsedMs)}</span></p> : null}
      {result.disabledTypes.length === 0 ? null : (
        <ul className="search-panel-notes">
          {result.disabledTypes.map((disabled) => (
            <li key={disabled.entityType}>
              {typeOf(disabled.entityType)}: {SEARCH_COPY.disabledType}.
            </li>
          ))}
          {allDisabled ? <li>{ADD_COPY.noIndexAvailable}</li> : null}
        </ul>
      )}
      {warnings.length === 0 ? null : (
        <ul className="search-panel-notes">
          {warnings.map((warning, index) => (
            <li key={`${warning.group}:${index}`}>{warning.text}</li>
          ))}
        </ul>
      )}
      {!result.searchable && result.disabledTypes.length === 0 ? <p className="search-panel-note">{env.mask ? NOTHING_SEARCHABLE_MASKED : NO_SEARCH_PROPERTIES}</p> : null}
      {result.searchable && found === 0 && result.failures.length === 0 ? <p className="search-panel-note">{SEARCH_COPY.emptyTitle}</p> : null}
      {exactFailure === undefined ? <Group label={ADD_COPY.exactGroup} nodes={result.exact} env={env} /> : <GroupFailureLine failure={exactFailure} onRetry={onRetry} />}
      {prefixFailure === undefined ? <Group label={ADD_COPY.startsWithGroup} nodes={startsWith?.nodes ?? []} env={env} /> : <GroupFailureLine failure={prefixFailure} onRetry={onRetry} />}
    </>
  );
}

export interface AddResultsProps {
  readonly sourceAlias: string;
  readonly text: string;
  readonly typeahead: Typeahead;
  readonly env: Environment;
}

export function AddResults({ sourceAlias, text, typeahead, env }: AddResultsProps) {
  const { answered, failure, waiting } = typeahead;
  return (
    <>
      <p className="search-panel-note">{captionOf(sourceAlias)}</p>
      {waiting ? <p role="status" className="search-panel-note">{ADD_COPY.searching}</p> : null}
      {failure === undefined ? null : <SearchFailure failure={failure} sourceId={env.sourceId} onRetry={typeahead.retry} />}
      {answered === undefined ? null : (
        <>
          {answered.text === text ? null : <p className="search-panel-note">{showingResultsFor(answered.text)}</p>}
          <Answer result={answered.result} env={env} onRetry={answered.text === text ? typeahead.retry : undefined} />
        </>
      )}
      <p className="search-panel-note">{ADD_COPY.footnote}</p>
    </>
  );
}

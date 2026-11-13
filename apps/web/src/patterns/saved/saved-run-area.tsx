import { useEffect, useMemo, useRef } from 'react';
import type { ListedPattern, SourceProfile, TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { heavyDecisionOfRun } from '../../api/heavy-estimate.js';
import { continueWith } from '../../banner/copy.js';
import { heavyHeadline, heavyLine } from '../../banner/heavy-banner.js';
import { useStoreSelector } from '../../state/store.js';
import { elementKey } from '../../state/keys.js';
import { RUN_COPY, runFailureView } from '../run/run-copy.js';
import { OutOfDate } from '../run/state-views.js';
import { useAddResult } from '../run/use-add-result.js';
import { useStartEntity } from '../run/use-start-entity.js';
import { PATTERNS_COPY, timeoutLabel } from '../copy.js';
import { PatternResult } from '../pattern-result.js';
import { RunFailure } from '../run-failure.js';
import { StartEntityField } from '../start-entity.js';
import { SAVED_COPY } from './saved-copy.js';
import { definitionStartType } from './saved-model.js';
import type { SavedAsk, SavedHeavy, SavedRunStore, SavedRunView } from './saved-run-store.js';

/** The type of entity a saved pattern starts from: its definition's start type, or the type its built-in pattern is bound to. */
export function startTypeOf(item: ListedPattern, presets: TemplateListResponse['presets'] | undefined): string | undefined {
  return item.kind === 'definition' ? definitionStartType(item.definition) : presets?.find((preset) => preset.id === item.presetId)?.bind.anchor;
}

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly store: SavedRunStore;
  /** The saved run of a built-in pattern. */
  readonly target: ListedPattern;
  readonly presets: TemplateListResponse['presets'] | undefined;
  readonly profile: SourceProfile | undefined;
  readonly timeoutMs: number | undefined;
  readonly onBack: () => void;
  /** The list is out of date: the pattern cannot run now, or is gone. */
  readonly onStale: () => void;
  /** A result moved the last run of the pattern. */
  readonly onRan: (id: string) => void;
}

const heavyParts = (heavy: SavedHeavy): { readonly headline: string; readonly line: string; readonly limit: number } | undefined => {
  if (heavy.kind === 'pattern') {
    const answer = heavy.answer;
    return { headline: heavyHeadline({ value: answer.estimate.value ?? answer.threshold, quality: 'lowerBound' }, answer.threshold), line: heavyLine(answer.continueLimit), limit: answer.continueLimit };
  }
  const decision = heavyDecisionOfRun(heavy.answer);
  return decision.kind === 'heavy' ? { headline: heavyHeadline(decision.estimate, decision.threshold), line: heavyLine(decision.pageSize), limit: decision.pageSize } : undefined;
};

/**
 * The saved run of a built-in pattern, in the run view of the panel: it answers as the built-in form does, with the starting entity when the pattern asks for it, Run, running, cancelled, a failure, the heavy stop, the earlier result and
 * Add to graph. A saved pattern built in the app runs through the screens of `RunFlow` instead.
 */
export function SavedPresetRun({ client, sourceId, sourceName, mask, store, target, presets, profile, timeoutMs, onBack, onStale, onRan }: Props) {
  const view: SavedRunView = useStoreSelector(store, (current) => current);
  const startType = startTypeOf(target, presets);
  const start = useStartEntity(startType);
  const asks = target.askForStartingEntity;
  const anchor = start.anchor === undefined ? undefined : { entityType: start.anchor.ref.entityType, stableId: start.anchor.ref.stableId };

  const shown = view.result !== undefined && view.result.ask.id === target.id ? view.result.answer : undefined;
  const addable = useMemo(() => (shown === undefined ? undefined : { nodes: shown.answer.nodes, edges: shown.answer.edges }), [shown]);
  const { add, added } = useAddResult(sourceId, addable, view.running, 'saved');
  const failure = view.failure === undefined ? undefined : runFailureView(view.failure, sourceName);
  const heavy = view.heavy === undefined ? undefined : heavyParts(view.heavy);
  const unavailable = view.unavailable !== undefined && view.unavailable.id === target.id ? view.unavailable.answer : undefined;
  const reasons = unavailable?.reasons ?? (target.availability.status === 'unavailable' ? target.availability.reasons : undefined);
  const press = (ask: SavedAsk): void => store.run(ask);
  const nameOf = (type: string | undefined): string => (type === undefined ? '' : (profile?.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type));
  const stale = useRef(onStale);
  stale.current = onStale;
  const ran = useRef(onRan);
  ran.current = onRan;
  useEffect(() => {
    if (view.unavailable !== undefined || view.failure?.code === 'NOT_FOUND') stale.current();
  }, [view.unavailable, view.failure]);
  useEffect(() => {
    if (view.result !== undefined) ran.current(view.result.ask.id);
  }, [view.result]);

  return (
    <section className="pattern-saved-run" aria-label={`${SAVED_COPY.run}: ${target.name}`}>
      <div className="patterns-actions">
        <button type="button" className="secondary" onClick={onBack}>
          {PATTERNS_COPY.backToList}
        </button>
      </div>
      {reasons !== undefined ? <OutOfDate reasons={reasons} offer={undefined} onChange={onBack} onCopyAndChange={onBack} /> : null}
      {asks && startType !== undefined && reasons === undefined ? (
        <>
          <StartEntityField
            client={client}
            sourceId={sourceId}
            mask={mask}
            label={nameOf(startType)}
            entityType={startType}
            candidates={start.candidates}
            chosenKey={start.anchor === undefined ? undefined : elementKey(start.anchor.ref)}
            onChoose={start.choose}
            selectRef={null}
            id="pattern-saved-start"
          />
          <div className="patterns-actions">
            <button type="button" className="primary" disabled={anchor === undefined || view.running} onClick={() => anchor !== undefined && press({ id: target.id, kind: target.kind, anchor })}>
              {RUN_COPY.run}
            </button>
          </div>
          {anchor === undefined ? <p className="search-panel-note">{SAVED_COPY.runFirst}</p> : null}
        </>
      ) : null}
      {view.running ? (
        <div className="patterns-state" role="status">
          <p>{`Running${timeoutMs === undefined ? '' : ` · ${timeoutLabel(timeoutMs)}`}`}</p>
          <button type="button" className="secondary" onClick={store.cancel}>
            {PATTERNS_COPY.cancel}
          </button>
        </div>
      ) : null}
      {view.cancelled ? (
        <div className="patterns-state" role="status">
          <p>{PATTERNS_COPY.cancelled}</p>
          {view.ask === undefined ? null : (
            <button type="button" className="secondary" onClick={() => view.ask !== undefined && press(view.ask)}>
              {PATTERNS_COPY.runAgain}
            </button>
          )}
        </div>
      ) : null}
      {failure === undefined || view.failure === undefined ? null : <RunFailure key={view.failure.code} failure={failure} canRetry={view.ask !== undefined && failure.action !== undefined} onRetry={() => view.ask !== undefined && press(view.ask)} />}
      {heavy === undefined || view.ask === undefined ? null : (
        <div className="patterns-state" data-tone="warning" role="alert">
          <p>{heavy.headline}</p>
          <p>{heavy.line}</p>
          <div className="patterns-actions">
            <button type="button" className="secondary" onClick={store.clear}>
              {PATTERNS_COPY.refine}
            </button>
            <button type="button" className="primary" onClick={() => view.ask !== undefined && press({ ...view.ask, continue: { limit: heavy.limit } })}>
              {continueWith(heavy.limit)}
            </button>
          </div>
        </div>
      )}
      {shown !== undefined && (view.failure !== undefined || view.cancelled || view.heavy !== undefined || unavailable !== undefined) ? (
        <p className="search-panel-note" role="status">
          {PATTERNS_COPY.earlierResult}
        </p>
      ) : null}
      {shown === undefined || shown.kind !== 'template' ? null : (
        <PatternResult
          result={shown.answer}
          matchHeading={nameOf(shown.answer.matchIds[0]?.entityType) || PATTERNS_COPY.matchHeading}
          sharedHeading={shown.answer.links !== undefined ? PATTERNS_COPY.reachedHeading : PATTERNS_COPY.matchHeading}
          {...(add === undefined ? {} : { add })}
          {...(added === undefined ? {} : { added })}
        />
      )}
    </section>
  );
}

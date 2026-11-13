import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphNode, TemplateListResponse } from '@neburyx/contracts';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { useApiClient } from '../api/client-context.js';
import { heavyDecisionOfRun } from '../api/heavy-estimate.js';
import { useRequest } from '../api/use-request.js';
import { useProfile } from '../canvas/profile-context.js';
import { useContextEpoch } from '../search/use-context-epoch.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { canRetry } from '../failure-notice.js';
import { continueWith, rateLimitedRetry } from '../banner/copy.js';
import { heavyHeadline, heavyLine } from '../banner/heavy-banner.js';
import { failureView, maxHopsOf, maxPageOf, PATTERNS_COPY, selectTypeHint, timeoutLabel } from './copy.js';
import { buildParams, fieldsOf, labelOf, type FormValues } from './form-model.js';
import { PatternForm } from './pattern-form.js';
import { RunFailure } from './run-failure.js';
import { PatternResult } from './pattern-result.js';
import { focusPatternsTool } from './patterns-tool.js';
import { StartEntityField } from './start-entity.js';
import type { RunAsk } from './pattern-run-store.js';
import { usePatternRun } from './use-pattern-run.js';

type Preset = TemplateListResponse['presets'][number];

export function PatternsPanel() {
  const state = useClientState();
  const epoch = useContextEpoch(state);
  return <PatternsBody key={epoch} />;
}

function PatternsBody() {
  const state = useClientState();
  const open = useApiClient();
  const client = useMemo(() => withoutReadsWhileSourceChanged(open, state), [open, state]);
  const mask = useSessionMask();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const shell = useShellData();
  const sourceName = (sourceId === null ? undefined : answeredData(shell.sources)?.items.find((item) => item.id === sourceId)?.alias) ?? sourceId ?? '';
  const root = useRef<HTMLDivElement>(null);
  const close = (): void => {
    state.presentation.setPatternsOpen(false);
    focusPatternsTool();
  };
  const cancelOrClose = useRef<() => void>(close);
  useEffect(() => {
    const frame = root.current?.closest('.panel-frame');
    if (frame === null || frame === undefined) return undefined;
    const onKey = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelOrClose.current();
    };
    frame.addEventListener('keydown', onKey);
    return () => frame.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="patterns-panel" ref={root}>
      <div className="search-panel-header">
        <h2 className="search-panel-heading">{PATTERNS_COPY.title}</h2>
        <button type="button" className="legend-close" aria-label={PATTERNS_COPY.close} onClick={close}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      <p className="search-panel-note">{PATTERNS_COPY.intro}</p>
      {sourceId === null ? <p className="search-panel-note">{PATTERNS_COPY.noPatterns}</p> : <PatternsList client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} close={close} escape={cancelOrClose} />}
    </div>
  );
}

interface ListProps {
  readonly client: ReturnType<typeof withoutReadsWhileSourceChanged>;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly close: () => void;
  readonly escape: React.MutableRefObject<() => void>;
}

function PatternsList({ client, sourceId, sourceName, mask, close, escape }: ListProps) {
  const load = useCallback((signal: AbortSignal) => client.listTemplates(sourceId, signal), [client, sourceId]);
  const list = useRequest(load);
  const held = list.state.phase === 'ready' || list.state.phase === 'loading' ? list.state.data : undefined;
  if (held === undefined && list.state.phase !== 'failed') {
    escape.current = close;
    return (
      <p className="search-panel-note" role="status">
        {PATTERNS_COPY.loading}
      </p>
    );
  }
  if (held === undefined && list.state.phase === 'failed') {
    escape.current = close;
    const failure = failureView(list.state.failure, sourceName);
    return (
      <div className="patterns-state" role="alert">
        <p>{failure.text}</p>
        <p>{failure.detail}</p>
        {canRetry(list.state.failure) ? (
          <button type="button" className="secondary" onClick={list.reload}>
            {PATTERNS_COPY.retry}
          </button>
        ) : null}
      </div>
    );
  }
  const first = held?.presets[0];
  if (held === undefined || first === undefined) {
    escape.current = close;
    return <p className="search-panel-note">{PATTERNS_COPY.noPatterns}</p>;
  }
  return <PatternsWorkbench client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} list={held} first={first} close={close} escape={escape} />;
}

interface WorkbenchProps {
  readonly client: ListProps['client'];
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly list: TemplateListResponse;
  /** The first preset of the list, which the panel falls back to. */
  readonly first: Preset;
  readonly close: () => void;
  readonly escape: ListProps['escape'];
}

function PatternsWorkbench({ client, sourceId, sourceName, mask, list, first, close, escape }: WorkbenchProps) {
  const state = useClientState();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const shell = useShellData();
  const selection = useStoreSelector(state.presentation.view, (view) => view.selection);
  const run = usePatternRun(client, sourceId, mask);
  const [selectedId, setSelectedId] = useState(first.id);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [chosen, setChosen] = useState<GraphNode | undefined>(undefined);
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const startField = useRef<HTMLSelectElement>(null);
  const preset: Preset = list.presets.find((candidate) => candidate.id === selectedId) ?? first;
  const template = list.templates.find((candidate) => candidate.id === preset.template);
  const sources = answeredData(shell.sources)?.items ?? [];
  const source = sources.find((item) => item.id === sourceId);
  const typeName = (type: string | undefined): string => (type === undefined ? '' : (profile?.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type));

  const fields = useMemo(
    () =>
      template === undefined
        ? []
        : fieldsOf(preset, template.paramsSchema, {
            entityTypes: (profile?.entityTypes ?? []).map((type) => ({ value: type.type, text: type.displayName })),
            relationshipTypes: (profile?.relationshipTypes ?? []).map((type) => ({ value: type.type, text: type.type })),
          }),
    [preset, template, profile],
  );

  const anchorType = preset.bind.anchor;
  const candidates = useMemo(() => {
    const ofType = graph.nodes.filter((node) => node.ref.entityType === anchorType);
    const chosenKeys = selection;
    return [...ofType.filter((node) => chosenKeys.has(elementKey(node.ref))), ...ofType.filter((node) => !chosenKeys.has(elementKey(node.ref)))];
  }, [graph, anchorType, selection]);
  const selected = candidates.filter((node) => selection.has(elementKey(node.ref)));
  // the person's choice, else the one selected entity of the type, else the entity the investigation was opened on when it is of the type and loaded
  const startingEntity = useStoreSelector(state.investigation, (investigation) => investigation.record?.startingEntity);
  const opened = startingEntity === null || startingEntity === undefined ? undefined : candidates.find((node) => node.ref.entityType === startingEntity.entityType && node.ref.stableId === startingEntity.stableId);
  const anchor: GraphNode | undefined = chosen !== undefined && chosen.ref.entityType === anchorType ? chosen : selected.length === 1 ? selected[0] : opened;
  const hasEntity = anchor !== undefined;

  useEffect(() => {
    cards.current[list.presets.findIndex((candidate) => candidate.id === preset.id)]?.focus();
  }, []);

  const change = (key: string, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      const { [key]: _gone, ...rest } = previous;
      return rest;
    });
    run.clear();
  };

  const submit = (ask?: RunAsk): void => {
    if (ask !== undefined) return run.run(ask);
    if (anchor === undefined) return;
    const built = buildParams(fields, values, { entityType: anchor.ref.entityType, stableId: anchor.ref.stableId });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    run.run({ id: preset.id, params: built.params });
  };

  useEffect(() => {
    const failure = run.failure;
    if (failure === undefined || failure.code !== 'QUERY_BUDGET_EXCEEDED') return;
    const page = maxPageOf(failure);
    const hops = maxHopsOf(failure);
    setValues((previous) => ({ ...previous, ...(page === undefined ? {} : { limit: String(page) }), ...(hops === undefined ? {} : { maxHops: String(hops) }) }));
  }, [run.failure]);

  escape.current = run.running ? run.cancel : close;

  const choosePreset = (id: string): void => {
    if (id === selectedId) return;
    setSelectedId(id);
    setValues({});
    setErrors({});
    run.clear();
  };
  const onCardKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + list.presets.length) % list.presets.length;
    const target = list.presets[next];
    if (target === undefined) return;
    choosePreset(target.id);
    requestAnimationFrame(() => cards.current[next]?.focus());
  };

  const heavy = run.heavy === undefined ? undefined : heavyDecisionOfRun(run.heavy);
  const timeout = source?.timeoutMs;
  const failure = run.failure === undefined ? undefined : failureView(run.failure, sourceName);
  const budgetCap = run.failure === undefined || run.failure.code !== 'QUERY_BUDGET_EXCEEDED' ? undefined : (maxPageOf(run.failure) ?? maxHopsOf(run.failure));
  // a result is shown only under the pattern that produced it
  const result = run.result !== undefined && run.result.presetId === preset.id ? run.result : undefined;
  const firstMatch = result?.matchIds[0];

  return (
    <>
      <div role="radiogroup" aria-label={PATTERNS_COPY.list} className="patterns-cards">
        {list.presets.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="radio"
            aria-checked={candidate.id === preset.id}
            tabIndex={candidate.id === preset.id ? 0 : -1}
            className="pattern-card"
            ref={(element) => {
              cards.current[index] = element;
            }}
            onClick={() => choosePreset(candidate.id)}
            onKeyDown={(event) => onCardKey(event, index)}
          >
            {candidate.name}
          </button>
        ))}
      </div>
      <StartEntityField
        client={client}
        sourceId={sourceId}
        mask={mask}
        label={labelOf(preset, 'anchor')}
        entityType={anchorType ?? ''}
        candidates={candidates}
        chosenKey={anchor === undefined ? undefined : elementKey(anchor.ref)}
        onChoose={(node) => {
          setChosen(node);
          run.clear();
        }}
        selectRef={startField}
      />
      <PatternForm fields={fields} values={values} errors={errors} onChange={change} />
      <div className="patterns-actions">
        {run.running ? (
          <button type="button" className="secondary" onClick={run.cancel}>
            {PATTERNS_COPY.cancel}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!hasEntity} onClick={() => submit()}>
            {PATTERNS_COPY.run}
          </button>
        )}
        {timeout === undefined ? null : <span className="search-panel-note">{timeoutLabel(timeout)}</span>}
      </div>
      {hasEntity ? null : <p className="search-panel-note">{selectTypeHint(typeName(anchorType))}</p>}
      {run.running ? (
        <p className="patterns-state" role="status">
          {`Running${timeout === undefined ? '' : ` · ${timeoutLabel(timeout)}`}`}
        </p>
      ) : null}
      {run.cancelled ? (
        <div className="patterns-state" role="status">
          <p>{PATTERNS_COPY.cancelled}</p>
          {run.ask === undefined ? null : (
            <button type="button" className="secondary" onClick={() => submit(run.ask)}>
              {PATTERNS_COPY.runAgain}
            </button>
          )}
        </div>
      ) : null}
      {failure === undefined || run.failure === undefined ? null : <RunFailure key={run.failure.code} failure={failure} budgetCap={budgetCap} canRetry={run.ask !== undefined && canRetry(run.failure)} onRetry={() => submit(run.ask)} />}
      {heavy === undefined || heavy.kind !== 'heavy' || run.ask === undefined ? null : (
        <div className="patterns-state" data-tone="warning" role="alert">
          <p>{heavyHeadline(heavy.estimate, heavy.threshold)}</p>
          <p>{heavyLine(heavy.pageSize)}</p>
          <div className="patterns-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                run.clear();
                startField.current?.focus();
              }}
            >
              {PATTERNS_COPY.refine}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const ask = run.ask;
                if (ask === undefined) return;
                const asked = typeof ask.params['limit'] === 'number' ? ask.params['limit'] : heavy.pageSize;
                submit({ id: ask.id, params: { ...ask.params, limit: Math.min(asked, heavy.pageSize) }, continue: true });
              }}
            >
              {continueWith(heavy.pageSize)}
            </button>
          </div>
        </div>
      )}
      {result === undefined ? null : (
        <PatternResult
          result={result}
          matchHeading={firstMatch === undefined ? PATTERNS_COPY.matchHeading : typeName(firstMatch.entityType)}
          sharedHeading={result.links !== undefined ? PATTERNS_COPY.reachedHeading : `Shared ${typeName(preset.bind.attribute).toLowerCase() || 'attribute'}`}
        />
      )}
    </>
  );
}

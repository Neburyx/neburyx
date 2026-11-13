import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphNode, ListedPattern, PatternDefinition, TemplateListResponse, TemplateRunOk } from '@neburyx/contracts';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { useApiClient } from '../api/client-context.js';
import { heavyDecisionOfRun } from '../api/heavy-estimate.js';
import { useRequest } from '../api/use-request.js';
import { useProfile, useProfileReload, useProfileState } from '../canvas/profile-context.js';
import { useContextEpoch } from '../search/use-context-epoch.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { useEvidenceHandle } from './evidence-handle.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { addResultToGraph, type AddedOutcome } from './add-to-graph.js';
import { useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import { useStoreSelector } from '../state/store.js';
import { canRetry } from '../failure-notice.js';
import type { ApiFailure } from '../api/client.js';
import { continueWith, rateLimitedRetry } from '../banner/copy.js';
import { heavyHeadline, heavyLine } from '../banner/heavy-banner.js';
import { RUN_COPY } from './run/run-copy.js';
import { EDITOR_SUBTITLE, failureView, listSubtitle, maxHopsOf, maxPageOf, PATTERNS_COPY, SHELL_COPY, startHint, timeoutLabel } from './copy.js';
import { buildParams, fieldsOf, labelOf, type FormValues } from './form-model.js';
import { PatternForm } from './pattern-form.js';
import { RunFailure } from './run-failure.js';
import { PatternResult } from './pattern-result.js';
import { focusPatternsTool } from './patterns-tool.js';
import { StartEntityField } from './start-entity.js';
import type { RunAsk } from './pattern-run-store.js';
import { usePatternRun } from './use-pattern-run.js';
import { useRowActions, RowDialogs, type Notice } from './saved/use-row-actions.js';
import { useSavedPatterns } from './saved/use-saved-patterns.js';
import { PatternsHome } from './saved/patterns-home.js';
import { fromDefinition } from './builder/from-definition.js';
import type { SaveMode } from './saved/save-dialog.js';
import { INITIAL, reduce, type Action, type BuilderState } from './builder/model.js';
import { PatternEditor, type EditingView, type ProfileView } from './builder/pattern-editor.js';
import { RunFlow, type RunHeader } from './run/run-flow.js';
import { SAVED_COPY, UNAVAILABLE_TEXT } from './saved/saved-copy.js';

type Reason = Extract<ListedPattern['availability'], { status: 'unavailable' }>['reasons'][number];

const stepOfReason = (reason: Reason): number | undefined => (reason.path?.[0] === 'steps' && typeof reason.path[1] === 'number' ? reason.path[1] : undefined);

/** What the editor says of a saved pattern it was opened from, in the words of the saved list. */
function editingViewOf(item: ListedPattern, whole: boolean): EditingView {
  const reasons = item.availability.status === 'unavailable' ? item.availability.reasons : [];
  const stepNotes = new Map<number, string[]>();
  for (const reason of reasons) {
    const index = stepOfReason(reason);
    if (index !== undefined) stepNotes.set(index, [...(stepNotes.get(index) ?? []), UNAVAILABLE_TEXT[reason.code]]);
  }
  return {
    title: `${SAVED_COPY.changeTitle}: ${item.name}`,
    notes: whole ? [SAVED_COPY.changeLine] : [SAVED_COPY.changeLine, SAVED_COPY.changeUnplaced],
    loose: reasons.filter((reason) => stepOfReason(reason) === undefined).map((reason) => UNAVAILABLE_TEXT[reason.code]),
    stepNotes,
  };
}

type Preset = TemplateListResponse['presets'][number];

export function PatternsPanel() {
  const state = useClientState();
  const epoch = useContextEpoch(state);
  const mask = useSessionMask();
  const hasDraft = useRef(false);
  const previous = useRef({ mask, epoch });
  const [restarted, setRestarted] = useState(false);
  useEffect(() => {
    // the body is remounted by the same change that tells the wrapper the masking changed, so what the body held is read here, before it is forgotten
    const maskChanged = previous.current.mask !== mask;
    if (maskChanged && hasDraft.current) setRestarted(true);
    if (!maskChanged && previous.current.epoch !== epoch) setRestarted(false);
    if (previous.current.epoch !== epoch) hasDraft.current = false;
    previous.current = { mask, epoch };
  }, [mask, epoch]);
  return <PatternsBody key={epoch} hasDraft={hasDraft} restarted={restarted} onRestartedSeen={() => setRestarted(false)} />;
}

interface BodyProps {
  /** Whether the builder holds a draft, kept outside the body so that a restart of the panel can tell what was lost. */
  readonly hasDraft: React.RefObject<boolean>;
  readonly restarted: boolean;
  readonly onRestartedSeen: () => void;
}

function PatternsBody({ hasDraft, restarted, onRestartedSeen }: BodyProps) {
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
  // the builder is a second view of the panel; the list stays mounted, hidden, so its form is as it was on the way back
  const [view, setView] = useState<'list' | 'builder' | 'preset' | 'run'>('list');
  // the draft the editor handed to the preview, and what the screen of the run says under the heading
  const [previewing, setPreviewing] = useState<PatternDefinition | undefined>(undefined);
  const [runHeader, setRunHeader] = useState<RunHeader | undefined>(undefined);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  // the run of a built-in pattern is kept while the panel is open, so that going back to the list and to the form again shows the result under its own pattern
  const presetRun = usePatternRun(client, sourceId ?? '', mask);
  const loadTemplates = useCallback((signal: AbortSignal) => sourceId === null ? Promise.resolve({ ok: true as const, value: { sourceId: '', templates: [], presets: [] } }) : client.listTemplates(sourceId, signal), [client, sourceId]);
  const templates = useRequest(loadTemplates);
  const templateData = templates.state.phase === 'ready' || templates.state.phase === 'loading' ? templates.state.data : undefined;
  useEffect(() => {
    // the pattern Home handed over opens its form once the list holds it; one the list does not hold is dropped
    const handed = state.presentation.view.getState().patternsPreset;
    if (handed === undefined || templateData === undefined) return;
    state.presentation.setPatternsPreset(undefined);
    if (templateData.presets.some((candidate) => candidate.id === handed)) {
      setPresetId(handed);
      setView('preset');
    }
  }, [state, templateData]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const saved = useSavedPatterns(client, sourceId);
  const rows = useRowActions(client, saved.reload, setNotice);
  const [builder, setBuilder] = useState<BuilderState>(INITIAL);
  const [editing, setEditing] = useState<{ readonly item: ListedPattern; readonly whole: boolean } | undefined>(undefined);
  const drafted = builder.draft.anchorType !== undefined;
  const mounted = useRef(false);
  useEffect(() => {
    // not on mount: a restarted panel starts empty, and the wrapper reads what the one before it held
    if (mounted.current) hasDraft.current = drafted;
    mounted.current = true;
  }, [drafted, hasDraft]);
  const profile = useProfile();
  const profileState = useProfileState();
  const profileView: ProfileView = profile !== undefined ? { kind: 'ready', profile } : profileState.sourceId === sourceId && profileState.request.phase === 'failed' ? { kind: 'failed', failure: profileState.request.failure } : { kind: 'loading' };
  const reloadProfile = useProfileReload();
  const maxHops = (sourceId === null ? undefined : answeredData(shell.sources)?.items.find((item) => item.id === sourceId)?.maxHops);
  const dispatch = (action: Action): void => {
    if (profile !== undefined) setBuilder((held) => reduce(profile, held, action));
  };
  const newButton = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLSelectElement>(null);
  const opened = useRef(false);
  // Cancel in the editor throws the draft away (the editor has asked first when there was one)
  const cancel = (): void => {
    setBuilder(INITIAL);
    setEditing(undefined);
    setPreviewing(undefined);
    setView('list');
  };
  const editingView = useMemo(() => (editing === undefined ? undefined : editingViewOf(editing.item, editing.whole)), [editing]);
  const change = (item: ListedPattern): void => {
    const opened = fromDefinition(item.kind === 'definition' ? item.definition : undefined);
    setBuilder({ draft: opened.draft });
    setEditing({ item, whole: opened.whole });
    setNotice(undefined);
    setView('builder');
  };
  const afterSave = (notice: Notice, mode: SaveMode): void => {
    setNotice(notice);
    saved.reload();
    if (mode.kind === 'change' && notice.tone === 'done') {
      setBuilder(INITIAL);
      setEditing(undefined);
      setPreviewing(undefined);
      setView('list');
    }
  };
  const before = useRef(view);
  useEffect(() => {
    const was = before.current;
    before.current = view;
    if (view === 'builder') {
      opened.current = true;
      // back from the preview the editor is as it was left, and the focus goes to its Preview button
      if (was === 'run') root.current?.querySelector<HTMLElement>('.pattern-editor-actions .primary')?.focus();
      else startRef.current?.focus();
    } else if (view !== 'run' && opened.current) newButton.current?.focus();
  }, [view]);
  useEffect(() => {
    const frame = root.current?.closest('.panel-frame');
    if (frame === null || frame === undefined) return undefined;
    const onKey = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      // in the builder Escape closes the panel; the list below, hidden, may hold a run that Escape would cancel
      if (viewRef.current === 'builder') close();
      else cancelOrClose.current();
    };
    frame.addEventListener('keydown', onKey);
    return () => frame.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="patterns-panel" ref={root}>
      <div className="search-panel-header">
        <h2 className="search-panel-heading">{view === 'list' ? PATTERNS_COPY.title : view === 'preset' ? (templateData?.presets.find((candidate) => candidate.id === presetId)?.name ?? PATTERNS_COPY.title) : view === 'run' ? (runHeader?.title ?? RUN_COPY.previewTitle) : (editingView?.title ?? SHELL_COPY.newPattern)}</h2>
        <button type="button" className="legend-close" aria-label={view === 'builder' ? PATTERNS_COPY.closeBuilder : PATTERNS_COPY.close} onClick={close}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      {sourceId === null ? null : (
        <p className="search-panel-note patterns-subhead">{view === 'run' ? (runHeader?.subtitle ?? RUN_COPY.draft) : view === 'builder' ? EDITOR_SUBTITLE : listSubtitle(sourceName)}</p>
      )}
      {view === 'list' ? <p className="search-panel-note">{PATTERNS_COPY.intro}</p> : null}
      {notice === undefined ? null : (
        <p className="search-panel-note" role={notice.tone === 'problem' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
      {restarted && view === 'list' ? (
        <p className="search-panel-note" role="status">
          {SHELL_COPY.restartedByMask}
        </p>
      ) : null}
      {sourceId === null ? (
        <p className="search-panel-note">{PATTERNS_COPY.noPatterns}</p>
      ) : (
        <>
          {view === 'list' ? (
            <div className="patterns-actions">
              <button type="button" className="secondary" ref={newButton} onClick={() => {
                  onRestartedSeen();
                  setNotice(undefined);
                  if (editing !== undefined) {
                    setBuilder(INITIAL);
                    setEditing(undefined);
                  }
                  setView('builder');
                }}>
                <span aria-hidden="true">+ </span>
                {SHELL_COPY.newPattern}
              </button>
            </div>
          ) : null}
          <div hidden={view !== 'list'}>
            {templates.state.phase === 'loading' && templateData === undefined ? (
              <p className="search-panel-note" role="status">
                {PATTERNS_COPY.loading}
              </p>
            ) : null}
            {templates.state.phase === 'failed' ? <TemplatesFailure failure={templates.state.failure} sourceName={sourceName} retry={templates.reload} /> : null}
            <PatternsHome
              client={client}
              sourceId={sourceId}
              sourceName={sourceName}
              mask={mask}
              close={close}
              escape={cancelOrClose}
              saved={saved}
              rows={rows}
              presets={templateData?.presets}
              onChange={change}
              onRunPreset={(preset) => {
                setNotice(undefined);
                if (presetRun.ask?.id !== preset.id) presetRun.clear();
                setPresetId(preset.id);
                setView('preset');
              }}
            />
          </div>
          {view === 'preset' && templateData !== undefined && presetId !== undefined && templateData.presets.some((candidate) => candidate.id === presetId) ? (
            <PatternsWorkbench client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} list={templateData} presetId={presetId} run={presetRun} close={close} escape={cancelOrClose} onBack={() => setView('list')} />
          ) : null}
          {view === 'builder' || view === 'run' ? (
            <div hidden={view !== 'builder'}>
              <PatternEditor
                profile={profileView}
                retryProfile={reloadProfile}
                client={client}
                sourceId={sourceId}
                sourceName={sourceName}
                mask={mask}
                maxHops={maxHops}
                state={builder}
                dispatch={dispatch}
                onCancel={cancel}
                onPreview={(definition) => {
                  setPreviewing(definition);
                  setRunHeader(undefined);
                  setNotice(undefined);
                  setView('run');
                }}
                startRef={startRef}
                editing={editingView}
              />
            </div>
          ) : null}
          {view === 'run' && previewing !== undefined && profile !== undefined ? (
            <RunFlow
              client={client}
              sourceId={sourceId}
              sourceName={sourceName}
              mask={mask}
              profile={profile}
              definition={previewing}
              editing={editing?.item}
              onEdit={() => setView('builder')}
              onSaved={afterSave}
              onHeader={setRunHeader}
              close={close}
              escape={cancelOrClose}
            />
          ) : null}
        </>
      )}
      <RowDialogs actions={rows} />
    </div>
  );
}

function TemplatesFailure({ failure, sourceName, retry }: { readonly failure: ApiFailure; readonly sourceName: string; readonly retry: () => void }) {
  const view = failureView(failure, sourceName);
  return (
    <div className="patterns-state" role="alert">
      <p>{view.text}</p>
      <p>{view.detail}</p>
      {canRetry(failure) ? (
        <button type="button" className="secondary" onClick={retry}>
          {PATTERNS_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}

interface WorkbenchProps {
  readonly client: ReturnType<typeof withoutReadsWhileSourceChanged>;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly list: TemplateListResponse;
  /** The built-in pattern whose form this is. */
  readonly presetId: string;
  readonly run: ReturnType<typeof usePatternRun>;
  readonly close: () => void;
  readonly escape: React.MutableRefObject<() => void>;
  readonly onBack: () => void;
}

function PatternsWorkbench({ client, sourceId, sourceName, mask, list, presetId, run, close, escape, onBack }: WorkbenchProps) {
  const state = useClientState();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const shell = useShellData();
  const selection = useStoreSelector(state.presentation.view, (view) => view.selection);
  // the preset Home handed over, read when the list is shown and cleared after the commit; a preset the list does not hold falls back to the first
  const selectedId = presetId;
  useEffect(() => state.presentation.setPatternsPreset(undefined), [state]);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [chosen, setChosen] = useState<GraphNode | undefined>(undefined);
  const [added, setAdded] = useState<{ readonly result: TemplateRunOk; readonly outcome: AddedOutcome } | undefined>(undefined);
  const expansions = useExpandStoreWhenProvided();
  const startField = useRef<HTMLSelectElement>(null);
  const preset: Preset = list.presets.find((candidate) => candidate.id === selectedId) ?? list.presets[0] ?? ({} as Preset);
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
    startField.current?.focus();
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

  const heavy = run.heavy === undefined ? undefined : heavyDecisionOfRun(run.heavy);
  const timeout = source?.timeoutMs;
  const failure = run.failure === undefined ? undefined : failureView(run.failure, sourceName);
  // a result is shown only under the pattern that produced it
  const result = run.result !== undefined && run.result.presetId === preset.id ? run.result : undefined;
  const firstMatch = result?.matchIds[0];
  const principalId = answeredData(shell.me)?.principal.id;
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  // the control follows what the investigation holds: a result whose entities and relationships are all loaded is on the canvas already
  const allLoaded = useStoreSelector(state.investigation, (investigation) => {
    if (result === undefined) return false;
    const nodes = new Set(investigation.nodeRefs.map(elementKey));
    const edges = new Set(investigation.edgeRefs.map(edgeKey));
    return result.nodes.every((node) => nodes.has(elementKey(node.ref))) && result.edges.every((edge) => edges.has(edgeKey(edge.ref)));
  });
  const evidence = useEvidenceHandle();
  const visible = useVisibleGraph();
  const evidenceOpener = evidence === undefined || result === undefined
    ? undefined
    : (reference: string): (() => void) | undefined => {
        const drawn = new Set(partitionEdges(visible).drawable.map((edge) => edgeKey(edge.ref)));
        const edge = result.edges.find((candidate) => candidate.evidenceRefs.includes(reference) && drawn.has(edgeKey(candidate.ref)));
        return edge === undefined ? undefined : () => void evidence.open(edge.ref);
      };
  const addControl =
    result === undefined || sourceChanged || principalId === undefined
      ? undefined
      : { state: (run.running ? 'running' : allLoaded ? 'onCanvas' : 'ready') as 'running' | 'onCanvas' | 'ready', disabled: run.running || allLoaded, onAdd: () => {
          setAdded({ result, outcome: addResultToGraph(state, result, { sourceId, principalId, expansions }) });
        } };

  return (
    <>
      <div className="patterns-actions">
        <button type="button" className="secondary" onClick={onBack}>
          {PATTERNS_COPY.backToList}
        </button>
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
      {hasEntity ? null : <p className="search-panel-note">{startHint(labelOf(preset, 'anchor'))}</p>}
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
      {failure === undefined || run.failure === undefined ? null : <RunFailure key={run.failure.code} failure={failure} fieldSet={run.failure.code === 'QUERY_BUDGET_EXCEEDED' && (maxPageOf(run.failure) ?? maxHopsOf(run.failure)) !== undefined} canRetry={run.ask !== undefined && canRetry(run.failure)} onRetry={() => submit(run.ask)} />}
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
      {result !== undefined && (run.failure !== undefined || run.cancelled || run.heavy !== undefined) ? (
        <p className="search-panel-note" role="status">
          {PATTERNS_COPY.earlierResult}
        </p>
      ) : null}
      {result === undefined ? null : (
        <PatternResult
          result={result}
          {...(addControl === undefined ? {} : { add: addControl })}
          {...(added === undefined || added.result !== result ? {} : { added: added.outcome })}
          {...(evidenceOpener === undefined ? {} : { evidenceOpener })}
          matchHeading={firstMatch === undefined ? PATTERNS_COPY.matchHeading : typeName(firstMatch.entityType)}
          sharedHeading={result.links !== undefined ? PATTERNS_COPY.reachedHeading : `Shared ${typeName(preset.bind.attribute).toLowerCase() || 'attribute'}`}
        />
      )}
    </>
  );
}

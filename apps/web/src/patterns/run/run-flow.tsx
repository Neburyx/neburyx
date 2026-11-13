import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { GraphNode, ListedPattern, PatternDefinition, SavedPattern, SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { useClientState, useLoadedGraph, useVisibleGraph } from '../../state/context.js';
import { edgeKey, elementKey } from '../../state/keys.js';
import { partitionEdges } from '../../state/loaded-graph.js';
import { useStoreSelector } from '../../state/store.js';
import { useEvidenceHandle } from '../evidence-handle.js';
import { RunFailure } from '../run-failure.js';
import { SavePatternDialog, type SaveMode } from '../saved/save-dialog.js';
import { SAVED_COPY } from '../saved/saved-copy.js';
import { savedRunRequest } from '../saved/saved-run-store.js';
import type { Notice } from '../saved/use-row-actions.js';
import { PATTERNS_COPY } from '../copy.js';
import { ChangeDialog } from './change-shared-dialog.js';
import { createDefinitionRunStore, definitionRunRequest, type DefinitionAsk } from './definition-run-store.js';
import { HeavyScreen } from './heavy-screen.js';
import { PreviewScreen } from './preview-screen.js';
import { RUN_COPY, startingFromLine } from './run-copy.js';
import { runFailureView } from './run-copy.js';
import { ResultScreen } from './result-screen.js';
import { RunningScreen } from './running-screen.js';
import { OutOfDate } from './state-views.js';
import { useChangeFlow } from './use-change-flow.js';
import { useAddMatches } from './use-add-matches.js';
import { usePatternPreview } from './use-preview.js';
import { useStartEntity } from './use-start-entity.js';

/** What the panel writes under its own heading while a screen of the run shows. */
export interface RunHeader {
  readonly title: string;
  readonly subtitle: string;
}

/** What the run lane's view of a finished draft is given: the seam between the editor and the run (see the feature's README). */
export interface RunFlowProps {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly profile: SourceProfile;
  readonly definition: PatternDefinition;
  /** The saved pattern opened for a change, whole, so that a save can name its id and version. */
  readonly editing: ListedPattern | undefined;
  /** Back to the editor, to the same draft. */
  readonly onEdit: () => void;
  readonly onSaved: (notice: Notice, mode: SaveMode, saved?: SavedPattern) => void;
  /** A save of a change found the list out of date (the pattern changed or went): the panel reads it again. */
  readonly onStale?: () => void;
  /** Set when the run is of a saved pattern built in the app: the pattern runs through its own route, and what only a saved pattern has (the way back, the out-of-date screen) is drawn. */
  readonly saved?: SavedRun;
  /** Tells the panel what its heading and the line under it say for the screen that shows. */
  readonly onHeader: (header: RunHeader) => void;
  /** Closes the panel. */
  readonly close: () => void;
  /** What Escape does: cancel a run on its way, otherwise close. */
  readonly escape: MutableRefObject<() => void>;
}

/** What the run view of a saved pattern is given besides the screens of a built one. */
export interface SavedRun {
  readonly item: ListedPattern;
  readonly onBack: () => void;
  /** The list is out of date: the pattern is gone or cannot run any more. */
  readonly onStale: () => void;
  /** A run gave its result: the pattern's last run moves. */
  readonly onRan: (id: string) => void;
  /** Change pattern, for the person's own pattern. */
  readonly onChangePattern: () => void;
  /** Copy and change, for another person's shared pattern. */
  readonly onCopyAndChange: () => void;
}

type Stage = 'preview' | 'run';

const entityKeysOf = (answer: { readonly matches: readonly { readonly match: GraphNode['ref']; readonly through: readonly (GraphNode['ref'] | null)[]; readonly relationships: readonly { readonly from: GraphNode['ref'] | null; readonly to: GraphNode['ref'] | null }[] }[] }): string[] =>
  answer.matches.flatMap((match) => [match.match, ...match.through, ...match.relationships.flatMap((hop) => [hop.from, hop.to])].flatMap((ref) => (ref === null ? [] : [elementKey(ref)])));

/** The preview, the choice of where to start, the run and what it gives: running, cancelled, refused, the heavy stop, and the result with its pages and Add to graph. It never edits the draft. */
export function RunFlow({ client, sourceId, sourceName, mask, profile, definition, editing, onEdit, onSaved, onStale, saved, onHeader, close, escape }: RunFlowProps) {
  const state = useClientState();
  const loaded = useLoadedGraph();
  const visible = useVisibleGraph();
  const evidence = useEvidenceHandle();
  const key = useMemo(() => JSON.stringify(definition), [definition]);
  const savedId = saved?.item.id;
  const store = useMemo(() => createDefinitionRunStore(savedId === undefined ? definitionRunRequest(client, sourceId, mask) : savedRunRequest(client, savedId, mask)), [client, sourceId, mask, savedId]);
  useEffect(() => () => store.dispose(), [store]);
  const run = useStoreSelector(store, (view) => view);
  const listedReasons = saved?.item.availability.status === 'unavailable' ? saved.item.availability.reasons : undefined;
  const reasons = run.unavailable?.reasons ?? listedReasons;
  const preview = usePatternPreview(client, sourceId, mask, definition, reasons === undefined ? key : undefined);
  const start = useStartEntity(definition.anchorType);
  const [stage, setStage] = useState<Stage>('preview');
  const [from, setFrom] = useState<GraphNode | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // the name the pattern was saved under from this view, so that the heading says it
  const [savedName, setSavedName] = useState<string | undefined>(undefined);
  const holds = saved !== undefined && !saved.item.askForStartingEntity && listedReasons === undefined;
  useEffect(() => {
    // a saved pattern that holds its starting entity runs at once, with no entity sent
    if (!holds) return;
    setStage('run');
    store.run({ definition });
  }, [store]);
  const unlisted = saved === undefined ? undefined : saved.item.anchor;
  const heldNode = useMemo(() => (unlisted === null || unlisted === undefined ? undefined : loaded.nodes.find((node) => node.ref.entityType === unlisted.entityType && node.ref.stableId === unlisted.stableId)), [loaded, unlisted]);

  const nameOf = (type: string): string => profile.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type;
  const typeName = nameOf(definition.anchorType);
  const showIds = !mask;
  // the stored ID of a keyed type is a token, never shown
  const keyedStart = profile.entityTypes.find((candidate) => candidate.type === definition.anchorType)?.keyed === true;
  const heldRun = holds && from === undefined && run.ask?.anchor === undefined;
  const startedFrom = from ?? (heldRun ? heldNode : start.anchor);
  const startName = startedFrom?.display.title ?? (heldRun && unlisted !== null && unlisted !== undefined ? (showIds && !keyedStart ? unlisted.stableId : typeName) : '');
  const refused = run.failure !== undefined && run.ask?.cursor === undefined;
  const reading = run.running && run.ask?.cursor !== undefined;
  const screen: 'preview' | 'running' | 'heavy' | 'result' | 'outOfDate' =
    reasons !== undefined ? 'outOfDate' : stage === 'preview' ? 'preview' : run.running && !reading ? 'running' : run.cancelled || refused ? 'preview' : run.heavy !== undefined ? 'heavy' : run.result !== undefined ? 'result' : 'preview';

  const press = (ask?: DefinitionAsk): void => {
    const anchor = start.anchor;
    if (ask !== undefined) {
      setStage('run');
      store.run(ask);
      return;
    }
    if (preview.state.kind !== 'ready' || anchor === undefined) return;
    // the entity of the press is kept, so that a selection the run itself changes does not move the start
    start.choose(anchor);
    setFrom(anchor);
    setStage('run');
    store.run({ definition, anchor: { entityType: anchor.ref.entityType, stableId: anchor.ref.stableId } });
  };
  const staleRef = useRef(saved?.onStale);
  staleRef.current = saved?.onStale;
  const ranRef = useRef(saved?.onRan);
  ranRef.current = saved?.onRan;
  useEffect(() => {
    // an answer that says the pattern cannot run, or that it is gone, means the list was out of date; the run view stays on screen while the list is read again
    if (run.unavailable !== undefined || run.failure?.code === 'NOT_FOUND') staleRef.current?.();
  }, [run.unavailable, run.failure]);
  const firstAsk = run.result?.ask;
  useEffect(() => {
    if (firstAsk !== undefined && savedId !== undefined) ranRef.current?.(savedId);
  }, [firstAsk, savedId]);
  const back = (): void => {
    store.reset();
    setStage('preview');
  };

  useEffect(() => {
    escape.current = run.running ? store.cancel : close;
    return () => {
      escape.current = close;
    };
  }, [escape, close, store, run.running]);

  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // after Cancel the focus is on Run again, and after a refusal on Try again, or on the sentence when there is no action to take yet
    const box = noticeBox.current;
    if (box === null || (!run.cancelled && run.failure === undefined)) return;
    const button = box.querySelector<HTMLElement>('button:not([disabled])');
    const target = button ?? box.querySelector<HTMLElement>('p');
    if (button === null && target !== null) target.tabIndex = -1;
    target?.focus();
  }, [run.cancelled, run.failure]);

  const named = saved?.item.name ?? savedName ?? editing?.name;
  useEffect(() => {
    const subtitle = screen === 'preview' || screen === 'running' || screen === 'outOfDate' ? (named ?? RUN_COPY.draft) : `${named ?? RUN_COPY.draftName} · from ${startName}`;
    onHeader({ title: screen === 'running' ? RUN_COPY.runningTitle : screen === 'heavy' ? RUN_COPY.pausedTitle : screen === 'result' ? RUN_COPY.resultTitle : screen === 'outOfDate' ? SAVED_COPY.unavailable : RUN_COPY.previewTitle, subtitle });
  }, [onHeader, screen, named, startName]);

  const shown = screen === 'result' ? run.result?.answer : undefined;
  const add = useAddMatches(sourceId, shown, run.running);
  const evidenceOpener =
    evidence === undefined || shown === undefined
      ? undefined
      : (reference: string): (() => void) | undefined => {
          const drawn = new Set(partitionEdges(visible).drawable.map((edge) => edgeKey(edge.ref)));
          const edge = shown.edges.find((candidate) => candidate.evidenceRefs.includes(reference) && drawn.has(edgeKey(candidate.ref)));
          return edge === undefined ? undefined : () => void evidence.open(edge.ref);
        };

  // the start entity is outlined on the canvas while the run is on its way, and the entities of the matches while a page of the result shows
  const outline = screen === 'running' && startedFrom !== undefined ? [elementKey(startedFrom.ref)] : shown === undefined ? undefined : entityKeysOf(shown);
  const outlineKey = outline === undefined ? undefined : JSON.stringify(outline);
  useEffect(() => {
    if (outline === undefined) return;
    const held = new Set(loaded.nodes.map((node) => elementKey(node.ref)));
    state.presentation.select(outline.filter((entry) => held.has(entry)));
  }, [outlineKey, state]);

  const anchorRef = startedFrom === undefined ? undefined : { entityType: startedFrom.ref.entityType, stableId: startedFrom.ref.stableId };
  const change = useChangeFlow({
    client,
    sourceId,
    item: editing,
    definition,
    anchor: anchorRef,
    onDone: (notice, item, savedPattern) => onSaved(notice, { kind: 'change', item }, savedPattern),
    onStale: () => onStale?.(),
  });
  const saveLinks = (labels: { readonly isNew: string }): React.ReactNode =>
    saved !== undefined || savedName !== undefined ? null : (
      <div className="run-save">
        {editing === undefined ? (
          <button type="button" className="link" onClick={() => setSaving(true)}>
            {labels.isNew}
          </button>
        ) : (
          <>
            <button type="button" className="link" onClick={change.start}>
              {RUN_COPY.saveChanges}
            </button>
            <button type="button" className="link" onClick={() => setSaving(true)}>
              {RUN_COPY.saveAsNew}
            </button>
          </>
        )}
      </div>
    );

  const failureNotice = run.failure === undefined ? null : (
    <div ref={noticeBox}>
      <RunFailure key={run.failure.code} failure={runFailureView(run.failure, sourceName)} canRetry={run.ask !== undefined && runFailureView(run.failure, sourceName).action !== undefined} onRetry={() => run.ask !== undefined && press(run.ask)} />
      {run.failure.code === 'CURSOR_INVALIDATED' && run.result !== undefined ? (
        <button type="button" className="secondary" onClick={() => press(run.result?.ask)}>
          {RUN_COPY.runAgain}
        </button>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (screen === 'outOfDate' && reasons !== undefined) {
    const own = saved?.item.ownedByYou === true;
    body = <OutOfDate reasons={reasons} offer={saved?.item.kind !== 'definition' ? undefined : own ? 'change' : 'copy'} onChange={() => saved?.onChangePattern()} onCopyAndChange={() => saved?.onCopyAndChange()} />;
  } else if (screen === 'running') {
    body = <RunningScreen startLine={startingFromLine(startName, typeName, startedFrom === undefined ? undefined : showIds ? startedFrom.ref.stableId : undefined)} startName={startName} definition={definition} nameOf={nameOf} onCancel={store.cancel} />;
  } else if (screen === 'heavy' && run.heavy !== undefined) {
    const heavy = run.heavy;
    body = (
      <HeavyScreen
        heavy={heavy}
        startName={startName}
        onRefine={onEdit}
        onContinue={() => run.ask !== undefined && press({ definition: run.ask.definition, anchor: run.ask.anchor, continue: { limit: heavy.continueLimit } })}
        onCancel={back}
      />
    );
  } else if (screen === 'result' && shown !== undefined) {
    const page = run.pages[run.page];
    body = (
      <ResultScreen
        answer={shown}
        at={page?.at ?? new Date()}
        page={run.page}
        before={run.pages.slice(0, run.page).reduce((sum, kept) => sum + kept.answer.matches.length, 0)}
        hasNext={run.page + 1 < run.pages.length || shown.nextCursor !== undefined}
        reading={reading}
        mask={mask}
        personal={(type) => profile.entityTypes.find((candidate) => candidate.type === type)?.pii ?? []}
        startName={startName}
        typeName={typeName}
        add={add}
        evidenceOpener={evidenceOpener}
        notice={failureNotice}
        saveLink={saveLinks({ isNew: RUN_COPY.save })}
        onEdit={onEdit}
        onRunAnother={() => {
          if (startedFrom !== undefined) start.decline(startedFrom);
          setFrom(undefined);
          back();
        }}
        onPrevious={store.previous}
        onNext={store.next}
      />
    );
  } else {
    body = (
      <PreviewScreen
        client={client}
        sourceId={sourceId}
        sourceName={sourceName}
        mask={mask}
        preview={preview.state}
        retryPreview={preview.retry}
        typeName={typeName}
        entityType={definition.anchorType}
        candidates={start.candidates}
        chosen={start.anchor}
        onChoose={start.choose}
        showIds={showIds}
        notice={
          run.cancelled ? (
            <div className="patterns-state" role="status" ref={noticeBox}>
              <p>{RUN_COPY.cancelled}</p>
              {run.ask === undefined ? null : (
                <button type="button" className="secondary" onClick={() => press(run.ask)}>
                  {RUN_COPY.runAgain}
                </button>
              )}
            </div>
          ) : refused ? (
            failureNotice
          ) : null
        }
        saveLinks={saveLinks({ isNew: RUN_COPY.savePattern })}
        onEdit={onEdit}
        onRun={() => press()}
      />
    );
  }
  return (
    <div className="run-flow">
      {saved === undefined ? null : (
        <div className="patterns-actions">
          <button type="button" className="secondary" onClick={saved.onBack}>
            {PATTERNS_COPY.backToList}
          </button>
        </div>
      )}
      {body}
      {saving ? (
        <SavePatternDialog
          client={client}
          sourceId={sourceId}
          definition={definition}
          anchor={anchorRef}
          nameOf={nameOf}
          onClose={() => setSaving(false)}
          onDone={(notice, savedPattern) => {
            setSaving(false);
            setSavedName(savedPattern.name);
            onSaved(notice, { kind: 'new' }, savedPattern);
          }}
        />
      ) : null}
      {change.dialog === undefined || editing === undefined ? null : <ChangeDialog name={editing.name} shared={editing.visibility === 'shared'} busy={change.busy} message={change.dialog.message} stale={change.dialog.stale} onCancel={change.cancel} onCopy={change.copy} onEveryone={change.everyone} />}
    </div>
  );
}

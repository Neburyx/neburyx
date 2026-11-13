import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { GraphNode, ListedPattern, PatternDefinition, SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { useClientState, useLoadedGraph, useVisibleGraph } from '../../state/context.js';
import { edgeKey, elementKey } from '../../state/keys.js';
import { partitionEdges } from '../../state/loaded-graph.js';
import { useStoreSelector } from '../../state/store.js';
import { useEvidenceHandle } from '../evidence-handle.js';
import { RunFailure } from '../run-failure.js';
import { SavePatternDialog, type SaveMode } from '../saved/save-dialog.js';
import type { Notice } from '../saved/use-row-actions.js';
import { createDefinitionRunStore, definitionRunRequest, type DefinitionAsk } from './definition-run-store.js';
import { HeavyScreen } from './heavy-screen.js';
import { PreviewScreen } from './preview-screen.js';
import { RUN_COPY, startingFromLine } from './run-copy.js';
import { runFailureView } from './run-copy.js';
import { ResultScreen } from './result-screen.js';
import { RunningScreen } from './running-screen.js';
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
  readonly onSaved: (notice: Notice, mode: SaveMode) => void;
  /** Tells the panel what its heading and the line under it say for the screen that shows. */
  readonly onHeader: (header: RunHeader) => void;
  /** Closes the panel. */
  readonly close: () => void;
  /** What Escape does: cancel a run on its way, otherwise close. */
  readonly escape: MutableRefObject<() => void>;
}

type Stage = 'preview' | 'run';

const entityKeysOf = (answer: { readonly matches: readonly { readonly match: GraphNode['ref']; readonly through: readonly (GraphNode['ref'] | null)[]; readonly relationships: readonly { readonly from: GraphNode['ref'] | null; readonly to: GraphNode['ref'] | null }[] }[] }): string[] =>
  answer.matches.flatMap((match) => [match.match, ...match.through, ...match.relationships.flatMap((hop) => [hop.from, hop.to])].flatMap((ref) => (ref === null ? [] : [elementKey(ref)])));

/** The preview, the choice of where to start, the run and what it gives: running, cancelled, refused, the heavy stop, and the result with its pages and Add to graph. It never edits the draft. */
export function RunFlow({ client, sourceId, sourceName, mask, profile, definition, editing, onEdit, onSaved, onHeader, close, escape }: RunFlowProps) {
  const state = useClientState();
  const loaded = useLoadedGraph();
  const visible = useVisibleGraph();
  const evidence = useEvidenceHandle();
  const key = useMemo(() => JSON.stringify(definition), [definition]);
  const preview = usePatternPreview(client, sourceId, mask, definition, key);
  const store = useMemo(() => createDefinitionRunStore(definitionRunRequest(client, sourceId, mask)), [client, sourceId, mask]);
  useEffect(() => () => store.dispose(), [store]);
  const run = useStoreSelector(store, (view) => view);
  const start = useStartEntity(definition.anchorType);
  const [stage, setStage] = useState<Stage>('preview');
  const [from, setFrom] = useState<GraphNode | undefined>(undefined);
  const [saving, setSaving] = useState<SaveMode | undefined>(undefined);

  const nameOf = (type: string): string => profile.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type;
  const typeName = nameOf(definition.anchorType);
  const showIds = !mask;
  const startedFrom = from ?? start.anchor;
  const startName = startedFrom?.display.title ?? '';
  const refused = run.failure !== undefined && run.ask?.cursor === undefined;
  const reading = run.running && run.ask?.cursor !== undefined;
  const screen: 'preview' | 'running' | 'heavy' | 'result' =
    stage === 'preview' ? 'preview' : run.running && !reading ? 'running' : run.cancelled || refused ? 'preview' : run.heavy !== undefined ? 'heavy' : run.result !== undefined ? 'result' : 'preview';

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

  const base = editing?.name ?? RUN_COPY.draftName;
  useEffect(() => {
    const subtitle = screen === 'preview' || screen === 'running' ? (editing?.name ?? RUN_COPY.draft) : `${base} · from ${startName}`;
    onHeader({ title: screen === 'running' ? RUN_COPY.runningTitle : screen === 'heavy' ? RUN_COPY.pausedTitle : screen === 'result' ? RUN_COPY.resultTitle : RUN_COPY.previewTitle, subtitle });
  }, [onHeader, screen, editing?.name, base, startName]);

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
  const saveLinks = (labels: { readonly isNew: string }): React.ReactNode => (
    <div className="run-save">
      {editing === undefined ? (
        <button type="button" className="link" onClick={() => setSaving({ kind: 'new' })}>
          {labels.isNew}
        </button>
      ) : (
        <>
          <button type="button" className="link" onClick={() => setSaving({ kind: 'change', item: editing })}>
            {RUN_COPY.saveChanges}
          </button>
          <button type="button" className="link" onClick={() => setSaving({ kind: 'new' })}>
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
  if (screen === 'running') {
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
      {body}
      {saving === undefined ? null : (
        <SavePatternDialog
          client={client}
          sourceId={sourceId}
          mode={saving}
          definition={definition}
          anchor={anchorRef}
          nameOf={nameOf}
          onClose={() => setSaving(undefined)}
          onDone={(notice) => {
            setSaving(undefined);
            onSaved(notice, saving);
          }}
        />
      )}
    </div>
  );
}

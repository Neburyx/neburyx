import { useEffect, useMemo, type ReactNode } from 'react';
import type { PatternDefinition, PatternRunHeavy, SourceProfile } from '@neburyx/contracts';
import { continueWith } from '../../banner/copy.js';
import { heavyHeadline, heavyLine } from '../../banner/heavy-banner.js';
import type { ApiClient } from '../../api/client.js';
import { useShellData, answeredData } from '../../shell/shell-data.js';
import { useVisibleGraph } from '../../state/context.js';
import { edgeKey, elementKey } from '../../state/keys.js';
import { partitionEdges } from '../../state/loaded-graph.js';
import { useStoreSelector } from '../../state/store.js';
import { PATTERNS_COPY, timeoutLabel } from '../copy.js';
import { useEvidenceHandle } from '../evidence-handle.js';
import { RunFailure } from '../run-failure.js';
import { StartEntityField } from '../start-entity.js';
import { createDefinitionRunStore, definitionRunRequest, type DefinitionRunView } from './definition-run-store.js';
import { DefinitionResult } from './definition-result.js';
import { useAddResult } from './use-add-result.js';
import { PreviewArea } from './preview-area.js';
import type { SaveContext } from '../saved/save-controls.js';
import { RUN_COPY, runFailureView } from './run-copy.js';
import type { CheckState } from './use-check.js';
import { usePatternPreview } from './use-preview.js';
import { useStartEntity } from './use-start-entity.js';

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly profile: SourceProfile;
  readonly definition: PatternDefinition | undefined;
  readonly anchorType: string | undefined;
  readonly check: CheckState;
  /** The definition the check's `valid` belongs to. */
  readonly validFor: string | undefined;
  /** Puts the focus on the builder's first choice, where Refine filters returns the person to. */
  readonly focusBuilder: () => void;
  /** Save pattern, beside Run: given the starting entity and why nothing can be saved yet. */
  readonly saveControls?: (context: SaveContext) => ReactNode;
}

/** Why Run pattern cannot be pressed, in the order the person meets it, or nothing when it can. */
function runBlock(definition: PatternDefinition | undefined, check: CheckState, previewKind: string, hasAnchor: boolean): string | undefined {
  if (definition === undefined || check.kind === 'none') return RUN_COPY.needComplete;
  if (check.kind === 'checking') return RUN_COPY.checking;
  if (check.kind === 'invalid') return RUN_COPY.notValid;
  if (check.kind === 'failed') return RUN_COPY.checkFailed;
  if (previewKind === 'loading' || previewKind === 'none') return RUN_COPY.waitPreview;
  if (previewKind === 'failed' || previewKind === 'invalid') return RUN_COPY.previewFailed;
  if (!hasAnchor) return RUN_COPY.chooseStart;
  return undefined;
}

/** The estimate of a heavy stop as the shared text writes it: a lower bound at the threshold. */
const estimateOf = (answer: PatternRunHeavy) => ({ value: answer.estimate.value ?? answer.threshold, quality: 'lowerBound' as const });

/** The preview, the starting entity, Run pattern and what a run gives: running, cancelled, failed, the heavy stop, and the result with Add to graph. */
export function RunSection({ client, sourceId, sourceName, mask, profile, definition, anchorType, check, validFor, focusBuilder, saveControls }: Props) {
  const shell = useShellData();
  const evidence = useEvidenceHandle();
  const visible = useVisibleGraph();
  const start = useStartEntity(anchorType);
  const preview = usePatternPreview(client, sourceId, mask, definition, validFor);
  const store = useMemo(() => createDefinitionRunStore(definitionRunRequest(client, sourceId, mask)), [client, sourceId, mask]);
  useEffect(() => () => store.dispose(), [store]);
  const run: DefinitionRunView = useStoreSelector(store, (view) => view);
  const source = (answeredData(shell.sources)?.items ?? []).find((item) => item.id === sourceId);
  const anchor = start.anchor === undefined ? undefined : { entityType: start.anchor.ref.entityType, stableId: start.anchor.ref.stableId };
  const askKey = definition === undefined || anchor === undefined ? undefined : JSON.stringify({ definition, anchor });

  useEffect(() => {
    // a change of the definition or of the starting entity ends a run on its way and takes down what it left
    store.stop();
  }, [store, askKey]);

  const definitionKey = definition === undefined ? undefined : JSON.stringify(definition);
  const block = runBlock(definition, check.kind === 'valid' && validFor !== definitionKey ? { kind: 'checking' } : check, preview.state.kind, anchor !== undefined);
  const shown = run.result !== undefined && askKey !== undefined && JSON.stringify({ definition: run.result.ask.definition, anchor: run.result.ask.anchor }) === askKey ? run.result.answer : undefined;
  const timeout = source?.timeoutMs;
  const failure = run.failure === undefined ? undefined : runFailureView(run.failure, sourceName);
  const heavy = run.heavy;
  const press = (): void => {
    if (definition === undefined || anchor === undefined || start.anchor === undefined || block !== undefined) return;
    // the entity of the press is kept, so that a selection the run itself changes does not move the start
    start.choose(start.anchor);
    store.run({ definition, anchor });
  };

  const { add, added } = useAddResult(sourceId, shown, run.running, 'definition');
  const evidenceOpener =
    evidence === undefined || shown === undefined
      ? undefined
      : (reference: string): (() => void) | undefined => {
          const drawn = new Set(partitionEdges(visible).drawable.map((edge) => edgeKey(edge.ref)));
          const edge = shown.edges.find((candidate) => candidate.evidenceRefs.includes(reference) && drawn.has(edgeKey(candidate.ref)));
          return edge === undefined ? undefined : () => void evidence.open(edge.ref);
        };

  if (anchorType === undefined) {
    return (
      <>
        <RunButton block={RUN_COPY.needComplete} running={false} timeout={timeout} onRun={press} onCancel={store.cancel} />
        {saveControls === undefined ? null : saveControls({ anchor: undefined, block: RUN_COPY.needComplete })}
      </>
    );
  }
  return (
    <>
      <PreviewArea state={preview.state} sourceName={sourceName} retry={preview.retry} />
      <StartEntityField
        client={client}
        sourceId={sourceId}
        mask={mask}
        label={RUN_COPY.startsFrom}
        entityType={anchorType}
        candidates={start.candidates}
        chosenKey={start.anchor === undefined ? undefined : elementKey(start.anchor.ref)}
        onChoose={start.choose}
        selectRef={null}
        id="pattern-run-start"
      />
      <RunButton block={block} running={run.running} timeout={timeout} onRun={press} onCancel={store.cancel} />
      {saveControls === undefined ? null : saveControls({ anchor, block: runBlock(definition, check.kind === 'valid' && validFor !== definitionKey ? { kind: 'checking' } : check, 'ok', true) })}
      {run.running ? (
        <p className="patterns-state" role="status">
          {`Running${timeout === undefined ? '' : ` · ${timeoutLabel(timeout)}`}`}
        </p>
      ) : null}
      {run.cancelled ? (
        <div className="patterns-state" role="status">
          <p>{PATTERNS_COPY.cancelled}</p>
          {run.ask === undefined ? null : (
            <button type="button" className="secondary" onClick={() => run.ask !== undefined && store.run(run.ask)}>
              {PATTERNS_COPY.runAgain}
            </button>
          )}
        </div>
      ) : null}
      {failure === undefined || run.failure === undefined ? null : <RunFailure key={run.failure.code} failure={failure} budgetCap={undefined} canRetry={run.ask !== undefined && failure.action !== undefined} onRetry={() => run.ask !== undefined && store.run(run.ask)} />}
      {heavy === undefined || run.ask === undefined ? null : (
        <div className="patterns-state" data-tone="warning" role="alert">
          <p>{heavyHeadline(estimateOf(heavy), heavy.threshold)}</p>
          <p>{heavyLine(heavy.continueLimit)}</p>
          <div className="patterns-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                store.clear();
                focusBuilder();
              }}
            >
              {PATTERNS_COPY.refine}
            </button>
            <button type="button" className="primary" onClick={() => run.ask !== undefined && store.run({ definition: run.ask.definition, anchor: run.ask.anchor, continue: { limit: heavy.continueLimit } })}>
              {continueWith(heavy.continueLimit)}
            </button>
          </div>
        </div>
      )}
      {shown === undefined ? null : (
        <DefinitionResult
          result={shown}
          matchHeading={profile.entityTypes.find((candidate) => candidate.type === shown.matches[0]?.match.entityType)?.displayName ?? RUN_COPY.match}
          {...(add === undefined ? {} : { add })}
          {...(added === undefined ? {} : { added })}
          {...(evidenceOpener === undefined ? {} : { evidenceOpener })}
        />
      )}
    </>
  );
}

function RunButton({ block, running, timeout, onRun, onCancel }: { readonly block: string | undefined; readonly running: boolean; readonly timeout: number | undefined; readonly onRun: () => void; readonly onCancel: () => void }) {
  const reasonId = 'pattern-run-reason';
  return (
    <>
      <div className="patterns-actions">
        {running ? (
          <button type="button" className="secondary" onClick={onCancel}>
            {PATTERNS_COPY.cancel}
          </button>
        ) : (
          <button type="button" className="primary" disabled={block !== undefined} aria-describedby={block === undefined ? undefined : reasonId} onClick={onRun}>
            {RUN_COPY.run}
          </button>
        )}
        {timeout === undefined ? null : <span className="search-panel-note">{timeoutLabel(timeout)}</span>}
      </div>
      {block === undefined ? null : (
        <p className="search-panel-note" id={reasonId}>
          {block}
        </p>
      )}
    </>
  );
}

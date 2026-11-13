import type { ReactNode } from 'react';
import type { GraphNode, PatternPreview } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { failureView, problemText } from '../copy.js';
import type { PreviewState } from './use-preview.js';
import { RUN_COPY, boundsLine } from './run-copy.js';
import { StartChoice } from './start-choice.js';

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly preview: PreviewState;
  readonly retryPreview: () => void;
  readonly typeName: string;
  readonly entityType: string;
  readonly candidates: readonly GraphNode[];
  readonly chosen: GraphNode | undefined;
  readonly onChoose: (node: GraphNode) => void;
  readonly showIds: boolean;
  /** What the run left to say above the pattern: the cancelled line, or the sentence of a refusal. */
  readonly notice: ReactNode;
  /** Save pattern…, given by the flow. */
  readonly saveLinks: ReactNode;
  readonly onEdit: () => void;
  readonly onRun: () => void;
}

const REASON_ID = 'run-start-reason';

/** The pattern in plain words as the server wrote them, its bounds, the choice of where it starts, and the footer with Edit and Run pattern. The client writes the headings and the numbers of the bounds read from the answer; the phrases are the server's. */
export function PreviewScreen({ client, sourceId, sourceName, mask, preview, retryPreview, typeName, entityType, candidates, chosen, onChoose, showIds, notice, saveLinks, onEdit, onRun }: Props) {
  const ready = preview.kind === 'ready';
  const blocked = !ready || chosen === undefined;
  return (
    <>
      <div className="run-body">
        {notice}
        <PreviewText state={preview} sourceName={sourceName} retry={retryPreview} />
        <StartChoice client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} typeName={typeName} entityType={entityType} candidates={candidates} chosen={chosen} onChoose={onChoose} showIds={showIds} inputId="run-start" />
        {saveLinks}
      </div>
      <div className="run-footer">
        <button type="button" className="secondary" onClick={onEdit}>
          <span aria-hidden="true">‹ </span>
          {RUN_COPY.edit}
        </button>
        <button type="button" className="primary" disabled={blocked} aria-describedby={blocked ? REASON_ID : undefined} onClick={onRun}>
          {RUN_COPY.run}
        </button>
        {blocked ? (
          <span id={REASON_ID} className="visually-hidden">
            {ready ? RUN_COPY.pickOne : preview.kind === 'loading' || preview.kind === 'none' ? RUN_COPY.loadingPreview : RUN_COPY.previewFailed}
          </span>
        ) : null}
      </div>
    </>
  );
}

function PreviewText({ state, sourceName, retry }: { readonly state: PreviewState; readonly sourceName: string; readonly retry: () => void }) {
  if (state.kind === 'none') return null;
  if (state.kind === 'loading') {
    return (
      <p className="search-panel-note" role="status">
        {RUN_COPY.loadingPreview}
      </p>
    );
  }
  if (state.kind === 'failed' || state.kind === 'invalid') {
    return (
      <div className="patterns-state" role="alert">
        <p>{RUN_COPY.previewFailed}</p>
        {state.kind === 'failed' ? <p>{failureView(state.failure, sourceName).text}</p> : state.problems.map((problem, index) => <p key={`${problem.code}-${index}`}>{problemText(problem)}</p>)}
        <button type="button" className="secondary" onClick={retry}>
          {RUN_COPY.tryAgain}
        </button>
      </div>
    );
  }
  return <Words preview={state.preview} />;
}

function Words({ preview }: { readonly preview: PatternPreview }) {
  return (
    <>
      <p className="run-ok" role="status">
        <span aria-hidden="true">✓ </span>
        {RUN_COPY.mappingOk}
      </p>
      <section aria-label={RUN_COPY.inPlainWords}>
        <h3 className="supernode-label">{RUN_COPY.inPlainWords}</h3>
        <div className="run-words">
          <p>{preview.start.text}</p>
          {preview.steps.map((step, index) => (
            <div key={index}>
              <p>{step.text}</p>
              {step.conditions.map((condition, row) => (
                <p key={row} className="run-words-sub">
                  {condition.text}
                </p>
              ))}
              {step.window === undefined ? null : <p className="run-words-sub">{step.window.text}</p>}
            </div>
          ))}
        </div>
      </section>
      <p className="run-bounds">
        {boundsLine(preview.bounds.pageLimit.value, preview.bounds.countCap.value)}
      </p>
    </>
  );
}

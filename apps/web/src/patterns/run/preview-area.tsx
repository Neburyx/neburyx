import type { PatternPreview } from '@neburyx/contracts';
import { RETRY } from '../../banner/copy.js';
import { checkFailureText, failureView, problemText } from '../copy.js';
import type { PreviewState } from './use-preview.js';
import { RUN_COPY } from './run-copy.js';

/** The pattern in words as the server wrote them: the start, each step with its conditions and window, and the bounds of the source a run holds to. The client adds only the headings. */
export function PreviewArea({ state, sourceName, retry }: { readonly state: PreviewState; readonly sourceName: string; readonly retry: () => void }) {
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
        {state.kind === 'failed' ? (
          <p>{checkFailureText(state.failure.code, failureView(state.failure, sourceName).text)}</p>
        ) : (
          state.problems.map((problem, index) => <p key={`${problem.code}-${index}`}>{problemText(problem)}</p>)
        )}
        <button type="button" className="secondary" onClick={retry}>
          {RETRY}
        </button>
      </div>
    );
  }
  return <PreviewText preview={state.preview} />;
}

function PreviewText({ preview }: { readonly preview: PatternPreview }) {
  return (
    <section className="pattern-preview" aria-label={RUN_COPY.preview}>
      <h4 className="supernode-label">{RUN_COPY.preview}</h4>
      <ol className="pattern-preview-steps">
        <li>{preview.start.text}</li>
        {preview.steps.map((step, index) => (
          <li key={index}>
            {step.text}
            {step.conditions.length === 0 && step.window === undefined ? null : (
              <ul>
                {step.conditions.map((condition, row) => (
                  <li key={row}>{condition.text}</li>
                ))}
                {step.window === undefined ? null : <li>{step.window.text}</li>}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <h4 className="supernode-label">{RUN_COPY.bounds}</h4>
      <ul className="pattern-preview-bounds">
        <li>{preview.bounds.hopLimit.text}</li>
        <li>{preview.bounds.pageLimit.text}</li>
        <li>{preview.bounds.countCap.text}</li>
      </ul>
    </section>
  );
}

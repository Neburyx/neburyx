import { useId } from 'react';
import { FailureNotice } from '../failure-notice.js';
import { COPY } from './copy.js';
import { useExcerpt, useExcerpts } from './excerpts-context.js';

export function MappingExample({ sourceId, opening }: { readonly sourceId: string; readonly opening: string }) {
  const headingId = useId();
  const excerpt = useExcerpt(sourceId);
  const excerpts = useExcerpts();
  const text = excerpt?.text;
  return (
    <div className="mapping-example">
      <div className="code-heading">
        <h3 id={headingId}>{COPY.mappingExample}</h3>
        <span>{COPY.mappingLabel}</span>
      </div>
      {excerpt?.failure === undefined ? null : <FailureNotice failure={excerpt.failure} />}
      {text === undefined ? (
        excerpt?.failure === undefined ? (
          <p>{COPY.loadingMapping}</p>
        ) : (
          <button type="button" onClick={() => excerpts.retry(sourceId, opening)}>
            {COPY.tryAgain}
          </button>
        )
      ) : text === '' ? (
        <p>{COPY.noExcerpt}</p>
      ) : (
        <pre role="region" aria-labelledby={headingId} tabIndex={0}>
          {text}
        </pre>
      )}
    </div>
  );
}

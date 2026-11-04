import { useState } from 'react';
import { FailureNotice } from '../failure-notice.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { COPY } from './copy.js';
import { useExcerpts } from './excerpts-context.js';
import { SourceDetail } from './source-detail.js';
import { SourceList } from './source-list.js';

function Body({ opening }: { readonly opening: string }) {
  const { sources, reloadSources } = useShellData();
  const [selectedId, select] = useState<string | undefined>(undefined);
  const answer = answeredData(sources);
  const failure = retainedFailure(sources);

  if (answer === undefined) {
    if (failure === undefined) return <p role="status">{COPY.loadingSources}</p>;
    return (
      <div className="sources-failure">
        <p>{COPY.couldNotRead}</p>
        <FailureNotice failure={failure} />
        <button type="button" onClick={reloadSources}>
          {COPY.tryAgain}
        </button>
      </div>
    );
  }
  const items = answer.items;
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  if (selected?.id !== selectedId) select(selected?.id);
  return (
    <>
      {failure === undefined ? null : <FailureNotice failure={failure} />}
      {selected === undefined ? (
        <p>{COPY.noSources}</p>
      ) : (
        <div className="sources-layout">
          <SourceList items={items} selectedId={selected.id} onSelect={select} />
          <SourceDetail source={selected} opening={opening} />
        </div>
      )}
    </>
  );
}

export function SourcesPage() {
  const excerpts = useExcerpts();
  const [opening] = useState(excerpts.newOpening);
  return (
    <section className="sources-page">
      <PageHeading title={COPY.title} description={COPY.description} />
      <Body opening={opening} />
    </section>
  );
}

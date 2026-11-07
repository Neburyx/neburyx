import { useRef } from 'react';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { FIRST_RUN_COPY } from './copy.js';
import { demoCasesOf } from './demo-case.js';
import { EmptyState } from './empty-state.js';
import { GettingStarted } from './getting-started.js';
import { OpenDemoCase } from './open-demo-case.js';
import { SetupNote } from './setup-note.js';

export function FirstRunPage() {
  const sources = answeredData(useShellData().sources)?.items ?? [];
  const demoCases = demoCasesOf(sources);
  const subtitle = sources.some((source) => source.synthetic) ? FIRST_RUN_COPY.subtitleWithDemo : FIRST_RUN_COPY.subtitleNone;
  const note = useRef<HTMLElement>(null);
  const showNote = (): void => note.current?.focus();
  return (
    <section className="first-run">
      <PageHeading title={FIRST_RUN_COPY.title} description={subtitle} source={null} tag={FIRST_RUN_COPY.tag} />
      <EmptyState title={FIRST_RUN_COPY.emptyTitle} sentence={demoCases.length > 0 ? FIRST_RUN_COPY.sentenceWithDemo : FIRST_RUN_COPY.sentenceWithoutDemo} icon>
        {demoCases.map((entry) => (
          <OpenDemoCase key={entry.sourceId} entry={entry} label={FIRST_RUN_COPY.openDemoCase} offered={demoCases.length} className="primary" />
        ))}
        <button type="button" className="secondary" onClick={showNote}>
          {FIRST_RUN_COPY.connect}
        </button>
      </EmptyState>
      <SetupNote noteRef={note} />
      <GettingStarted />
    </section>
  );
}

import { FIRST_RUN_COPY } from '../first-run/copy.js';
import { demoCasesOf } from '../first-run/demo-case.js';
import { EmptyState } from '../first-run/empty-state.js';
import { answeredData, useShellData } from '../shell/shell-data.js';

export function HomeEmptyState() {
  const offersDemoCase = demoCasesOf(answeredData(useShellData().sources)?.items ?? []).length > 0;
  return <EmptyState title={FIRST_RUN_COPY.emptyTitle} sentence={offersDemoCase ? FIRST_RUN_COPY.sentenceHomeWithDemo : FIRST_RUN_COPY.sentenceHomeWithoutDemo} level={3} />;
}

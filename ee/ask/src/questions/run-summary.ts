import type { AskRunResult } from '@neburyx/contracts';

export interface RunSummary {
  /** The number of elements the result lists, as `ask_runs.row_count` records it. */
  readonly rowCount: number;
  /** Whether the result reports a cut: a count that is a lower bound, a next page, or a notice that the read was bounded. */
  readonly partial: boolean;
}

const lowerBound = (count: { readonly quality: string } | undefined): boolean => count?.quality === 'lowerBound';

/**
 * What a result of a run comes to. The row count is the number of elements it lists: the nodes for a template run, an expansion and the derived neighbors of a rule, the degree entries of a degree
 * preview, the hits of every group of a search, one for an entity and one for the derived edge a support is read for. The run is partial when the result itself says it was cut, never because of a guess.
 */
export function summarizeRun(run: AskRunResult): RunSummary {
  switch (run.templateId) {
    case 'shared-attribute':
    case 'linked-entities': {
      const answer = run.result;
      // a run that stopped as heavy lists nothing and says that more exists than it read
      if (answer.status === 'heavy') return { rowCount: 0, partial: true };
      return { rowCount: answer.nodes.length, partial: lowerBound(answer.count) || answer.notices.some((notice) => notice.code === 'readBounded') };
    }
    case 'saved-pattern': {
      const answer = run.result;
      if (answer.status === 'heavy') return { rowCount: 0, partial: true };
      return { rowCount: answer.nodes.length, partial: lowerBound(answer.count) || ('nextCursor' in answer && answer.nextCursor !== undefined) || answer.notices.some((notice) => notice.code === 'readBounded') };
    }
    case 'file-query':
      return { rowCount: run.result.nodes.length, partial: lowerBound(run.result.count) || run.result.notices.some((notice) => notice.code === 'readBounded') };
    case 'entity':
      return { rowCount: 1, partial: false };
    case 'degree-preview':
      return { rowCount: run.result.byType.length, partial: lowerBound(run.result.total) || run.result.byType.some((entry) => lowerBound(entry.count)) };
    case 'expand':
      return { rowCount: run.result.nodes.length, partial: run.result.pages.some((page) => page.hasMore || page.nextCursor !== undefined || lowerBound(page.matchingTotal)) };
    case 'derived-rule-run':
      return { rowCount: run.result.results.reduce((sum, entry) => sum + entry.nodes.length, 0), partial: run.result.results.some((entry) => lowerBound(entry.count)) };
    case 'derived-edge-support':
      return { rowCount: 1, partial: lowerBound(run.result.supports.count) };
    case 'shortest-paths': {
      const answer = run.result;
      if (answer.status === 'heavy') return { rowCount: 0, partial: true };
      return { rowCount: answer.nodes.length, partial: answer.partial || answer.capReached };
    }
    case 'search': {
      const { exact, related, evidence, exactNextCursor, counts } = run.result;
      return {
        rowCount: exact.length + related.hits.length + evidence.hits.length,
        partial: exactNextCursor !== undefined || related.nextCursor !== undefined || evidence.nextCursor !== undefined || lowerBound(counts.exact) || lowerBound(related.count) || lowerBound(evidence.count),
      };
    }
    default: {
      const unreachable: never = run;
      return unreachable;
    }
  }
}

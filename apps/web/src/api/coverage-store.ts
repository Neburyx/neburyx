import { COVERAGE_MAX_ENTITIES, combineCoverage, type Count, type CoverageEntity } from '@neburyx/contracts';
import type { ApiClient } from './client.js';
import type { FailureReporter } from './failure-reporter.js';
import { createRequestStore, type RequestStore } from './request-store.js';

export interface CoverageInput {
  /** Absent when nothing is loaded. */
  readonly sourceId: string | undefined;
  readonly mask: boolean;
  /** The number of previews answered so far: a new answer is a new question. */
  readonly previewAnswers: number;
  readonly entities: readonly CoverageEntity[];
}

export interface CoverageStore {
  /** The request for the not-yet-retrieved count of this loaded graph, asked once for the graph as it stands; asking for another graph stops the earlier request (its remaining chunks are not sent) and ignores its answer. Nothing when nothing is loaded, which also stops the request for the graph that was. */
  forGraph(input: CoverageInput): RequestStore<Count> | undefined;
}

function chunksOf(entities: readonly CoverageEntity[]): readonly (readonly CoverageEntity[])[] {
  const chunks: CoverageEntity[][] = [];
  for (let start = 0; start < entities.length; start += COVERAGE_MAX_ENTITIES) chunks.push(entities.slice(start, start + COVERAGE_MAX_ENTITIES));
  return chunks;
}

const keyOf = (person: string, sourceId: string, input: CoverageInput): string =>
  JSON.stringify([person, sourceId, input.mask, input.previewAnswers, input.entities.map((entity) => [entity.ref.entityType, entity.ref.stableId, entity.loadedRelationships, entity.loadedExact])]);

/**
 * Asks for the count in chunks of at most `COVERAGE_MAX_ENTITIES`, one after another, and joins the answers. A chunk that fails fails the whole count, so a partial number is never shown. Only the request for the
 * newest graph is kept.
 */
export function createCoverageStore(client: ApiClient, person: () => string, report?: FailureReporter): CoverageStore {
  let current: { readonly key: string; readonly request: RequestStore<Count>; readonly stop: AbortController } | undefined;
  return {
    forGraph(input) {
      const { sourceId } = input;
      if (sourceId === undefined || input.entities.length === 0) {
        current?.stop.abort();
        current = undefined;
        return undefined;
      }
      const key = keyOf(person(), sourceId, input);
      if (current?.key === key) return current.request;
      current?.stop.abort();
      const stop = new AbortController();
      const request = createRequestStore<Count>(
        async (own) => {
          const signal = AbortSignal.any([own, stop.signal]);
          const counts: Count[] = [];
          for (const chunk of chunksOf(input.entities)) {
            if (signal.aborted) return { ok: false, failure: { code: 'ABORTED' } };
            const result = await client.graphCoverage({ sourceId, entities: [...chunk], ...(input.mask ? { mask: input.mask } : {}) }, signal);
            if (!result.ok) return signal.aborted ? { ok: false, failure: { code: 'ABORTED' } } : result;
            counts.push(result.value.notRetrieved);
          }
          return { ok: true, value: combineCoverage(counts) };
        },
        (failure, reload) => void report?.(failure, sourceId, reload),
      );
      current = { key, request, stop };
      return request;
    },
  };
}

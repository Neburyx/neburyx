import type { ApiClient, ApiFailure } from '../api/client.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';

export interface Excerpt {
  readonly opening: string;
  readonly loading: boolean;
  readonly text?: string;
  readonly failure?: ApiFailure;
}

export type ExcerptsState = ReadonlyMap<string, Excerpt>;

export interface Excerpts extends ReadableStore<ExcerptsState> {
  readonly newOpening: () => string;
  readonly show: (sourceId: string, opening: string) => void;
  readonly retry: (sourceId: string, opening: string) => void;
}

/**
 * The read-only mapping excerpts, one read per source and opening of the page, outside React so that rendering twice never asks twice.
 * The earlier text stays on screen while it is read again and when that read fails. An opening that asks while a read is going gets a read of its own when that one ends.
 */
export function createExcerpts(client: ApiClient): Excerpts {
  const store = createStore<ExcerptsState>(new Map());
  let openings = 0;

  const put = (sourceId: string, change: (earlier: Excerpt | undefined) => Excerpt): void => {
    const next = new Map(store.getState());
    next.set(sourceId, change(next.get(sourceId)));
    store.setState(next);
  };

  const keepText = (earlier: Excerpt | undefined): { readonly text?: string } => (earlier?.text === undefined ? {} : { text: earlier.text });

  const fetchExcerpt = (sourceId: string, opening: string): void => {
    const finish = (change: (earlier: Excerpt | undefined) => Omit<Excerpt, 'opening' | 'loading'>): void => {
      const latest = store.getState().get(sourceId)?.opening ?? opening;
      const superseded = latest !== opening;
      put(sourceId, (earlier) => {
        const { failure, ...answered } = change(earlier);
        return { ...answered, ...(superseded || failure === undefined ? {} : { failure }), opening: latest, loading: superseded };
      });
      if (superseded) fetchExcerpt(sourceId, latest);
    };
    void client.getProfile(sourceId).then(
      (result) => {
        if (!result.ok) return finish((earlier) => ({ ...keepText(earlier), failure: result.failure }));
        if (result.value.sourceId !== sourceId) return finish((earlier) => ({ ...keepText(earlier), failure: { code: 'SCHEMA_MISMATCH' } }));
        return finish(() => ({ text: result.value.mappingExcerpt }));
      },
      () => finish((earlier) => ({ ...keepText(earlier), failure: { code: 'UNEXPECTED_FAILURE' } })),
    );
  };

  const read = (sourceId: string, opening: string): void => {
    put(sourceId, (earlier) => ({ opening, loading: true, ...keepText(earlier) }));
    fetchExcerpt(sourceId, opening);
  };

  return {
    ...readable(store),
    newOpening: () => String((openings += 1)),
    show: (sourceId, opening) => {
      const earlier = store.getState().get(sourceId);
      if (earlier?.opening === opening) return;
      if (earlier?.loading === true) put(sourceId, () => ({ ...earlier, opening }));
      else read(sourceId, opening);
    },
    retry: (sourceId, opening) => {
      if (store.getState().get(sourceId)?.loading === true) return;
      read(sourceId, opening);
    },
  };
}

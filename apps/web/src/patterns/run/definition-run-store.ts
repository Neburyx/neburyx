import type { PatternDefinition, PatternRunHeavy, PatternRunOk, PatternRunResponse, PatternUnavailable } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';
import { createStore, type ReadableStore } from '../../state/store.js';

/**
 * What one press of Run sends: the definition, the entity it starts from, whether it continues a run that stopped as heavy (with the page the server offered), and the cursor of the page before when it asks for the next page.
 */
export interface DefinitionAsk {
  readonly definition: PatternDefinition;
  /** The entity the run starts from; a saved pattern that holds its start sends none. */
  readonly anchor?: { readonly entityType: string; readonly stableId: string };
  readonly continue?: { readonly limit: number };
  readonly cursor?: string;
}

/** A page the client kept, with the moment its answer arrived. */
export interface KeptPage {
  readonly answer: PatternRunOk;
  readonly at: Date;
}

export interface DefinitionRunView {
  readonly running: boolean;
  /** The page on screen, with the ask of the run that made its first page: it is shown only while the definition and the entity of the run are those of the ask. */
  readonly result: { readonly ask: DefinitionAsk; readonly answer: PatternRunOk } | undefined;
  /** The pages of the run read so far, in order; there is no backward cursor, so Previous is served from these. */
  readonly pages: readonly KeptPage[];
  /** The index of the page on screen in `pages`. */
  readonly page: number;
  readonly heavy: PatternRunHeavy | undefined;
  /** The saved pattern cannot run against the current mapping: no source was read. */
  readonly unavailable: PatternUnavailable | undefined;
  readonly failure: ApiFailure | undefined;
  readonly cancelled: boolean;
  /** The ask the heavy stop, the failure and the cancelled line belong to, for Continue, Retry and Run again. */
  readonly ask: DefinitionAsk | undefined;
}

export interface DefinitionRunStore extends ReadableStore<DefinitionRunView> {
  readonly run: (ask: DefinitionAsk) => void;
  /** Reads the next page with the cursor of the page on screen, or shows the next kept page after a Previous; it never re-reads a page the client holds. */
  readonly next: () => void;
  /** Shows the page before from the pages kept: nothing is asked. */
  readonly previous: () => void;
  readonly cancel: () => void;
  /** Takes down the heavy stop, the failure and the cancelled line (the builder changed). */
  readonly clear: () => void;
  /** Aborts a run on its way without a cancelled line, and takes down what the run left (the builder changed). */
  readonly stop: () => void;
  /** Stops and also forgets the pages and the result. */
  readonly reset: () => void;
  /** Aborts a run on its way, as leaving the panel does. */
  readonly dispose: () => void;
}

/** Sends one ask and answers as the typed client does, so a run of another kind (a saved pattern) can use the same store with its own request. */
export type RunRequestMaker = (ask: DefinitionAsk, key: string, signal: AbortSignal) => Promise<ApiResult<PatternRunResponse | PatternUnavailable>>;

/** The request of a pattern run from the builder: the definition and the entity it starts from, with the mask of the investigation. */
export const definitionRunRequest =
  (client: ApiClient, sourceId: string, mask: boolean): RunRequestMaker =>
  (ask, key, signal) =>
    ask.anchor === undefined
      ? Promise.resolve(UNEXPECTED)
      : client.runPattern(
      {
        sourceId,
        definition: ask.definition,
        anchor: ask.anchor,
        ...(mask ? { mask: true } : {}),
        ...(ask.continue === undefined ? {} : { continue: true, limit: ask.continue.limit }),
        ...(ask.cursor === undefined ? {} : { cursor: ask.cursor }),
      },
      key,
      signal,
    );

const newKey = (): string => globalThis.crypto.randomUUID();

const IDLE: DefinitionRunView = { running: false, result: undefined, pages: [], page: 0, heavy: undefined, unavailable: undefined, failure: undefined, cancelled: false, ask: undefined };

/**
 * One pattern run at a time: a newer run, a cancel and leaving abort the older one, and an answer to an aborted run is never shown. It lives outside React, as the preset run's store does, so the cancellation suite drives the
 * same store the panel uses. Nothing here touches the graph; the result is shown beside it. The pages of one run are kept so that Previous reads nothing: the first page has no cursor and a re-run would read the estimate again.
 */
export function createDefinitionRunStore(request: RunRequestMaker): DefinitionRunStore {
  const store = createStore<DefinitionRunView>(IDLE);
  let newest: AbortController | undefined;
  let origin: DefinitionAsk | undefined;
  const patch = (change: Partial<DefinitionRunView>): void => store.setState({ ...store.getState(), ...change });

  const show = (pages: readonly KeptPage[], page: number): Pick<DefinitionRunView, 'pages' | 'page' | 'result'> => {
    const shown = pages[page];
    return { pages, page, result: shown === undefined || origin === undefined ? undefined : { ask: origin, answer: shown.answer } };
  };

  const run = (ask: DefinitionAsk): void => {
    newest?.abort();
    const controller = new AbortController();
    newest = controller;
    const fresh = ask.cursor === undefined;
    if (fresh) origin = ask;
    patch({ running: true, heavy: undefined, unavailable: undefined, failure: undefined, cancelled: false, ask, ...(fresh ? { result: undefined, pages: [], page: 0 } : {}) });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<RunRequestMaker>>;
      try {
        result = await request(ask, newKey(), controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (newest !== controller) return;
      newest = undefined;
      if (!result.ok) {
        patch(result.failure.code === 'ABORTED' ? { running: false } : { running: false, failure: result.failure });
        return;
      }
      const answer = result.value;
      if (answer.status === 'unavailable') {
        patch({ running: false, unavailable: answer });
        return;
      }
      if (answer.status === 'heavy') {
        patch({ running: false, heavy: answer });
        return;
      }
      const { pages, page } = store.getState();
      const kept: KeptPage = { answer, at: new Date() };
      patch({ running: false, ...(fresh ? show([kept], 0) : show([...pages.slice(0, page + 1), kept], page + 1)) });
    };
    void send();
  };

  const turn = (to: number): void => {
    const { pages } = store.getState();
    patch({ ...show(pages, to), failure: undefined });
  };

  return {
    ...store,
    run,
    next: () => {
      const { running, pages, page } = store.getState();
      if (running || origin === undefined) return;
      if (page + 1 < pages.length) {
        turn(page + 1);
        return;
      }
      const cursor = pages[page]?.answer.nextCursor;
      if (cursor !== undefined) run({ ...origin, cursor });
    },
    previous: () => {
      const { running, page } = store.getState();
      if (!running && page > 0) turn(page - 1);
    },
    cancel: () => {
      if (newest === undefined) return;
      newest.abort();
      newest = undefined;
      // the page on screen stays when what was cancelled was the read of the next one
      patch(store.getState().ask?.cursor === undefined ? { running: false, cancelled: true } : { running: false });
    },
    clear: () => {
      const { heavy, failure, cancelled } = store.getState();
      if (heavy !== undefined || failure !== undefined || cancelled) patch({ heavy: undefined, failure: undefined, cancelled: false });
    },
    stop: () => {
      newest?.abort();
      newest = undefined;
      patch({ running: false, heavy: undefined, unavailable: undefined, failure: undefined, cancelled: false });
    },
    reset: () => {
      newest?.abort();
      newest = undefined;
      origin = undefined;
      store.setState(IDLE);
    },
    dispose: () => {
      newest?.abort();
      newest = undefined;
    },
  };
}

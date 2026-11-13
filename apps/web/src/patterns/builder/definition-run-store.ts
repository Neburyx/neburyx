import type { PatternDefinition, PatternRunHeavy, PatternRunOk } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';
import { createStore, type ReadableStore } from '../../state/store.js';

/** What one press of Run sends: the definition, the entity it starts from, and whether it continues a run that stopped as heavy (with the page the server offered). */
export interface DefinitionAsk {
  readonly definition: PatternDefinition;
  readonly anchor: { readonly entityType: string; readonly stableId: string };
  readonly continue?: { readonly limit: number };
}

export interface DefinitionRunView {
  readonly running: boolean;
  /** The last result that arrived, with the ask it answers: it is shown only while the definition and the entity of the builder are those of the ask. */
  readonly result: { readonly ask: DefinitionAsk; readonly answer: PatternRunOk } | undefined;
  readonly heavy: PatternRunHeavy | undefined;
  readonly failure: ApiFailure | undefined;
  readonly cancelled: boolean;
  /** The ask the heavy stop, the failure and the cancelled line belong to, for Continue, Retry and Run again. */
  readonly ask: DefinitionAsk | undefined;
}

export interface DefinitionRunStore extends ReadableStore<DefinitionRunView> {
  readonly run: (ask: DefinitionAsk) => void;
  readonly cancel: () => void;
  /** Takes down the heavy stop, the failure and the cancelled line (the builder changed). */
  readonly clear: () => void;
  /** Aborts a run on its way without a cancelled line, and takes down what the run left (the builder changed). */
  readonly stop: () => void;
  /** Aborts a run on its way, as leaving the panel does. */
  readonly dispose: () => void;
}

/** Sends one ask and answers as the typed client does, so a run of another kind (a saved pattern) can use the same store with its own request. */
export type RunRequestMaker = (ask: DefinitionAsk, key: string, signal: AbortSignal) => ReturnType<ApiClient['runPattern']>;

/** The request of a pattern run from the builder: the definition and the entity it starts from, with the mask of the investigation. */
export const definitionRunRequest =
  (client: ApiClient, sourceId: string, mask: boolean): RunRequestMaker =>
  (ask, key, signal) =>
    client.runPattern({ sourceId, definition: ask.definition, anchor: ask.anchor, ...(mask ? { mask: true } : {}), ...(ask.continue === undefined ? {} : { continue: true, limit: ask.continue.limit }) }, key, signal);

const newKey = (): string => globalThis.crypto.randomUUID();

const IDLE: DefinitionRunView = { running: false, result: undefined, heavy: undefined, failure: undefined, cancelled: false, ask: undefined };

/**
 * One pattern run at a time: a newer run, a cancel and leaving abort the older one, and an answer to an aborted run is never shown. It lives outside React, as the preset run's store does, so the cancellation suite drives the
 * same store the panel uses. Nothing here touches the graph; the result is shown beside it.
 */
export function createDefinitionRunStore(request: RunRequestMaker): DefinitionRunStore {
  const store = createStore<DefinitionRunView>(IDLE);
  let newest: AbortController | undefined;
  const patch = (change: Partial<DefinitionRunView>): void => store.setState({ ...store.getState(), ...change });

  const run = (ask: DefinitionAsk): void => {
    newest?.abort();
    const controller = new AbortController();
    newest = controller;
    patch({ running: true, heavy: undefined, failure: undefined, cancelled: false, ask });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['runPattern']>>;
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
      patch(answer.status === 'heavy' ? { running: false, heavy: answer } : { running: false, result: { ask, answer } });
    };
    void send();
  };

  return {
    ...store,
    run,
    cancel: () => {
      if (newest === undefined) return;
      newest.abort();
      newest = undefined;
      patch({ running: false, cancelled: true });
    },
    clear: () => {
      const { heavy, failure, cancelled } = store.getState();
      if (heavy !== undefined || failure !== undefined || cancelled) patch({ heavy: undefined, failure: undefined, cancelled: false });
    },
    stop: () => {
      newest?.abort();
      newest = undefined;
      patch({ running: false, heavy: undefined, failure: undefined, cancelled: false });
    },
    dispose: () => {
      newest?.abort();
      newest = undefined;
    },
  };
}

import type { TemplateRunHeavy, TemplateRunOk } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';
import { createStore, type ReadableStore } from '../state/store.js';

/** What one press of Run sends: the pattern, its parameters, and whether it continues a run that stopped as heavy. */
export interface RunAsk {
  readonly id: string;
  readonly params: Record<string, unknown>;
  readonly continue?: true;
}

export interface PatternRunView {
  readonly running: boolean;
  /** The last result that arrived; it stays while a newer run is on its way, after a failure and after a cancel. */
  readonly result: TemplateRunOk | undefined;
  /** The stop of a heavy run, until the person refines, continues or changes the form. */
  readonly heavy: TemplateRunHeavy | undefined;
  readonly failure: ApiFailure | undefined;
  readonly cancelled: boolean;
  /** The ask the heavy stop, the failure and the cancelled line belong to, for Continue, Retry and Run again. */
  readonly ask: RunAsk | undefined;
}

export interface PatternRunStore extends ReadableStore<PatternRunView> {
  readonly run: (ask: RunAsk) => void;
  readonly cancel: () => void;
  /** Takes down the heavy stop, the failure and the cancelled line (the form changed). */
  readonly clear: () => void;
  /** Aborts a run on its way, as leaving the panel does. */
  readonly dispose: () => void;
}

const newKey = (): string => globalThis.crypto.randomUUID();

const IDLE: PatternRunView = { running: false, result: undefined, heavy: undefined, failure: undefined, cancelled: false, ask: undefined };

/**
 * One run at a time: a newer run, a cancel and leaving abort the older one, and an answer to an aborted run is never shown. It lives outside React, so a test of the cancellation suite drives the same store the panel uses.
 * Nothing here touches the graph; the result is a table beside it.
 */
export function createPatternRunStore(client: ApiClient, sourceId: string, mask: boolean): PatternRunStore {
  const store = createStore<PatternRunView>(IDLE);
  let newest: AbortController | undefined;
  const patch = (change: Partial<PatternRunView>): void => store.setState({ ...store.getState(), ...change });

  const run = (ask: RunAsk): void => {
    newest?.abort();
    const controller = new AbortController();
    newest = controller;
    patch({ running: true, heavy: undefined, failure: undefined, cancelled: false, ask });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['runTemplate']>>;
      try {
        result = await client.runTemplate(ask.id, { sourceId, params: ask.params, ...(mask ? { mask: true } : {}), ...(ask.continue === true ? { continue: true } : {}) }, newKey(), controller.signal);
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
      patch(answer.status === 'heavy' ? { running: false, heavy: answer } : { running: false, result: answer });
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
    dispose: () => {
      newest?.abort();
      newest = undefined;
    },
  };
}

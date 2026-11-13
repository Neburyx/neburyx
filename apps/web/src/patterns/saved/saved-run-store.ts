import { patternRunResponseSchema, templateRunResponseSchema, type PatternRunHeavy, PatternRunOk, PatternUnavailable, TemplateRunHeavy, TemplateRunOk } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';
import { createStore, type ReadableStore } from '../../state/store.js';
import type { DefinitionAsk, RunRequestMaker } from '../run/definition-run-store.js';

/** What one press of Run on a saved pattern sends: the pattern, the entity it starts from when it holds none, and whether it continues a run that stopped as heavy. */
/** Whether the saved pattern is a built-in run, whose answer is a template answer: the kind the person pressed Run on says which to expect. */
export type SavedKind = 'definition' | 'preset-run';

export interface SavedAsk {
  readonly id: string;
  readonly kind: SavedKind;
  readonly anchor?: { readonly entityType: string; readonly stableId: string };
  readonly continue?: { readonly limit: number };
}

/** The answer of a saved run, as the kind of the pattern says: the answer of a built pattern or of a built-in run. */
export type SavedResult = { readonly kind: 'pattern'; readonly answer: PatternRunOk } | { readonly kind: 'template'; readonly answer: TemplateRunOk };
export type SavedHeavy = { readonly kind: 'pattern'; readonly answer: PatternRunHeavy } | { readonly kind: 'template'; readonly answer: TemplateRunHeavy };

export interface SavedRunView {
  readonly running: boolean;
  readonly result: { readonly ask: SavedAsk; readonly answer: SavedResult } | undefined;
  readonly heavy: SavedHeavy | undefined;
  /** The pattern could not run against the current mapping: no source was read. */
  readonly unavailable: { readonly id: string; readonly answer: PatternUnavailable } | undefined;
  readonly failure: ApiFailure | undefined;
  readonly cancelled: boolean;
  /** The ask the heavy stop, the failure and the cancelled line belong to. */
  readonly ask: SavedAsk | undefined;
}

export interface SavedRunStore extends ReadableStore<SavedRunView> {
  readonly run: (ask: SavedAsk) => void;
  readonly cancel: () => void;
  /** Takes down what a run left: the heavy stop, the failure, the cancelled line and a result. */
  readonly clear: () => void;
  readonly dispose: () => void;
}

const newKey = (): string => globalThis.crypto.randomUUID();
const IDLE: SavedRunView = { running: false, result: undefined, heavy: undefined, unavailable: undefined, failure: undefined, cancelled: false, ask: undefined };

/**
 * One saved run at a time: a newer run, a cancel and leaving abort the older one, and an answer to an aborted run is never shown. The mask is the investigation's. It lives outside React, as the other run stores do.
 */
export function createSavedRunStore(client: ApiClient, mask: boolean): SavedRunStore {
  const store = createStore<SavedRunView>(IDLE);
  let newest: AbortController | undefined;
  const patch = (change: Partial<SavedRunView>): void => store.setState({ ...store.getState(), ...change });

  const run = (ask: SavedAsk): void => {
    newest?.abort();
    const controller = new AbortController();
    newest = controller;
    patch({ running: true, heavy: undefined, unavailable: undefined, failure: undefined, cancelled: false, ask });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['runSavedPattern']>>;
      try {
        result = await client.runSavedPattern(ask.id, { ...(ask.anchor === undefined ? {} : { anchor: ask.anchor }), ...(mask ? { mask: true } : {}), ...(ask.continue === undefined ? {} : { continue: true, limit: ask.continue.limit }) }, newKey(), controller.signal);
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
      if (answer.status === 'unavailable') return patch({ running: false, unavailable: { id: ask.id, answer } });
      // the kind of the saved pattern says which answer to expect; an answer of the other shape is a mismatch, never shown
      if (ask.kind === 'preset-run') {
        const template = templateRunResponseSchema.safeParse(answer);
        if (!template.success) return patch({ running: false, failure: { code: 'SCHEMA_MISMATCH' } });
        return patch(template.data.status === 'heavy' ? { running: false, heavy: { kind: 'template', answer: template.data } } : { running: false, result: { ask, answer: { kind: 'template', answer: template.data } } });
      }
      const pattern = patternRunResponseSchema.safeParse(answer);
      if (!pattern.success) return patch({ running: false, failure: { code: 'SCHEMA_MISMATCH' } });
      patch(pattern.data.status === 'heavy' ? { running: false, heavy: { kind: 'pattern', answer: pattern.data } } : { running: false, result: { ask, answer: { kind: 'pattern', answer: pattern.data } } });
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
      newest?.abort();
      newest = undefined;
      store.setState(IDLE);
    },
    dispose: () => {
      newest?.abort();
      newest = undefined;
    },
  };
}

/**
 * The request of a saved pattern built in the app, for the store of the run view: the route of the saved pattern with the entity of the ask (none when the pattern holds its start), the mask of the investigation, the continuation and the cursor.
 * An answer that says the pattern is unavailable passes through; an answer of the shape of a built-in run is a mismatch, never shown.
 */
export const savedRunRequest =
  (client: ApiClient, id: string, mask: boolean): RunRequestMaker =>
  async (ask: DefinitionAsk, key, signal) => {
    const result = await client.runSavedPattern(
      id,
      { ...(ask.anchor === undefined ? {} : { anchor: ask.anchor }), ...(mask ? { mask: true } : {}), ...(ask.continue === undefined ? {} : { continue: true, limit: ask.continue.limit }), ...(ask.cursor === undefined ? {} : { cursor: ask.cursor }) },
      key,
      signal,
    );
    if (!result.ok) return result;
    if (result.value.status === 'unavailable') return { ok: true, value: result.value };
    const pattern = patternRunResponseSchema.safeParse(result.value);
    return pattern.success ? { ok: true, value: pattern.data } : { ok: false, failure: { code: 'SCHEMA_MISMATCH' } };
  };

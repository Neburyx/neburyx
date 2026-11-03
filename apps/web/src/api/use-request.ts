import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ApiFailure, ApiResult } from './client.js';

export type RequestState<T> =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly data?: T }
  | { readonly phase: 'ready'; readonly data: T; readonly failure?: ApiFailure }
  | { readonly phase: 'failed'; readonly failure: ApiFailure };

type Action<T> =
  | { readonly type: 'start' }
  | { readonly type: 'answer'; readonly result: ApiResult<T> }
  | { readonly type: 'cancel' };

function dataOf<T>(state: RequestState<T>): T | undefined {
  return state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
}

export function reduceRequest<T>(state: RequestState<T>, action: Action<T>): RequestState<T> {
  const data = dataOf(state);
  switch (action.type) {
    case 'start':
      return data === undefined ? { phase: 'loading' } : { phase: 'loading', data };
    case 'answer':
      if (action.result.ok) return { phase: 'ready', data: action.result.value };
      return data === undefined ? { phase: 'failed', failure: action.result.failure } : { phase: 'ready', data, failure: action.result.failure };
    case 'cancel':
      return data === undefined ? { phase: 'idle' } : { phase: 'ready', data };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export const UNEXPECTED: ApiResult<never> = { ok: false, failure: { code: 'UNEXPECTED_FAILURE' } };

export interface RequestControls<T> {
  readonly state: RequestState<T>;
  readonly reload: () => void;
  readonly cancel: () => void;
}

/** Runs `load` on mount and whenever `load` changes. Only the newest request's answer is used; an aborted one is ignored. */
export function useRequest<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>): RequestControls<T> {
  const [state, dispatch] = useReducer(reduceRequest<T>, { phase: 'idle' });
  const newest = useRef<AbortController | undefined>(undefined);

  const run = useCallback(() => {
    newest.current?.abort();
    const controller = new AbortController();
    newest.current = controller;
    dispatch({ type: 'start' });
    const settle = async (): Promise<void> => {
      let result: ApiResult<T>;
      try {
        result = await load(controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (newest.current !== controller) return;
      if (!result.ok && result.failure.code === 'ABORTED') return;
      dispatch({ type: 'answer', result });
    };
    void settle();
  }, [load]);

  const cancel = useCallback(() => {
    newest.current?.abort();
    newest.current = undefined;
    dispatch({ type: 'cancel' });
  }, []);

  useEffect(() => {
    run();
    return () => {
      newest.current?.abort();
      newest.current = undefined;
    };
  }, [run]);

  return { state, reload: run, cancel };
}

import { useEffect, useRef, useState } from 'react';
import { MAX_SEARCH_TEXT_LENGTH, MIN_TYPEAHEAD_TEXT_LENGTH, type SearchResult } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';

export const TYPEAHEAD_DEBOUNCE_MS = 250;

export type TextLength = 'short' | 'ok' | 'long';

export function lengthOf(text: string): TextLength {
  const characters = Array.from(text).length;
  if (characters < MIN_TYPEAHEAD_TEXT_LENGTH) return 'short';
  return characters > MAX_SEARCH_TEXT_LENGTH ? 'long' : 'ok';
}

export interface TypeaheadAnswer {
  /** The text the answer is for, which is not the typed text while a newer search waits or runs. */
  readonly text: string;
  readonly result: SearchResult;
}

export interface Typeahead {
  readonly length: TextLength;
  readonly waiting: boolean;
  readonly answered: TypeaheadAnswer | undefined;
  readonly failure: ApiFailure | undefined;
  readonly retry: () => void;
}

interface View {
  readonly answered: TypeaheadAnswer | undefined;
  readonly failure: ApiFailure | undefined;
}

/**
 * One search for the text, sent once it has stood still for the debounce and never for less than 2 or more than 200 characters. A newer text, a change of source or mask, and leaving
 * abort the request and the pending wait, and an answer that arrives after that is ignored; an earlier answer stays until the new one comes.
 */
export function useTypeahead(client: ApiClient, sourceId: string, mask: boolean, text: string): Typeahead {
  const [view, setView] = useState<View>({ answered: undefined, failure: undefined });
  const [waiting, setWaiting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retrying = useRef(false);
  const length = lengthOf(text);

  useEffect(() => {
    setView((previous) => (previous.failure === undefined ? previous : { ...previous, failure: undefined }));
    if (length !== 'ok') {
      setWaiting(false);
      retrying.current = false;
      return undefined;
    }
    setWaiting(true);
    const controller = new AbortController();
    const delay = retrying.current ? 0 : TYPEAHEAD_DEBOUNCE_MS;
    retrying.current = false;
    const timer = setTimeout(() => {
      const send = async (): Promise<ApiResult<SearchResult>> => {
        try {
          return await client.searchEntities({ sourceId, text, typeahead: true, ...(mask ? { mask: true } : {}) }, controller.signal);
        } catch {
          return UNEXPECTED;
        }
      };
      void send().then((result) => {
        if (controller.signal.aborted) return;
        setWaiting(false);
        setView((previous) => (result.ok ? { answered: { text, result: result.value }, failure: undefined } : { answered: previous.answered, failure: result.failure }));
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, sourceId, mask, text, length, attempt]);

  const retry = (): void => {
    if (length !== 'ok') return;
    retrying.current = true;
    setAttempt((count) => count + 1);
  };
  return { length, waiting, answered: view.answered, failure: view.failure, retry };
}

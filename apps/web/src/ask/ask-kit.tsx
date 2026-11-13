import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AskPlanRequest, ElementRef, SearchRequest, SearchResult } from '@neburyx/contracts';
import { ApiClientProvider } from '../api/client-context.js';
import type { ApiClient, ApiFailure, ApiResult, AskPlanAnswer } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { AskPanel } from './ask-panel.js';
import { useAsk } from './use-ask.js';

export interface SentAsk {
  readonly request: AskPlanRequest;
  readonly signal: AbortSignal | undefined;
  answer(result: ApiResult<AskPlanAnswer>): void;
}

export interface SentSearch {
  readonly request: SearchRequest;
  readonly signal: AbortSignal | undefined;
  answer(result: ApiResult<SearchResult>): void;
}

export const SOURCE = 'demo';
export const HASH = 'a'.repeat(64);
export const REF = (stableId: string, entityType = 'widget'): ElementRef => ({ sourceId: SOURCE, entityType, stableId });

export const previewOf = (preview: string, previewHash = HASH, changed = false): ApiResult<AskPlanAnswer> => ({ ok: true, value: { preview, previewHash, ...(changed ? { changed: true as const } : {}) } });
export const blockedOf = (...tokens: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }>): ApiResult<AskPlanAnswer> => ({ ok: true, value: { blocked: { tokens: [...tokens] } } });
export const failed = (code: ApiFailure['code'], extra: Partial<ApiFailure> = {}): ApiResult<never> => ({ ok: false, failure: { code, ...extra } as ApiFailure });
export const server = (code: string, details?: Record<string, unknown>): ApiResult<never> => ({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 'tr-1', ...(details === undefined ? {} : { details }) } as ApiFailure });

/** A client whose Ask and search calls wait until the test answers them, so the order of the answers is the test's. */
export function askClient(): { readonly client: ApiClient; readonly asks: SentAsk[]; readonly searches: SentSearch[] } {
  const asks: SentAsk[] = [];
  const searches: SentSearch[] = [];
  const client = fakeClient({
    askPlan: (request, signal) => new Promise((resolve) => asks.push({ request, signal, answer: resolve })),
    searchEntities: (request, signal) => new Promise((resolve) => searches.push({ request, signal, answer: resolve })),
  });
  return { client, asks, searches };
}

export interface AskHarness {
  readonly state: ClientState;
  readonly asks: SentAsk[];
  readonly searches: SentSearch[];
  readonly container: HTMLElement;
}

export function drawAsk(options: { readonly source?: string | null; readonly state?: ClientState } = {}): AskHarness {
  const { client, asks, searches } = askClient();
  const state = options.state ?? createClientState();
  if (options.source !== null) state.bindSource(options.source ?? SOURCE);
  const view = render(
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <AskPanel />
      </ClientStateProvider>
    </ApiClientProvider>,
  );
  return { state, asks, searches, container: view.container };
}

export const field = (): HTMLTextAreaElement => {
  const found = screen.getByRole('textbox', { name: 'Your question' });
  if (!(found instanceof HTMLTextAreaElement)) throw new Error('the question field is not a text area');
  return found;
};

export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export async function answerAsk(sent: SentAsk | undefined, result: ApiResult<AskPlanAnswer>): Promise<void> {
  if (sent === undefined) throw new Error('no Ask request was sent');
  await act(async () => {
    sent.answer(result);
    await Promise.resolve();
  });
}

export async function answerSearch(sent: SentSearch | undefined, result: ApiResult<SearchResult>): Promise<void> {
  if (sent === undefined) throw new Error('no search was sent');
  await act(async () => {
    sent.answer(result);
    await Promise.resolve();
  });
}

/** The state of the panel as the hook holds it, for what the screen does not draw. */
export function hookAsk(): AskHarness & { readonly current: () => ReturnType<typeof useAsk> } {
  const { client, asks, searches } = askClient();
  const state = createClientState();
  state.bindSource(SOURCE);
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>{children}</ClientStateProvider>
    </ApiClientProvider>
  );
  const { result } = renderHook(() => useAsk(), { wrapper });
  return { state, asks, searches, container: document.body, current: () => result.current };
}

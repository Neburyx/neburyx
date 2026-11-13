import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SEARCH_TEXT_LENGTH, type AskPlanAnswer as AskPlanned, type AskResolution, type ElementRef, type GraphNode } from '@neburyx/contracts';
import type { AskPlanAnswer, ApiResult } from '../api/client.js';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import type { FailureWords } from '../patterns/failure-words.js';
import { askSending } from './ask-activity.js';
import { askFailureWords, isPicksRefusal } from './ask-failure.js';
import { blockedAfter, canBeSearchValue, codePointCount, editBetween, isTooLong, picksAfter, pickLimitReached, rangeAfter, withoutWord, withPick, type BlockedToken, type Edit } from './ask-model.js';
import { ASK_COPY } from './copy.js';
import { PLAN_COPY } from './plan-copy.js';

export type Clarification = Extract<AskPlanAnswer, { readonly clarification: unknown }>['clarification'];

export type Card =
  | { readonly kind: 'preview'; readonly preview: string; readonly hash: string; readonly changed: boolean; readonly patternText: string | undefined; readonly patternsCut: boolean }
  | { readonly kind: 'blocked'; readonly tokens: readonly BlockedToken[] }
  | { readonly kind: 'clarification'; readonly clarification: Clarification };

export interface Picker {
  readonly token: BlockedToken;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly nodes: readonly GraphNode[];
  readonly unreferenced: number;
  readonly count: Clarification['count'] | undefined;
  readonly query: string;
  readonly failure: FailureWords | undefined;
}

export interface FailureView {
  readonly words: FailureWords;
  readonly retry: 'preview' | 'send' | undefined;
}

export interface AskModel {
  readonly text: string;
  readonly picks: readonly AskResolution[];
  readonly card: Card | undefined;
  readonly busy: 'idle' | 'asking' | 'sending';
  readonly failure: FailureView | undefined;
  /** The status of a question that was sent, in words; the preview card stays, greyed. */
  readonly sent: string | undefined;
  readonly fieldNote: string | undefined;
  readonly notice: string | undefined;
  readonly picker: Picker | undefined;
  /** The plan the server answered to a send, for the plan card to draw. */
  readonly plan: AskPlanned | undefined;
  /** The ID and expiry the server gave a plan of a template, for the plan card; none for a plan that is unsupported. */
  readonly planId: string | undefined;
  readonly expiresAt: string | undefined;
  /** Changes with each card that is drawn, so a card that replaces another of its kind takes the focus again. */
  readonly cardId: number;
  /** Counts up each time the field is to take the focus; `caret` is where its cursor goes. */
  readonly focus: { readonly tick: number; readonly caret: number | undefined };
}

const INITIAL: AskModel = { text: '', picks: [], card: undefined, busy: 'idle', failure: undefined, sent: undefined, fieldNote: undefined, notice: undefined, picker: undefined, plan: undefined, planId: undefined, expiresAt: undefined, cardId: 0, focus: { tick: 1, caret: undefined } };

const isAborted = (result: ApiResult<unknown>): boolean => !result.ok && result.failure.code === 'ABORTED';

export interface AskPanel {
  readonly model: AskModel;
  readonly sourceId: string | null;
  setText(text: string): void;
  preview(): void;
  send(): void;
  editQuestion(): void;
  removeWord(token: BlockedToken): void;
  openPicker(token: BlockedToken): void;
  closePicker(): void;
  searchPicker(query: string): void;
  retryPicker(): void;
  chooseEntity(node: GraphNode): void;
  chooseValue(token: BlockedToken): void;
  chooseChip(ref: ElementRef): void;
  cancelClarification(): void;
  /** Gives up a plan that cannot be used any more and returns to the question with its preview, so nothing is sent again without Send. */
  askAgain(): void;
  /** Says that a plan may have run, when its answer arrived after the investigation changed or the card went away. */
  noteMayHaveRun(): void;
  retry(): void;
  canUseValue(token: BlockedToken): boolean;
  limitReached: boolean;
}

/** Everything the Ask panel does, in one place: its question, its picks, the one card on screen and the requests behind them. */
export function useAsk(): AskPanel {
  const client = useApiClient();
  const state = useClientState();
  const sourceId = useStoreSelector(state.investigation, (held) => held.sourceId);
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const [model, setShown] = useState<AskModel>(INITIAL);
  const held = useRef<AskModel>(INITIAL);
  const sequence = useRef(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const previewControl = useRef<AbortController | undefined>(undefined);
  const pickerControl = useRef<AbortController | undefined>(undefined);
  const sourceRef = useRef<string | null>(sourceId);
  sourceRef.current = sourceId;

  const put = useCallback((next: AskModel): void => {
    held.current = next;
    if (mounted.current) setShown(next);
  }, []);
  const patch = useCallback((changes: Partial<AskModel>): void => put({ ...held.current, ...changes }), [put]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewControl.current?.abort();
      pickerControl.current?.abort();
    };
  }, []);

  const contextKey = `${investigationId ?? ''}|${sourceId ?? ''}`;
  const lastKey = useRef(contextKey);
  useEffect(() => {
    if (lastKey.current === contextKey) return;
    lastKey.current = contextKey;
    previewControl.current?.abort();
    pickerControl.current?.abort();
    sequence.current += 1;
    epoch.current += 1;
    const wasSending = held.current.busy === 'sending';
    put({ ...INITIAL, text: held.current.text, notice: wasSending ? ASK_COPY.maySent : undefined, focus: held.current.focus });
  }, [contextKey, put]);

  const failureOf = useCallback((failure: Parameters<typeof askFailureWords>[0], retry: FailureView['retry']): FailureView => {
    const words = askFailureWords(failure, sourceRef.current ?? '');
    return { words, retry: words.action === 'try-again' ? retry : undefined };
  }, []);

  const apply = useCallback(
    (answer: AskPlanAnswer): void => {
      const base = { busy: 'idle' as const, failure: undefined, fieldNote: undefined, notice: undefined, picker: undefined, cardId: held.current.cardId + 1 };
      if ('preview' in answer) patch({ ...base, card: { kind: 'preview', preview: answer.preview, hash: answer.previewHash, changed: answer.changed === true, patternText: answer.patternText, patternsCut: answer.patternCatalogCut === true }, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined });
      else if ('blocked' in answer) patch({ ...base, card: { kind: 'blocked', tokens: answer.blocked.tokens }, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined });
      else if ('clarification' in answer) patch({ ...base, card: { kind: 'clarification', clarification: answer.clarification }, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined });
      else patch({ ...base, cardId: held.current.cardId, sent: answer.plan.kind === 'unsupported' ? ASK_COPY.refused : ASK_COPY.sentPlan, plan: answer.plan, planId: 'planId' in answer ? answer.planId : undefined, expiresAt: 'expiresAt' in answer ? answer.expiresAt : undefined });
    },
    [patch],
  );

  const askPreview = useCallback(
    async (picks: readonly AskResolution[]): Promise<void> => {
      const current = held.current;
      const source = sourceRef.current;
      if (source === null || current.busy === 'sending') return;
      if (current.text.trim() === '') return patch({ fieldNote: ASK_COPY.empty });
      if (isTooLong(current.text)) return patch({ fieldNote: ASK_COPY.tooLong });
      previewControl.current?.abort();
      const controller = new AbortController();
      previewControl.current = controller;
      const id = (sequence.current += 1);
      patch({ picks, busy: 'asking', failure: undefined, fieldNote: undefined, notice: undefined });
      const result = await client.askPlan({ message: current.text, sourceId: source, ...(picks.length > 0 ? { resolutions: [...picks] } : {}), send: false }, controller.signal);
      if (id !== sequence.current || controller.signal.aborted) return;
      if (isAborted(result)) return patch({ busy: 'idle' });
      if (result.ok) return apply(result.value);
      if (isPicksRefusal(result.failure) && picks.length > 0) return patch({ busy: 'idle', picks: [], card: undefined, notice: ASK_COPY.picksRefused });
      patch({ busy: 'idle', failure: failureOf(result.failure, 'preview') });
    },
    [apply, client, failureOf, patch],
  );

  const setText = useCallback(
    (next: string): void => {
      const current = held.current;
      if (current.busy === 'sending') return;
      const cleaned = next.replaceAll(/[\r\n]+/g, ' ');
      if (cleaned === current.text) return;
      const edit: Edit = editBetween(current.text, cleaned);
      previewControl.current?.abort();
      sequence.current += 1;
      const picks = picksAfter(current.picks, edit, current.text, cleaned);
      let card: Card | undefined;
      if (current.card?.kind === 'blocked') {
        const tokens = blockedAfter(current.card.tokens, edit, current.text, cleaned);
        card = tokens.length > 0 ? { kind: 'blocked', tokens } : undefined;
      } else if (current.card?.kind === 'clarification') {
        const moved = rangeAfter(current.card.clarification, edit, current.text, cleaned);
        card = moved === undefined ? undefined : { kind: 'clarification', clarification: { ...current.card.clarification, ...moved } };
      }
      const picker = current.picker !== undefined && card?.kind === 'blocked' && card.tokens.some((token) => token.start === current.picker?.token.start) ? current.picker : undefined;
      if (picker === undefined) pickerControl.current?.abort();
      put({ ...current, text: cleaned, picks, card, picker, busy: 'idle', failure: undefined, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined, fieldNote: undefined, notice: undefined });
    },
    [put],
  );

  const send = useCallback(async (): Promise<void> => {
    const current = held.current;
    const source = sourceRef.current;
    const card = current.card;
    if (source === null || card?.kind !== 'preview' || current.busy !== 'idle' || current.sent !== undefined) return;
    const startedIn = epoch.current;
    patch({ busy: 'sending', failure: undefined, notice: undefined });
    askSending.setState(true);
    const result = await client
      .askPlan({ message: current.text, sourceId: source, ...(current.picks.length > 0 ? { resolutions: [...current.picks] } : {}), send: true, previewHash: card.hash })
      .finally(() => askSending.setState(false));
    if (!mounted.current || startedIn !== epoch.current) return;
    if (isAborted(result)) return patch({ busy: 'idle' });
    if (result.ok) return apply(result.value);
    if (isPicksRefusal(result.failure) && current.picks.length > 0) return patch({ busy: 'idle', picks: [], card: undefined, notice: ASK_COPY.picksRefused });
    patch({ busy: 'idle', failure: failureOf(result.failure, 'send') });
  }, [apply, client, failureOf, patch]);

  const search = useCallback(
    async (token: BlockedToken, query: string): Promise<void> => {
      const source = sourceRef.current;
      const text = query.trim();
      if (source === null || text === '' || codePointCount(text) > MAX_SEARCH_TEXT_LENGTH) return;
      pickerControl.current?.abort();
      const controller = new AbortController();
      pickerControl.current = controller;
      patch({ picker: { token, query, status: 'loading', nodes: [], unreferenced: 0, count: undefined, failure: undefined } });
      const result = await client.searchEntities({ sourceId: source, text, matchModes: ['exact'], mask: true }, controller.signal);
      if (controller.signal.aborted || isAborted(result) || held.current.picker?.token.start !== token.start) return;
      if (!result.ok) return patch({ picker: { token, query, status: 'failed', nodes: [], unreferenced: 0, count: undefined, failure: askFailureWords(result.failure, source) } });
      const { exact, exactUnreferenced, counts } = result.value;
      patch({ picker: { token, query, status: 'ready', nodes: exact, unreferenced: exactUnreferenced?.length ?? 0, count: counts.exact, failure: undefined } });
    },
    [client, patch],
  );

  const addPick = useCallback((pick: AskResolution): void => void askPreview(withPick(held.current.picks, pick)), [askPreview]);

  return {
    model,
    sourceId,
    setText,
    preview: () => void askPreview(held.current.picks),
    send: () => void send(),
    editQuestion: () => {
      const current = held.current;
      const caret = current.card?.kind === 'blocked' ? current.card.tokens[0]?.end : undefined;
      put({ ...current, card: current.card?.kind === 'preview' ? undefined : current.card, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined, focus: { tick: current.focus.tick + 1, caret } });
    },
    removeWord: (token) => {
      const current = held.current;
      const { text, edit } = withoutWord(current.text, token);
      previewControl.current?.abort();
      sequence.current += 1;
      pickerControl.current?.abort();
      put({ ...current, text, picks: picksAfter(current.picks, edit, current.text, text), card: undefined, picker: undefined, busy: 'idle', failure: undefined, sent: undefined, plan: undefined, planId: undefined, expiresAt: undefined });
      void askPreview(held.current.picks);
    },
    openPicker: (token) => void search(token, token.text),
    searchPicker: (query) => {
      const token = held.current.picker?.token;
      if (token !== undefined) void search(token, query);
    },
    closePicker: () => {
      pickerControl.current?.abort();
      patch({ picker: undefined });
    },
    retryPicker: () => {
      const picker = held.current.picker;
      if (picker !== undefined) void search(picker.token, picker.query);
    },
    chooseEntity: (node) => {
      const token = held.current.picker?.token;
      if (token === undefined) return;
      addPick({ start: token.start, end: token.end, ref: node.ref });
    },
    chooseValue: (token) => addPick({ start: token.start, end: token.end, value: true }),
    chooseChip: (ref) => {
      const card = held.current.card;
      if (card?.kind !== 'clarification') return;
      addPick({ start: card.clarification.start, end: card.clarification.end, ref });
    },
    cancelClarification: () => patch({ card: undefined, failure: undefined }),
    noteMayHaveRun: () => patch({ notice: PLAN_COPY.mayHaveRun }),
    askAgain: () => patch({ plan: undefined, planId: undefined, expiresAt: undefined, sent: undefined, busy: 'idle', failure: undefined }),
    retry: () => {
      const failure = held.current.failure;
      if (failure?.retry === 'send') void send();
      else if (failure?.retry === 'preview') void askPreview(held.current.picks);
    },
    canUseValue: (token) => canBeSearchValue(token.text),
    limitReached: pickLimitReached(model.picks),
  };
}

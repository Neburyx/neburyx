import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ASK_QUESTION_MAX_CODE_POINTS, ASK_REFUSAL_SENTENCES, type AskAnswer } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import type { ApiResult } from '../api/client.js';
import { addResultToGraph } from '../patterns/add-to-graph.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import { isNotInThisEdition } from './ask-failure.js';
import { EMPTY_SESSION, useAskSession, type Answered, type AskCall, type AskSessionState, type AskStage } from './ask-session.js';
import { addableOf } from './result-model.js';

export const codePointsOf = (text: string): number => [...text].length;

/** Typing and pasting stop at the limit: the text is cut to its first characters. */
const truncated = (text: string): string => (codePointsOf(text) > ASK_QUESTION_MAX_CODE_POINTS ? [...text].slice(0, ASK_QUESTION_MAX_CODE_POINTS).join('') : text);

type FocusTarget = 'field' | 'title' | 'failure' | 'note';

export interface AskModel {
  readonly state: AskSessionState;
  readonly sourceId: string | null;
  readonly tooLong: boolean;
  readonly canSend: boolean;
  readonly sourceChanged: boolean;
  /** Where the focus is to go and when: the tick makes the same target move the focus again. */
  readonly focus: { readonly target: FocusTarget | undefined; readonly tick: number };
  readonly canAdd: boolean;
  addToGraph(): void;
  /** Escape: the first one cancels a question that is out, a second (or the first when none is out) closes. */
  escape(): void;
  setQuestion(text: string): void;
  send(): void;
  continueRun(): void;
  cancel(): void;
  askAgain(): void;
  retry(): void;
  close(): void;
}

const seconds = (began: number): number => (performance.now() - began) / 1000;

/** The Ask panel's whole behaviour: what it asks, what it shows and the calls behind its buttons. The state is kept outside the panel, so closing it keeps the question and the answer. */
export function useAsk(onClose: () => void): AskModel {
  const client = useApiClient();
  const state = useClientState();
  const session = useAskSession();
  const view = useStoreSelector(session, (held) => held);
  const mask = useSessionMask();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const principalId = usePrincipalIdWhenProvided();
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  const expansions = useExpandStoreWhenProvided();
  const controller = useRef<AbortController | undefined>(undefined);
  const [focus, setFocusState] = useState<{ readonly target: FocusTarget | undefined; readonly tick: number }>({ target: 'field', tick: 0 });
  const setFocus = useCallback((target: FocusTarget): void => setFocusState((held) => ({ target, tick: held.tick + 1 })), []);
  const patch = useCallback((next: Partial<AskSessionState>): void => session.setState({ ...session.getState(), ...next }), [session]);
  const setStage = useCallback((stage: AskStage): void => patch({ stage }), [patch]);

  // a question that is out ends with the panel, and nothing of a late answer is shown
  useEffect(
    () => () => {
      const open = controller.current;
      controller.current = undefined;
      if (open === undefined || open.signal.aborted) return;
      open.abort();
      if (session.getState().stage.kind === 'asking') session.setState({ ...session.getState(), stage: { kind: 'cancelled' } });
    },
    [session],
  );

  // another investigation starts a new session, and a change of masking clears what masking would have shown differently
  useEffect(() => {
    const held = session.getState();
    if (held.investigationId !== investigationId) {
      controller.current?.abort();
      controller.current = undefined;
      session.setState({ ...EMPTY_SESSION, investigationId, mask });
      return;
    }
    if (held.mask === mask) return;
    const stage = held.stage.kind;
    const cleared = stage === 'answered' || stage === 'heavy' || stage === 'asking' || (stage === 'failed' && held.stage.kind === 'failed' && held.stage.heavy !== undefined);
    if (stage === 'asking') {
      controller.current?.abort();
      controller.current = undefined;
    }
    session.setState({ ...held, mask, stage: cleared ? { kind: 'masking-cleared' } : held.stage });
    if (cleared) setFocus('note');
  }, [investigationId, mask, session, setFocus]);

  const settle = useCallback(
    async (call: AskCall, signal: AbortSignal, pending: Promise<ApiResult<AskAnswer>>, heavy: { readonly answer: Answered; readonly token: string } | undefined): Promise<void> => {
      const began = performance.now();
      const result = await pending;
      if (signal.aborted) return;
      controller.current = undefined;
      if (result.ok) {
        if ('refused' in result.value) {
          setStage({ kind: 'refused', refused: result.value.refused });
          setFocus('title');
          return;
        }
        const { answered } = result.value;
        setStage(answered.continueToken === undefined ? { kind: 'answered', answer: answered, seconds: seconds(began), added: undefined } : { kind: 'heavy', answer: answered, token: answered.continueToken, seconds: seconds(began) });
        setFocus('title');
        return;
      }
      if (result.failure.code === 'ABORTED') {
        setStage({ kind: 'idle' });
        return;
      }
      if (call === 'ask' && isNotInThisEdition(result.failure)) {
        setStage({ kind: 'refused', refused: { cause: 'unavailable', sentence: ASK_REFUSAL_SENTENCES.unavailable } });
        setFocus('title');
        return;
      }
      setStage({ kind: 'failed', call, failure: result.failure, heavy });
      setFocus('failure');
    },
    [setFocus, setStage],
  );

  const sendText = useCallback(
    (text: string): void => {
      const held = session.getState();
      if (sourceId === null || held.stage.kind === 'asking' || text.trim() === '' || codePointsOf(text) > ASK_QUESTION_MAX_CODE_POINTS) return;
      controller.current?.abort();
      const open = new AbortController();
      controller.current = open;
      session.setState({ ...held, asked: text, stage: { kind: 'asking', call: 'ask' } });
      void settle('ask', open.signal, client.ask({ sourceId, question: text, ...(mask ? { mask: true as const } : {}) }, open.signal), undefined);
    },
    [client, mask, session, settle, sourceId],
  );

  const continueWith = useCallback(
    (heavy: { readonly answer: Answered; readonly token: string }): void => {
      const held = session.getState();
      if (sourceId === null || held.stage.kind === 'asking') return;
      controller.current?.abort();
      const open = new AbortController();
      controller.current = open;
      session.setState({ ...held, stage: { kind: 'asking', call: 'continue' } });
      void settle('continue', open.signal, client.askContinue({ sourceId, intent: heavy.answer.intent, entities: heavy.answer.entities, continueToken: heavy.token, ...(mask ? { mask: true as const } : {}) }, open.signal), heavy);
    },
    [client, mask, session, settle, sourceId],
  );

  const stage = view.stage;
  const addToGraph = useCallback((): void => {
    const held = session.getState().stage;
    if (held.kind !== 'answered' || held.added !== undefined || sourceId === null || principalId === undefined || sourceChanged) return;
    const addable = addableOf(held.answer.result);
    if (addable === undefined) return;
    const added = addResultToGraph(state, addable, { sourceId, principalId, expansions });
    setStage({ ...held, added });
  }, [expansions, principalId, session, setStage, sourceChanged, sourceId, state]);

  const cancelAsking = (): void => {
    const open = controller.current;
    controller.current = undefined;
    open?.abort();
    if (session.getState().stage.kind === 'asking') {
      setStage({ kind: 'cancelled' });
      setFocus('field');
    }
  };

  const tooLong = codePointsOf(view.question) > ASK_QUESTION_MAX_CODE_POINTS;
  return {
    state: view,
    sourceId,
    tooLong,
    sourceChanged,
    canSend: sourceId !== null && !sourceChanged && stage.kind !== 'asking' && view.question.trim() !== '' && !tooLong,
    focus,
    canAdd: principalId !== undefined && !sourceChanged,
    addToGraph,
    escape: () => (session.getState().stage.kind === 'asking' ? cancelAsking() : onClose()),
    setQuestion: (text) => patch({ question: truncated(text) }),
    send: () => sendText(session.getState().question),
    continueRun: () => (stage.kind === 'heavy' ? continueWith({ answer: stage.answer, token: stage.token }) : undefined),
    cancel: cancelAsking,
    askAgain: () => {
      patch({ question: session.getState().asked });
      sendText(session.getState().asked);
    },
    retry: () => {
      const held = session.getState().stage;
      if (held.kind !== 'failed') return;
      if (held.call === 'continue' && held.heavy !== undefined) continueWith(held.heavy);
      else sendText(session.getState().asked === '' ? session.getState().question : session.getState().asked);
    },
    close: () => {
      onClose();
    },
  };
}


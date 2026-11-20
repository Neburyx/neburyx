import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ASSISTANT_VIEW_KEYS_MAX, type AssistantTurnAnswer, type AssistantTurnRequest } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { addResultToGraph } from '../patterns/add-to-graph.js';
import { addableOf } from '../ask/result-model.js';
import { askFailureWords } from '../ask/ask-failure.js';
import { useAssistantWordLimitWhenProvided, usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState, useSessionMask, useVisibleGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import type { Answered } from '../ask/ask-session.js';
import { citationEntries, type CitationEntry } from '../summary/summary-model.js';
import { isAskAnswer, useAssistantSession, type AssistantSessionState, type Failure, type FollowUp, type Outcome, type Retry, type ViewAnswer } from './assistant-session.js';
import { followUpLabel } from './follow-up-label.js';
import { countWords } from './words.js';
import { isAssistantOff } from './failure-kinds.js';

const MILLISECONDS_A_SECOND = 1000;

/** A refusal that says the investigation or its source is no longer the person's: what the thread shows of it is cleared. */
const isAccessLost = (failure: ApiFailure): boolean => failure.code === 'NOT_FOUND' || (failure.code === 'ACCESS_DENIED' && !isAssistantOff(failure));

export interface AssistantModel {
  readonly state: AssistantSessionState;
  readonly sourceId: string | null;
  readonly title: string;
  readonly limit: number | undefined;
  readonly words: number;
  readonly tooLong: boolean;
  readonly canSend: boolean;
  readonly canCancel: boolean;
  readonly sourceChanged: boolean;
  readonly canAdd: boolean;
  readonly viewTooLarge: boolean;
  /** Where the focus is to go and when: the tick makes the same target move it again. */
  readonly focus: { readonly target: 'input' | number; readonly tick: number };
  setInput(text: string): void;
  send(): void;
  cancel(): void;
  retry(turnId: number): void;
  continueRun(turnId: number): void;
  askAgain(turnId: number): void;
  addToGraph(turnId: number): void;
  cancelClarification(turnId: number): void;
  pickCandidate(turnId: number, index: number): void;
  pressFollowUp(turnId: number, index: number): void;
  /** The turn whose follow-ups are shown: the last one that was answered. */
  readonly followUpsTurn: number | undefined;
  /** A turn is out, so a follow-up cannot be pressed. */
  readonly busy: boolean;
}

/** A failure of a pick leaves the clarification on screen with the failure beside it, so the analyst can pick again; any other failure is the turn's own card. */
function afterFailure(outcome: Outcome, retry: Retry): Outcome {
  if (retry.kind !== 'choice' || outcome.kind !== 'failed' || outcome.failure.kind === 'choice-invalid') return outcome;
  return { kind: 'clarification', question: retry.question, candidates: retry.candidates, failed: { failure: outcome.failure, index: retry.index } };
}

function outcomeOf(answer: AssistantTurnAnswer, retry: Retry, now: number, entriesOf: (answer: ViewAnswer) => readonly CitationEntry[]): Outcome | { readonly tooLong: { readonly words: number; readonly limit: number } } {
  switch (answer.status) {
    case 'answered':
      if (answer.route === 'refuse') return { kind: 'refuse', cause: answer.cause, sentence: answer.sentence };
      if (answer.route === 'view') return { kind: 'view-answer', answer, entries: entriesOf(answer) };
      if (!isAskAnswer(answer.answer)) return { kind: 'ask-refused', refused: answer.answer.refused };
      return answer.answer.answered.continueToken === undefined ? { kind: 'answered', answer: answer.answer.answered, added: undefined, step: answer.step, coverage: answer.coverage, followUps: answer.followUps ?? [] } : { kind: 'heavy', answer: answer.answer.answered, token: answer.answer.answered.continueToken };
    case 'not-answered':
      return { kind: 'not-answered', sentence: answer.sentence };
    case 'unavailable':
      return { kind: 'failed', failure: { kind: 'unavailable', why: answer.kind, readStarted: answer.readStarted, retryAfterSeconds: answer.retryAfterSeconds, until: answer.retryAfterSeconds === undefined ? undefined : now + answer.retryAfterSeconds * MILLISECONDS_A_SECOND }, retry };
    case 'too-large':
      return { kind: 'failed', failure: { kind: 'too-large', sentence: answer.sentence }, retry };
    case 'too-long':
      return { tooLong: { words: answer.words, limit: answer.limit } };
    case 'continue-invalid':
      return { kind: 'failed', failure: { kind: 'continue-invalid' }, retry };
    case 'clarification':
      return { kind: 'clarification', question: answer.question, candidates: answer.candidates };
    case 'choice-invalid':
      return { kind: 'failed', failure: { kind: retry.kind === 'chip' ? 'follow-up-invalid' : 'choice-invalid' }, retry };
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

export function useAssistant(): AssistantModel {
  const client = useApiClient();
  const state = useClientState();
  const { store, open, clear } = useAssistantSession();
  const view = useStoreSelector(store, (held) => held);
  const mask = useSessionMask();
  const graph = useVisibleGraph();
  const limit = useAssistantWordLimitWhenProvided();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const principalId = usePrincipalIdWhenProvided();
  const title = useStoreSelector(state.investigation, (investigation) => investigation.record?.title ?? '');
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  const expansions = useExpandStoreWhenProvided();
  const [focus, setFocusState] = useState<AssistantModel['focus']>({ target: 'input', tick: 0 });
  const setFocus = useCallback((target: AssistantModel['focus']['target']): void => setFocusState((held) => ({ target, tick: held.tick + 1 })), []);
  const keys = useMemo(() => [...drawnKeys(graph)], [graph]);
  const requests = useRef(new Map<number, AbortController>());
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const patch = useCallback((next: Partial<AssistantSessionState>): void => store.setState({ ...store.getState(), ...next }), [store]);
  /** Puts a message back in the composer, never over text the person has typed since. */
  const restoreInput = useCallback((text: string): void => {
    if (store.getState().input.trim() === '') store.setState({ ...store.getState(), input: text });
  }, [store]);

  // the person is kept with the thread, so a thread of another person is cleared when the panel is next opened
  useLayoutEffect(() => {
    if (principalId === undefined) return;
    const held = store.getState();
    if (held.principalId === principalId) return;
    if (held.principalId === null && held.turns.length === 0) patch({ principalId });
    else clear({ principalId });
  }, [clear, patch, principalId, store]);
  const setOutcome = useCallback(
    (turnId: number, outcome: Outcome): void => store.setState({ ...store.getState(), turns: store.getState().turns.map((turn) => (turn.id === turnId ? { ...turn, outcome } : turn)) }),
    [store],
  );

  /** Sends a request for a turn that is already in the thread as pending, and settles the turn with its answer; an answer of an earlier epoch is dropped. */
  const settle = useCallback(
    (turnId: number, request: AssistantTurnRequest, retry: Retry): void => {
      if (sourceId === null) return;
      const epoch = store.getState().epoch;
      const controller = new AbortController();
      open.add(controller);
      requests.current.set(turnId, controller);
      void client.assistantTurn(request, controller.signal).then((result: ApiResult<AssistantTurnAnswer>) => {
        open.delete(controller);
        if (requests.current.get(turnId) === controller) requests.current.delete(turnId);
        if (controller.signal.aborted || store.getState().epoch !== epoch) return;
        if (!result.ok) {
          if (result.failure.code === 'ABORTED') {
            // nothing was sent: the guard that holds reads while the source has changed ended the request
            store.setState({ ...store.getState(), turns: store.getState().turns.filter((turn) => turn.id !== turnId) });
            if (retry.kind === 'message') restoreInput(retry.text);
            return;
          }
          if (isAccessLost(result.failure)) {
            clear({ notice: { kind: 'access-lost' } });
            return;
          }
          const wait = askFailureWords(result.failure, sourceId).waitMs;
          const failure: Failure = { kind: 'request', failure: result.failure, until: wait === undefined ? undefined : Date.now() + wait };
          setOutcome(turnId, afterFailure({ kind: 'failed', failure, retry }, retry));
          if (retry.kind === 'message') restoreInput(retry.text);
          setFocus(turnId);
          return;
        }
        const outcome = outcomeOf(result.value, retry, Date.now(), (answer) => citationEntries(answer, state.visibleGraph()));
        if ('tooLong' in outcome) {
          store.setState({ ...store.getState(), turns: store.getState().turns.filter((turn) => turn.id !== turnId), notice: { kind: 'too-long', ...outcome.tooLong } });
          if (retry.kind === 'message') restoreInput(retry.text);
          setFocus('input');
          return;
        }
        setOutcome(turnId, afterFailure(outcome, retry));
        if (outcome.kind === 'failed' && retry.kind === 'message') restoreInput(retry.text);
        setFocus(turnId);
      });
    },
    [clear, client, open, restoreInput, setFocus, setOutcome, sourceId, state, store],
  );

  const base = useCallback((): Pick<AssistantTurnRequest, 'sourceId' | 'investigationId' | 'viewElementKeys' | 'mask'> | undefined => {
    if (sourceId === null || investigationId === null) return undefined;
    return { sourceId, investigationId, viewElementKeys: keysRef.current, ...(mask ? { mask: true as const } : {}) };
  }, [investigationId, mask, sourceId]);

  const submit = useCallback(
    (text: string, reuse: number | undefined): void => {
      const common = base();
      const held = store.getState();
      if (common === undefined || sourceChanged || held.turns.some((turn) => turn.outcome.kind === 'pending')) return;
      const words = countWords(text);
      if (words === 0) return;
      if (limit !== undefined && words > limit) {
        patch({ notice: { kind: 'too-long', words, limit } });
        return;
      }
      if (keysRef.current.length > ASSISTANT_VIEW_KEYS_MAX) {
        patch({ notice: { kind: 'view-too-large' } });
        return;
      }
      const retry: Retry = { kind: 'message', text };
      let id = reuse;
      if (id === undefined) {
        id = held.nextId;
        store.setState({ ...held, nextId: held.nextId + 1, input: '', notice: undefined, turns: [...held.turns, { id, message: text, outcome: { kind: 'pending', call: 'message' } }] });
      } else setOutcome(id, { kind: 'pending', call: 'message' });
      settle(id, { ...common, message: text }, retry);
    },
    [base, limit, patch, setOutcome, settle, sourceChanged, store],
  );

  const turnOf = (turnId: number) => store.getState().turns.find((turn) => turn.id === turnId);

  const continueFrom = useCallback(
    (turnId: number, heavy: Answered, token: string): void => {
      const common = base();
      if (common === undefined || sourceChanged || keysRef.current.length > ASSISTANT_VIEW_KEYS_MAX || store.getState().turns.some((turn) => turn.outcome.kind === 'pending')) return;
      setOutcome(turnId, { kind: 'pending', call: 'continue', heavy, token });
      settle(turnId, { ...common, continue: { intent: heavy.intent, entities: heavy.entities, continueToken: token } }, { kind: 'continue', intent: heavy.intent, entities: heavy.entities, token, heavy });
    },
    [base, setOutcome, settle, sourceChanged, store],
  );

  const pickFrom = useCallback(
    (turnId: number, index: number): void => {
      const common = base();
      const turn = store.getState().turns.find((held) => held.id === turnId);
      if (turn?.outcome.kind !== 'clarification' || common === undefined || sourceChanged || keysRef.current.length > ASSISTANT_VIEW_KEYS_MAX || store.getState().turns.some((held) => held.outcome.kind === 'pending')) return;
      const candidate = turn.outcome.candidates[index];
      if (candidate === undefined) return;
      const { question, candidates } = turn.outcome;
      setOutcome(turnId, { kind: 'pending', call: 'choice', question, candidates });
      settle(turnId, { ...common, choice: candidate.choice }, { kind: 'choice', question, candidates, index });
    },
    [base, setOutcome, settle, sourceChanged, store],
  );

  /** Runs a follow-up: a new turn whose message is the follow-up's label, sent as the choice the server sealed, or the same turn again when it failed. */
  const pressFrom = useCallback(
    (reuse: number | undefined, followUp: FollowUp): void => {
      const common = base();
      const held = store.getState();
      if (common === undefined || sourceChanged || keysRef.current.length > ASSISTANT_VIEW_KEYS_MAX || held.turns.some((turn) => turn.outcome.kind === 'pending')) return;
      let id = reuse;
      if (id === undefined) {
        id = held.nextId;
        store.setState({ ...held, nextId: held.nextId + 1, notice: undefined, turns: [...held.turns, { id, message: followUpLabel(followUp), chip: true, outcome: { kind: 'pending', call: 'message' } }] });
      } else setOutcome(id, { kind: 'pending', call: 'message' });
      settle(id, { ...common, choice: followUp.choice }, { kind: 'chip', followUp });
    },
    [base, setOutcome, settle, sourceChanged, store],
  );

  const words = countWords(view.input);
  const tooLong = limit !== undefined && words > limit;
  return {
    state: view,
    sourceId,
    title,
    limit,
    words,
    tooLong,
    sourceChanged,
    canSend: limit !== undefined && sourceId !== null && investigationId !== null && !sourceChanged && keys.length <= ASSISTANT_VIEW_KEYS_MAX && !view.turns.some((turn) => turn.outcome.kind === 'pending') && words > 0 && !tooLong,
    canCancel: view.turns.some((turn) => turn.outcome.kind === 'pending'),
    busy: view.turns.some((turn) => turn.outcome.kind === 'pending'),
    followUpsTurn: [...view.turns].reverse().find((turn) => turn.outcome.kind === 'answered')?.id,
    canAdd: principalId !== undefined && !sourceChanged,
    focus,
    setInput: (text) => patch({ input: text, notice: view.notice?.kind === 'too-long' ? undefined : view.notice }),
    viewTooLarge: keys.length > ASSISTANT_VIEW_KEYS_MAX,
    send: () => submit(store.getState().input, undefined),
    cancel: () => {
      const turn = store.getState().turns.find((held) => held.outcome.kind === 'pending');
      const controller = turn === undefined ? undefined : requests.current.get(turn.id);
      if (turn === undefined || controller === undefined) return;
      controller.abort();
      open.delete(controller);
      requests.current.delete(turn.id);
      if (turn.outcome.kind === 'pending' && turn.outcome.call === 'continue') {
        setOutcome(turn.id, { kind: 'heavy', answer: turn.outcome.heavy, token: turn.outcome.token });
        setFocus(turn.id);
        return;
      }
      if (turn.outcome.kind === 'pending' && turn.outcome.call === 'choice') {
        setOutcome(turn.id, { kind: 'clarification', question: turn.outcome.question, candidates: turn.outcome.candidates });
        setFocus(turn.id);
        return;
      }
      setOutcome(turn.id, { kind: 'cancelled' });
      if (turn.chip !== true) restoreInput(turn.message);
      setFocus('input');
    },
    retry: (turnId) => {
      const turn = turnOf(turnId);
      if (turn?.outcome.kind === 'clarification' && turn.outcome.failed !== undefined) {
        pickFrom(turnId, turn.outcome.failed.index);
        return;
      }
      if (turn?.outcome.kind !== 'failed') return;
      const { retry } = turn.outcome;
      if (retry.kind === 'continue') continueFrom(turnId, retry.heavy, retry.token);
      else if (retry.kind === 'message') submit(retry.text, turnId);
      else if (retry.kind === 'chip') pressFrom(turnId, retry.followUp);
    },
    continueRun: (turnId) => {
      const turn = turnOf(turnId);
      if (turn?.outcome.kind === 'heavy') continueFrom(turnId, turn.outcome.answer, turn.outcome.token);
    },
    askAgain: (turnId) => {
      const turn = turnOf(turnId);
      if (turn !== undefined) submit(turn.message, turnId);
    },
    pickCandidate: pickFrom,
    pressFollowUp: (turnId, index) => {
      const turn = turnOf(turnId);
      const followUp = turn?.outcome.kind === 'answered' ? turn.outcome.followUps[index] : undefined;
      if (followUp !== undefined) pressFrom(undefined, followUp);
    },
    cancelClarification: (turnId) => {
      const turn = turnOf(turnId);
      if (turn?.outcome.kind !== 'clarification') return;
      setOutcome(turnId, { kind: 'cancelled' });
      restoreInput(turn.message);
      setFocus('input');
    },
    addToGraph: (turnId) => {
      const turn = turnOf(turnId);
      if (turn?.outcome.kind !== 'answered' || turn.outcome.added !== undefined || sourceId === null || principalId === undefined || sourceChanged) return;
      const addable = addableOf(turn.outcome.answer.result);
      if (addable === undefined) return;
      setOutcome(turnId, { ...turn.outcome, added: addResultToGraph(state, addable, { sourceId, principalId, expansions }) });
    },
  };
}

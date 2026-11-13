import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import type { AskRunAnswer } from '../api/client.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { addResultToGraph, type AddedOutcome } from '../patterns/add-to-graph.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import { buildParams, editFieldsOf, initialValues, type EditErrors, type EditField, type EditValues } from './plan-edit-model.js';
import { planFailureWords, type PlanCall, type PlanFailureWords } from './plan-failure.js';
import { PLAN_COPY } from './plan-copy.js';
import type { TemplatePlan } from './plan-model.js';
import { addableOf } from './plan-result-model.js';
import { ASK_PLAN_TEMPLATE_IDS } from '@neburyx/contracts';
import type { AskPanel } from './use-ask.js';
import { planOut } from './plan-activity.js';

export interface Current {
  readonly plan: TemplatePlan;
  readonly planId: string;
  readonly expiresAt: string;
}

export type Stage =
  | { readonly kind: 'review'; readonly status: string }
  | { readonly kind: 'working'; readonly call: PlanCall }
  | { readonly kind: 'result'; readonly seconds: number; readonly outcome: 'complete' | 'partial'; readonly run: AskRunAnswer; readonly added: AddedOutcome | undefined }
  | { readonly kind: 'heavy'; readonly seconds: number; readonly run: AskRunAnswer; readonly token: string }
  | { readonly kind: 'failed'; readonly call: PlanCall; readonly words: PlanFailureWords }
  | { readonly kind: 'editing'; readonly fields: readonly EditField[]; readonly values: EditValues; readonly errors: EditErrors; readonly failure: PlanFailureWords | undefined; readonly saving: boolean }
  | { readonly kind: 'cancelled' };

export interface PlanPanel {
  readonly current: Current;
  readonly stage: Stage;
  readonly profile: SourceProfile | undefined;
  /** The sentence the status region says for the stage. */
  readonly status: string;
  run(): void;
  continueRun(): void;
  edit(): void;
  setValue(key: string, value: string | readonly string[]): void;
  save(): void;
  back(): void;
  cancel(): void;
  askAgain(): void;
  runAgain(): void;
  retry(): void;
  addToGraph(): void;
  canAdd: boolean;
}

/** The plan card's whole behaviour: what it shows now, and the calls behind its buttons. Nothing is requested until a button is pressed. */
export function usePlan(ask: AskPanel, plan: TemplatePlan, planId: string, expiresAt: string): PlanPanel {
  const client = useApiClient();
  const state = useClientState();
  const mask = useSessionMask();
  const profile = useProfileWhenProvided();
  const expansions = useExpandStoreWhenProvided();
  const principalId = usePrincipalIdWhenProvided();
  const sourceId = ask.sourceId ?? '';
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const [current, setCurrent] = useState<Current>({ plan, planId, expiresAt });
  const [stage, setStage] = useState<Stage>({ kind: 'review', status: PLAN_COPY.ready });
  const guard = useRef(false);
  const out = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const held = useRef(current);
  held.current = current;
  const stageRef = useRef<Stage>({ kind: 'review', status: PLAN_COPY.ready });
  const context = useRef({ investigationId, sourceId });
  context.current = { investigationId, sourceId };

  // a plan that is not the one drawn (a new question, a new answer) starts the card again, and what is in flight no longer counts
  useEffect(() => {
    epoch.current += 1;
    guard.current = false;
    setCurrent({ plan, planId, expiresAt });
    setStage({ kind: 'review', status: PLAN_COPY.ready });
  }, [plan, planId, expiresAt]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // a card that goes away with a call out no longer keeps the panel from closing
      if (out.current) planOut.setState(false);
    };
  }, []);

  /** Runs one call; its answer is dropped when the plan, the question or the investigation changed while it was out, and a call the client did not send leaves the card as it was. */
  const call = useCallback(
    async <T extends { readonly ok: boolean }>(kind: PlanCall, start: () => Promise<T>, apply: (value: T, seconds: number) => void): Promise<void> => {
      if (guard.current) return;
      guard.current = true;
      const startedIn = epoch.current;
      const startedAt = { ...context.current };
      const before = stageRef.current;
      const began = performance.now();
      setStage({ kind: 'working', call: kind });
      // a call that is out keeps the panel open: it cannot be taken back once the server has the plan
      planOut.setState(true);
      out.current = true;
      let value: T;
      try {
        value = await start();
      } finally {
        out.current = false;
        planOut.setState(false);
        if (startedIn === epoch.current) guard.current = false;
      }
      const moved = startedAt.investigationId !== context.current.investigationId || startedAt.sourceId !== context.current.sourceId;
      if (!mounted.current || startedIn !== epoch.current || moved) {
        if (kind === 'run' || kind === 'continue') ask.noteMayHaveRun();
        return;
      }
      if (!value.ok && 'failure' in value && (value.failure as { readonly code?: string }).code === 'ABORTED') return setStage(before);
      apply(value, (performance.now() - began) / 1000);
    },
    [ask],
  );

  const fail = useCallback((kind: PlanCall, failure: Parameters<typeof planFailureWords>[0]): void => setStage({ kind: 'failed', call: kind, words: planFailureWords(failure, sourceId, kind, held.current.plan.templateId === 'saved-pattern') }), [sourceId]);

  const maskNow = useRef(mask);
  maskNow.current = mask;

  const runWith = useCallback(
    (kind: 'run' | 'continue', token?: string): void => {
      const sentWith = mask;
      void call(
        kind,
        () => client.askRun({ planId: held.current.planId, ...(mask ? { mask: true } : {}), ...(token === undefined ? {} : { continue: true as const, continueToken: token }) }),
        (result, seconds) => {
          if (!result.ok) return fail(kind, result.failure);
          // masking was changed while the call was out: the answer was read under the other setting, so it is not drawn
          if (maskNow.current !== sentWith) return setStage({ kind: 'failed', call: kind, words: { text: PLAN_COPY.maskChanged, action: 'ask-again' } });
          const run = result.value;
          if (run.continueToken !== undefined) return setStage({ kind: 'heavy', seconds, run, token: run.continueToken });
          setStage({ kind: 'result', seconds, outcome: run.outcome, run, added: undefined });
        },
      );
    },
    [call, client, fail, mask],
  );

  // masking changed while a result is shown: the result was read under the other setting, so it is cleared as the patterns panel clears its own
  const maskAtRun = useRef(mask);
  useEffect(() => {
    if (maskAtRun.current !== mask && (stage.kind === 'result' || stage.kind === 'heavy')) setStage({ kind: 'failed', call: 'run', words: { text: PLAN_COPY.maskChanged, action: 'ask-again' } });
    maskAtRun.current = mask;
  }, [mask, stage.kind]);

  const run = useCallback((): void => runWith('run'), [runWith]);

  stageRef.current = stage;
  const panel: PlanPanel = {
    current,
    stage,
    profile,
    status: statusOf(stage),
    run,
    continueRun: () => {
      if (stage.kind === 'heavy') runWith('continue', stage.token);
    },
    edit: () => {
      const fields = editFieldsOf(held.current.plan, profile);
      if (fields.length === 0) return setStage({ kind: 'failed', call: 'edit', words: { text: isKnownTemplate(held.current.plan.templateId) ? PLAN_COPY.nothingToEdit : PLAN_COPY.cannotEdit, action: 'ask-again' } });
      setStage({ kind: 'editing', fields, values: initialValues(held.current.plan, fields), errors: {}, failure: undefined, saving: false });
    },
    setValue: (key, value) => setStage((now) => (now.kind === 'editing' ? { ...now, values: { ...now.values, [key]: value }, errors: omit(now.errors, key), failure: undefined } : now)),
    save: () => {
      if (stage.kind !== 'editing' || stage.saving) return;
      const built = buildParams(held.current.plan, stage.fields, stage.values, sourceId);
      if (!built.ok) return setStage({ ...stage, errors: built.errors });
      const editing = stage;
      void call(
        'edit',
        () => client.askEdit({ planId: held.current.planId, templateId: held.current.plan.templateId, params: built.params }),
        (result) => {
          if (!result.ok) {
            const words = planFailureWords(result.failure, sourceId, 'edit', held.current.plan.templateId === 'saved-pattern');
            // a plan that cannot be used any more is spent and ends the edit; any other refusal keeps what was typed, with the words beside it, and Save sends the same edit again
            return words.action === 'ask-again' ? setStage({ kind: 'failed', call: 'edit', words }) : setStage({ ...editing, failure: words, saving: false });
          }
          const next = result.value;
          setCurrent({ plan: next.plan, planId: next.planId, expiresAt: next.expiresAt });
          setStage({ kind: 'review', status: PLAN_COPY.changed });
        },
      );
      setStage({ ...editing, saving: true });
    },
    back: () => setStage({ kind: 'review', status: PLAN_COPY.ready }),
    cancel: () => {
      void call(
        'cancel',
        () => client.askCancel({ planId: held.current.planId }),
        (result) => (result.ok ? setStage({ kind: 'cancelled' }) : fail('cancel', result.failure)),
      );
    },
    askAgain: () => ask.askAgain(),
    runAgain: () => setStage({ kind: 'review', status: PLAN_COPY.ready }),
    retry: () => {
      if (stage.kind === 'failed' && stage.call === 'cancel') panel.cancel();
    },
    addToGraph: () => {
      if (stage.kind !== 'result' || stage.added !== undefined || principalId === undefined) return;
      const addable = addableOf(stage.run.result);
      if (addable === undefined) return;
      setStage({ ...stage, added: addResultToGraph(state, addable, { sourceId, principalId, expansions }) });
    },
    canAdd: stage.kind === 'result' && principalId !== undefined && addableOf(stage.run.result) !== undefined,
  };
  return panel;
}

const isKnownTemplate = (id: string): boolean => (ASK_PLAN_TEMPLATE_IDS as readonly string[]).includes(id);

function omit(errors: EditErrors, key: string): EditErrors {
  const { [key]: _gone, ...rest } = errors;
  return rest;
}

function statusOf(stage: Stage): string {
  switch (stage.kind) {
    case 'review':
      return stage.status;
    case 'working':
      return stage.call === 'run' ? PLAN_COPY.running : stage.call === 'continue' ? PLAN_COPY.continuing : stage.call === 'cancel' ? PLAN_COPY.cancelling : PLAN_COPY.saving;
    case 'failed':
      return stage.words.text;
    case 'cancelled':
      return PLAN_COPY.cancelled;
    case 'heavy':
      return PLAN_COPY.heavyTitle;
    case 'editing':
      return stage.saving ? PLAN_COPY.saving : '';
    case 'result':
      return '';
  }
}

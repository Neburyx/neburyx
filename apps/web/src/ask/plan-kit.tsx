import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AskCancelRequest, AskEditRequest, AskPlan, AskPlanRequest, AskRunRequest } from '@neburyx/contracts';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { clientWith, me, staticProfile } from '../test-utils.js';
import { ApiClientProvider } from '../api/client-context.js';
import type { ApiClient, ApiResult, AskCancelAnswer, AskEditAnswer, AskPlanAnswer, AskRunAnswer } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { AskPanel } from './ask-panel.js';
import { field, HASH, previewOf, SOURCE } from './ask-kit.js';

export interface Held<Request, Answer> {
  readonly request: Request;
  answer(result: ApiResult<Answer>): void;
}

export const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';
export const EXPIRES = '2026-11-13T10:15:00.000Z';
export const TOKEN = 'c'.repeat(64);
export const NODE = (stableId: string, entityType = 'widget') => ({
  ref: { sourceId: SOURCE, entityType, stableId },
  display: { title: `Widget ${stableId}`, type: entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

export const sharedPlan = (over: Record<string, unknown> = {}): AskPlan => ({ kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, rationale: 'Widgets that share a gadget.', params: { ref: { entityType: 'widget', stableId: 'w-1' }, attributeType: 'gadget', via: 'HOLDS', window: { days: 30 }, limit: 25, ...over } }) as AskPlan;

export const count = (quality: 'exact' | 'estimated' | 'lowerBound' | 'unknown', value = 2) => (quality === 'unknown' ? { quality, scope: 'test' } : { quality, value, scope: 'test' });
export const sharedResult = (quality: 'exact' | 'estimated' | 'lowerBound' | 'unknown' = 'exact'): AskRunAnswer => ({
  planId: PLAN_ID,
  outcome: quality === 'lowerBound' ? 'partial' : 'complete',
  result: { templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: count(quality), matchIds: [NODE('w-2').ref], nodes: [NODE('w-1'), NODE('w-2')], edges: [], notices: quality === 'lowerBound' ? [{ code: 'readBounded' }] : [], warnings: [] } },
}) as AskRunAnswer;
export const heavyResult = (): AskRunAnswer => ({
  planId: PLAN_ID,
  outcome: 'partial',
  result: { templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } },
  continueToken: TOKEN,
}) as AskRunAnswer;

export interface PlanHarness {
  readonly state: ClientState;
  readonly asks: Held<AskPlanRequest, AskPlanAnswer>[];
  readonly runs: Held<AskRunRequest, AskRunAnswer>[];
  readonly edits: Held<AskEditRequest, AskEditAnswer>[];
  readonly cancels: Held<AskCancelRequest, AskCancelAnswer>[];
  readonly client: ApiClient;
}

const held = <R, A>(list: Held<R, A>[]) => (request: R): Promise<ApiResult<A>> => new Promise((resolve) => list.push({ request, answer: resolve }));

export function planClient(): Omit<PlanHarness, 'state'> {
  const asks: PlanHarness['asks'] = [];
  const runs: PlanHarness['runs'] = [];
  const edits: PlanHarness['edits'] = [];
  const cancels: PlanHarness['cancels'] = [];
  const client = fakeClient({ askPlan: held(asks), askRun: held(runs), askEdit: held(edits), askCancel: held(cancels) });
  return { asks, runs, edits, cancels, client };
}

export const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

export async function answer<R, A>(sent: Held<R, A> | undefined, result: ApiResult<A>): Promise<void> {
  if (sent === undefined) throw new Error('no request was sent');
  await act(async () => {
    sent.answer(result);
    await Promise.resolve();
  });
}

/** Draws the Ask panel, asks a question, confirms the preview and has the server answer a plan: the card is on screen and nothing has been run. */
export async function drawPlan(plan: AskPlan = sharedPlan(), options: { readonly state?: ClientState; readonly planId?: string; readonly shell?: boolean; readonly profile?: boolean } = {}): Promise<PlanHarness> {
  const parts = planClient();
  const state = options.state ?? createClientState();
  state.bindSource(SOURCE);
  const panel = <AskPanel />;
  const withProfile = options.profile === true ? <ProfileProvider store={staticProfile(SOURCE, { ...testProfile(SOURCE, ['widget', 'gadget', 'part']), relationshipTypes: [{ type: 'HOLDS', from: 'gadget', to: 'widget', aggregate: false, observedAt: null, filterable: [], sortable: [], evidence: [], properties: [], stableIdProperty: null } as never] })}>{panel}</ProfileProvider> : panel;
  const withShell = options.shell === true ? <ShellDataProvider store={createShellData(clientWith({ me: me(), sources: [] }))}>{withProfile}</ShellDataProvider> : withProfile;
  render(
    <ApiClientProvider client={parts.client}>
      <ClientStateProvider state={state}>{withShell}</ClientStateProvider>
    </ApiClientProvider>,
  );
  if (options.shell === true) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await userEvent.type(field(), 'which widgets');
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await answer(parts.asks[0], previewOf('which widgets'));
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await answer(parts.asks[1], ok(plan.kind === 'plan' ? { plan, planId: options.planId ?? PLAN_ID, expiresAt: EXPIRES } : { plan }) as ApiResult<AskPlanAnswer>);
  return { state, ...parts };
}

export const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
export const hasButton = (name: string): boolean => screen.queryByRole('button', { name }) !== null;
export { cleanup, HASH };

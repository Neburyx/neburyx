import type { TurnStep } from '../api/turn-stream.js';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, type AssistantThreadClearResponse, type AssistantThreadResponse, type AssistantTurnAnswer, type AssistantTurnRequest, type ReadRefsRequest, type ReadRefsResponse } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiResult } from '../api/client.js';
import { ApiClientProvider } from '../api/client-context.js';
import { ShellDataProvider, createShellData } from '../shell/shell-data.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { aiStatus, me } from '../test-utils.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { AssistantPanel } from './assistant-panel.js';
import type { ClearNotice } from './clear-notice.js';
import { AssistantSessionProvider, createAssistantSession } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';

export const RECORD = { title: 'Suspicious linked accounts', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } };
export const REFUSE: AssistantTurnAnswer = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict };
export const VIEW: AssistantTurnAnswer = { status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };

export type TurnCall = (request: AssistantTurnRequest, signal: AbortSignal | undefined, onStep?: (step: TurnStep) => void) => Promise<ApiResult<AssistantTurnAnswer>>;

export type ThreadCall = (investigationId: string, signal: AbortSignal | undefined, mask: boolean) => Promise<ApiResult<AssistantThreadResponse>>;
const EMPTY_THREAD: ThreadCall = async () => ({ ok: true, value: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } });

export type ClearCall = (investigationId: string, signal: AbortSignal | undefined) => Promise<ApiResult<AssistantThreadClearResponse>>;
const CLEARED: ClearCall = async () => ({ ok: true, value: { cleared: true } });

export type ReadRefsCall = (request: ReadRefsRequest, signal: AbortSignal | undefined) => Promise<ApiResult<ReadRefsResponse>>;
const NO_REFS: ReadRefsCall = async () => ({ ok: true, value: { nodes: [], edges: [], missing: { entities: [], edges: [] } } });

export interface HarnessOptions {
  /** The channel to other windows; none by default. */
  readonly notice?: ClearNotice;
  /** The count the server tells with each answer (the header), when the response begins; none by default. */
  readonly turnEpoch?: number;
}

export function harness(turn: TurnCall, limit: number | null = 1000, thread: ThreadCall = EMPTY_THREAD, summary = false, refs: ReadRefsCall = NO_REFS, clear: ClearCall = CLEARED, options: HarnessOptions = {}) {
  const state = createClientState();
  state.bindSource('a');
  state.show({ id: 'inv-1', sourceId: 'a', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
  const session = createAssistantSession(options.notice ?? null);
  const tools = createToolRegistry();
  const sent: AssistantTurnRequest[] = [];
  const reads: string[] = [];
  const askedRefs: ReadRefsRequest[] = [];
  const clears: string[] = [];
  const asked: { investigationId: string; mask: boolean }[] = [];
  const client = fakeClient({
    readRefs: async (request, signal) => {
      askedRefs.push(request);
      return refs(request, signal);
    },
    assistantTurn: async (request, signal, onStep, onEpoch) => {
      sent.push(request);
      if (options.turnEpoch !== undefined) onEpoch?.(options.turnEpoch);
      return turn(request, signal, onStep);
    },
    clearAssistantThread: async (investigationId, signal) => {
      clears.push(investigationId);
      return clear(investigationId, signal);
    },
    assistantThread: async (investigationId, mask, signal) => {
      reads.push(investigationId);
      asked.push({ investigationId, mask });
      return thread(investigationId, signal, mask);
    },
  });
  const status = aiStatus({ summary, ...(limit === null ? {} : { assistant: limit }) });
  const shell = createShellData(fakeClient({ getAiStatus: async () => ({ ok: true, value: status }), getMe: async () => ({ ok: true, value: me({}) }), getSources: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) }));
  const tree = (open = true) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <ShellDataProvider store={shell}>
          <ToolsProvider registry={tools}>
            <AssistantSessionProvider value={session}>{open ? <AssistantPanel onClose={() => undefined} /> : null}</AssistantSessionProvider>
          </ToolsProvider>
        </ShellDataProvider>
      </ClientStateProvider>
    </ApiClientProvider>
  );
  return { tree, client, sent, reads, asked, askedRefs, clears, session, state, shell, tools };
}

export const typeAndSend = async (text: string) => {
  const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
  await userEvent.type(field, `${text}{Enter}`);
};

export const messageOf = (request: AssistantTurnRequest | undefined): string | undefined => (request !== undefined && 'message' in request ? request.message : undefined);
export const continueOf = (request: AssistantTurnRequest | undefined) => (request !== undefined && 'continue' in request ? request.continue : undefined);

import type { AiMappingView } from '@neburyx/contracts';
import { PlannerCallFailed } from '../planner/index.js';
import { COMMON_WORDS_VERSION } from '../allowlist/index.js';
import type { FailureCode, ModelProvider, ModelRequest, TokenUsage } from '../provider.js';
import { EVAL_ACTOR, plannerOver, type Replay, type ReplayEntry } from './replay-planner.js';

export interface RecorderOptions {
  readonly view: AiMappingView;
  /** The provider the calls go to: a real one, or a fixture in a test. */
  readonly provider: ModelProvider;
  /** What the run shares across its recorders: the budget and the tallies. */
  readonly ledger: Ledger;
}

export type RecordOutcome = 'recorded' | 'blocked' | 'failed' | 'stopped';

export interface RunRecord {
  readonly model: string;
  readonly listVersion: string;
  readonly calls: number;
  readonly budget: number;
  readonly recorded: number;
  readonly stoppedByBudget: boolean;
  readonly failures: readonly { readonly id: string; readonly code: FailureCode }[];
  readonly prompts: readonly { readonly id: string; readonly version: number }[];
  readonly tokens: { readonly in: number; readonly out: number; readonly cacheRead: number; readonly cacheWrite: number; readonly callsWithoutCounts: number };
}

export interface Ledger {
  readonly budget: number;
  readonly model: string;
  /** A call the budget allows is counted here before it is made; a call that would exceed it is refused. */
  admit(): boolean;
  stop(): void;
  tally(usage: TokenUsage | undefined): void;
  prompt(id: string, version: number): void;
  failed(id: string, code: FailureCode): void;
  recorded(): void;
  run(): RunRecord;
}

/** The count of calls, tokens, prompts and failures of one run, shared by the recorders of its mappings so the budget is one. */
export function createLedger(budget: number, model: string): Ledger {
  const failures: { id: string; code: FailureCode }[] = [];
  const prompts = new Map<string, number>();
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, callsWithoutCounts: 0 };
  let calls = 0;
  let recorded = 0;
  let stopped = false;
  return {
    budget,
    model,
    admit() {
      if (calls >= budget) return false;
      calls += 1;
      return true;
    },
    stop() {
      stopped = true;
    },
    tally(usage) {
      if (usage === undefined || usage.kind !== 'known') {
        tokens.callsWithoutCounts += 1;
        return;
      }
      tokens.in += usage.inputTokens;
      tokens.out += usage.outputTokens;
      tokens.cacheRead += usage.cacheReadTokens ?? 0;
      tokens.cacheWrite += usage.cacheWriteTokens ?? 0;
    },
    prompt: (id, version) => void prompts.set(id, version),
    failed: (id, code) => void failures.push({ id, code }),
    recorded: () => void (recorded += 1),
    run: () => ({ model, listVersion: COMMON_WORDS_VERSION, calls, budget, recorded, stoppedByBudget: stopped, failures: [...failures], prompts: [...prompts].map(([id, version]) => ({ id, version })).sort((x, y) => x.id.localeCompare(y.id)), tokens: { ...tokens } }),
  };
}

export interface Recorder {
  /** The text the planner is given for a wording, or undefined when the allowlist blocks it. */
  rebuild(wording: string): string | undefined;
  record(id: string, wording: string): Promise<RecordOutcome>;
  /** The replay of the questions fully answered; a failed or stopped question is not in it. */
  replay(): Replay;
}

class BudgetReached extends Error {}

interface Pending {
  plan?: string;
  repair?: string;
  refused?: true;
  failure?: FailureCode;
}

/** Records the replies of a planner over a provider, never past the budget: a call that would exceed it is not made. A call that fails counts and is not retried here. */
export async function createRecorder(options: RecorderOptions): Promise<Recorder> {
  const { ledger } = options;
  const entries = new Map<string, ReplayEntry>();
  let pending: Pending = {};

  const counting: ModelProvider = {
    async complete(request: ModelRequest, signal: AbortSignal) {
      if (!ledger.admit()) {
        ledger.stop();
        throw new BudgetReached();
      }
      const answer = await options.provider.complete(request, signal);
      ledger.prompt(answer.prompt.id, answer.prompt.version);
      ledger.tally(answer.usage);
      const isRepair = request.promptId === 'ask.plan.repair';
      if (answer.status === 'ok') pending[isRepair ? 'repair' : 'plan'] = answer.text;
      else if (answer.status === 'refused') {
        pending.plan = '';
        pending.refused = true;
      } else pending.failure = answer.code;
      return answer;
    },
  };

  const { planner, rebuild } = await plannerOver(options.view, () => counting, ledger.model);

  return {
    rebuild,
    async record(id, wording) {
      const text = rebuild(wording);
      if (text === undefined) return 'blocked';
      pending = {};
      try {
        await planner.plan({ text, context: { actorId: EVAL_ACTOR, actorRole: 'investigator', traceId: 'eval' } });
      } catch (error) {
        if (error instanceof BudgetReached) return 'stopped';
        if (error instanceof PlannerCallFailed) {
          ledger.failed(id, pending.failure ?? error.code);
          return 'failed';
        }
        throw error;
      }
      entries.set(text, { plan: pending.plan ?? '', ...(pending.repair === undefined ? {} : { repair: pending.repair }), ...(pending.refused === true ? { refused: true as const } : {}) });
      ledger.recorded();
      return 'recorded';
    },
    replay: () => Object.fromEntries(entries),
  };
}

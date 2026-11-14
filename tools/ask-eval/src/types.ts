import type { AiMappingView, AskPlan } from '@neburyx/contracts';
import { z } from 'zod';

export const replaySchema = z.record(z.string(), z.strictObject({ plan: z.string(), repair: z.string().optional(), refused: z.literal(true).optional() }));

export type Replay = z.infer<typeof replaySchema>;

export type PlannerAnswer =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'no-reply'; readonly call: 'plan' | 'repair' }
  | { readonly kind: 'answered'; readonly plan: AskPlan; readonly repaired: boolean };

export interface QuestionPlanner {
  rebuild(wording: string): string | undefined;
  answer(wording: string): Promise<PlannerAnswer>;
}

export interface RunRecord {
  readonly model: string;
  readonly listVersion: string;
  readonly calls: number;
  readonly budget: number;
  readonly recorded: number;
  readonly stoppedByBudget: boolean;
  readonly failures: readonly { readonly id: string; readonly code: string }[];
  readonly prompts: readonly { readonly id: string; readonly version: number }[];
  readonly tokens: { readonly in: number; readonly out: number; readonly cacheRead: number; readonly cacheWrite: number; readonly callsWithoutCounts: number };
}

export interface Ledger {
  run(): RunRecord;
}

export interface Recorder {
  rebuild(wording: string): string | undefined;
  record(id: string, wording: string): Promise<'recorded' | 'blocked' | 'failed' | 'stopped'>;
  replay(): Replay;
}

/** What a recording run needs from the planner's package: the budgeted recorder, and the provider the calls go to (built from the mapping's settings, or a fixture in a test). */
export interface RecordingModule {
  createLedger(budget: number, model: string): Ledger;
  createRecorder(options: { readonly view: AiMappingView; readonly provider: unknown; readonly ledger: Ledger }): Promise<Recorder>;
  provider(options: { readonly mapping: string; readonly ai: string | undefined; readonly model: string | undefined }): Promise<{ readonly provider: unknown; readonly model: string }>;
}

export interface PlannerModule {
  createEvalPlanner(options: { readonly view: AiMappingView; readonly replay: Replay }): Promise<QuestionPlanner>;
  readonly recording?: RecordingModule;
}

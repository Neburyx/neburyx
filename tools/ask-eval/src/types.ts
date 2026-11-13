import type { AiMappingView, AskPlan } from '@neburyx/contracts';
import { z } from 'zod';

export const replaySchema = z.record(z.string(), z.strictObject({ plan: z.string(), repair: z.string().optional() }));

export type Replay = z.infer<typeof replaySchema>;

export type PlannerAnswer =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'no-reply'; readonly call: 'plan' | 'repair' }
  | { readonly kind: 'answered'; readonly plan: AskPlan; readonly repaired: boolean };

export interface QuestionPlanner {
  rebuild(wording: string): string | undefined;
  answer(wording: string): Promise<PlannerAnswer>;
}

export interface PlannerModule {
  createEvalPlanner(options: { readonly view: AiMappingView; readonly replay: Replay }): Promise<QuestionPlanner>;
}

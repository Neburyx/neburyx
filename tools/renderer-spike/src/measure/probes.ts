import { z } from 'zod';
import type { GroupState } from '../adapter.js';

export const GROUPED_TYPE = 'type-b';
export const KEYBOARD_KEYS = ['Tab', 'ArrowRight', 'ArrowRight', 'Enter', 'End', 'ArrowRight', 'ArrowLeft', 'Home', 'Tab', 'ArrowRight', 'Enter'] as const;

export const keyboardStateSchema = z.strictObject({
  focusedId: z.string().nullable(),
  ringVisible: z.boolean(),
  activatedId: z.string().nullable(),
  canvasFocused: z.boolean(),
  announced: z.string(),
});

export const keyboardStepSchema = keyboardStateSchema.extend({ key: z.string().min(1) });

export const keyboardResultSchema = z.strictObject({
  steps: z.array(keyboardStepSchema).min(1),
  wrapsFromLast: z.boolean(),
  ignoredWithoutFocus: z.boolean(),
});

export const groupingResultSchema = z.strictObject({
  typeId: z.string().min(1),
  supported: z.boolean(),
  members: z.number().int().nonnegative(),
  nodesBefore: z.number().int().positive(),
  nodesWhileGrouped: z.number().int().positive(),
  nodesAfter: z.number().int().positive(),
  restored: z.boolean(),
});

export type KeyboardState = z.infer<typeof keyboardStateSchema>;
export type KeyboardResult = z.infer<typeof keyboardResultSchema>;
export type GroupingResult = z.infer<typeof groupingResultSchema>;

export interface GroupingSnapshot {
  readonly supported: boolean;
  readonly nodesDrawn: number;
  readonly groups: readonly GroupState[];
}

export function summarizeGrouping(typeId: string, before: GroupingSnapshot, grouped: GroupingSnapshot, after: GroupingSnapshot): GroupingResult {
  const members = grouped.groups.find((group) => group.typeId === typeId)?.members ?? 0;
  return {
    typeId,
    supported: grouped.supported,
    members,
    nodesBefore: before.nodesDrawn,
    nodesWhileGrouped: grouped.nodesDrawn,
    nodesAfter: after.nodesDrawn,
    restored: after.nodesDrawn === before.nodesDrawn && after.groups.length === 0,
  };
}

export function summarizeKeyboard(keys: readonly string[], states: readonly KeyboardState[]): KeyboardResult {
  const steps = states.map((state, index) => ({ key: keys[index] ?? '', ...state }));
  const firstId = steps[keys.indexOf('Home')]?.focusedId ?? null;
  const afterLast = steps[keys.indexOf('End') + 1]?.focusedId ?? null;
  const leaving = keys.lastIndexOf('Tab');
  const outside = steps.slice(leaving + 1);
  return {
    steps,
    wrapsFromLast: firstId !== null && afterLast === firstId,
    ignoredWithoutFocus: outside.length > 0 && outside.every((step) => !step.canvasFocused && !step.ringVisible && step.activatedId === null),
  };
}

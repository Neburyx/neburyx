/** The AI features that can be switched off one by one. */
export const AI_FEATURES = ['ask', 'summary', 'assistant'] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export type AiFeatureSwitches = Readonly<Record<AiFeature, boolean>>;

/** Every feature is on unless it is named off. */
export function featureSwitches(given: Partial<AiFeatureSwitches> = {}): AiFeatureSwitches {
  return { ask: given.ask ?? true, summary: given.summary ?? true, assistant: given.assistant ?? true };
}

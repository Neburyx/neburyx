import type { AiActionName } from './ai-actions.js';

export const AI_LABELS: Readonly<Record<AiActionName, string>> = { ask: 'Ask', summarize: 'Summarize', notes: 'AI notes' };

export const UNAVAILABLE_REASON = 'Not available: AI is switched off, or no AI provider is configured.';

export const notAvailableText = (action: AiActionName): string => `${AI_LABELS[action]} is not available in this release yet.`;

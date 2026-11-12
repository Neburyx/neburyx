import type { AiActionName } from './ai-actions.js';

export const AI_LABELS: Readonly<Record<AiActionName, string>> = { ask: 'Ask', summarize: 'Summarize' };

export const LOCKED_REASON = 'Enterprise capability, locked';

export const lockedName = (action: AiActionName): string => `${AI_LABELS[action]}, ${LOCKED_REASON}`;

export const notAvailableText = (action: AiActionName): string => `${AI_LABELS[action]} is not available in this release yet.`;

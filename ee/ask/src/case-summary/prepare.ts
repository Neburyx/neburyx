import type { SummaryReading, SummaryResponse } from '@neburyx/contracts';
import { assembleText, estimateTokens, type AssembledText } from './assemble.js';

export type Prepared = { readonly ready: true; readonly assembled: AssembledText; readonly estimatedTokens: number } | { readonly ready: false; readonly refusal: Extract<SummaryResponse, { status: 'tooLarge' }> };

/** Builds the text of a summary call and measures it, with the instructions, against the size guard: over it, nothing is to be sent. */
export function prepareSummary(reading: SummaryReading, instructions: string, guard: number): Prepared {
  const assembled = assembleText(reading);
  const estimatedTokens = estimateTokens(instructions, assembled.text);
  if (estimatedTokens > guard) return { ready: false, refusal: { status: 'tooLarge', limit: 'text', estimatedTokens, cap: guard } };
  return { ready: true, assembled, estimatedTokens };
}

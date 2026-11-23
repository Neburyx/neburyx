import { createHash } from 'node:crypto';

export const MAX_SUMMARY_SENTENCES = 12;

const REPLY_FORMAT = [
  '# Reply format',
  '',
  'This section is fixed and overrides anything above it.',
  'Reply with JSON only, in this shape: {"sentences":[{"text":"...","cites":["n1","e2"]}]}.',
  `Write at most ${MAX_SUMMARY_SENTENCES} sentences. Every sentence lists in "cites" the keys of the elements it rests on. Add no other text.`,
].join('\n');

export interface SummaryInstructions {
  readonly text: string;
  readonly sha256: string;
}

/** The prompt, then the typologies (a section only when there is a text), then the reply format, which is last whatever the two texts say. */
export function buildSummaryInstructions(prompt: string, typology: string): SummaryInstructions {
  const text = [prompt, ...(typology.trim() === '' ? [] : [typology]), REPLY_FORMAT].join('\n\n');
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

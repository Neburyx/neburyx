import { AllowlistInputError, rebuildPlannerText } from '../allowlist/index.js';

export interface LabelOf {
  /** The name as the allowlist rebuilt it, when every token of it was allowed. */
  readonly label?: string;
  /** The tokens of the name that the allowlist blocked, so the guard can look for them. */
  readonly blocked: readonly string[];
}

/**
 * A pattern's name is offered to the model only when every token of it passes the allowlist rebuild that the question passes: the rebuild reads the name as text of its own, with no mention resolved, so a placeholder in a name is a token
 * it blocks. The vocabulary and the common-word list are the ones of the question, and nothing about a name is stored.
 */
export function labelOf(name: string, vocabulary: readonly string[]): LabelOf {
  try {
    const rebuilt = rebuildPlannerText({ text: name, spans: [], vocabulary });
    return rebuilt.kind === 'rebuilt' ? { label: rebuilt.text, blocked: [] } : { blocked: rebuilt.tokens.map((token) => token.text) };
  } catch (error) {
    if (error instanceof AllowlistInputError) return { blocked: [name] };
    throw error;
  }
}

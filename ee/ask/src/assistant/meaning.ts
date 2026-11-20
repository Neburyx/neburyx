import { ASSISTANT_MEANING_NAMES_MAX, type AssistantTurnAnswer, type TypeDescriptions } from '@neburyx/contracts';
import { noDescriptionSentence, usableDescriptions } from './type-lines.js';

type MeaningAnswer = Extract<AssistantTurnAnswer, { status: 'meaning' }>;

/**
 * The answer to a question that asks only what named types or links mean, written by the server and never by the model. Each name the router copied from the message is matched to an entity type (by its type, label or display name) or a relationship
 * type, exactly and whatever its case, once each: a type with a description gives that description as the operator wrote it, and a type with none, or whose description holds a word of the verdict list, gives the fixed sentence. A name that matches no
 * type makes the whole question one for the view route (undefined), and so does a source that offers no types.
 */
export function meaningAnswerOf(names: readonly string[], offered: TypeDescriptions | undefined): MeaningAnswer | undefined {
  if (offered === undefined || names.length === 0 || names.length > ASSISTANT_MEANING_NAMES_MAX) return undefined;
  const descriptions = usableDescriptions(offered);
  const described: MeaningAnswer['described'] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const asked of names) {
    const wanted = asked.trim().toLowerCase();
    const entity = descriptions.entityTypes.find((candidate) => [candidate.type, candidate.label, candidate.displayName].some((name) => name.toLowerCase() === wanted));
    const relationship = entity === undefined ? descriptions.relationshipTypes.find((candidate) => candidate.type.toLowerCase() === wanted) : undefined;
    const kind = entity === undefined ? 'relationship' : 'entity';
    const name = entity?.displayName ?? relationship?.type;
    if (name === undefined) return undefined;
    if (seen.has(`${kind}|${name}`)) continue;
    seen.add(`${kind}|${name}`);
    const description = entity?.description ?? relationship?.description;
    if (description === undefined) missing.push(name);
    else described.push({ typeKind: kind, type: name, description });
  }
  return { status: 'meaning', described, ...(missing.length === 0 ? {} : { noDescription: { sentence: noDescriptionSentence(missing), names: missing } }) };
}

import { ASSISTANT_FOLLOW_UPS_MAX, type AskAnswer, type AskEntities, type AskFolder, type AssistantChoice, type ElementRef } from '@neburyx/contracts';
import { listedElements } from '../summary/index.js';
import { roleEntityType } from './clarification.js';

export interface FollowUp {
  readonly titles: readonly string[];
  readonly choice: AssistantChoice;
}

interface Entity {
  readonly element: ElementRef;
  readonly title: string;
}

/**
 * The other template questions of the source's folder that the elements of an answer can be put to: for each other template intent of the folder, in the folder's order, every role is filled by an element of the answer of the
 * role's entity type, a different one for each role. An intent with a role no setting places, a role no element fits, or no role gives none; a file query never gives one. At most the most an answer suggests.
 */
export function followUpsOf(options: { readonly answer: AskAnswer; readonly folder: AskFolder | undefined; readonly sourceId: string; readonly seal: (intent: string, roles: readonly string[], entities: AskEntities) => AssistantChoice }): readonly FollowUp[] {
  const { answer } = options;
  if ('refused' in answer || answer.answered.continueToken !== undefined) return [];
  const listed = listedElements(answer.answered.result);
  const intents = options.folder?.source(options.sourceId)?.intents ?? [];
  if (listed === undefined) return [];
  const entities: Entity[] = [...listed.values()].flatMap((item) => ('entityType' in item.element ? [{ element: item.element, title: item.title }] : []));
  const found: FollowUp[] = [];
  for (const intent of intents) {
    if (found.length >= ASSISTANT_FOLLOW_UPS_MAX) break;
    if (intent.kind !== 'template' || intent.name === answer.answered.intent || intent.parameters.length === 0) continue;
    const chosen: Entity[] = [];
    for (const role of intent.parameters) {
      const type = roleEntityType(intent, role);
      const fit = entities.find((entity) => entity.element.entityType === type && !chosen.includes(entity));
      if (type === undefined || fit === undefined) break;
      chosen.push(fit);
    }
    if (chosen.length !== intent.parameters.length) continue;
    const values = Object.fromEntries(intent.parameters.map((role, index) => [role, chosen[index]?.element.stableId ?? '']));
    found.push({ titles: chosen.map((entity) => entity.title), choice: options.seal(intent.name, intent.parameters, values) });
  }
  return found;
}

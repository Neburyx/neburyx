import type { PatternProblem, PatternWithin, SourceProfile } from '@neburyx/contracts';
import { problemText, withinWords } from '../copy.js';
import { breakText } from './copy.js';
import type { Break, Draft } from './model.js';
import { timePropertiesOf } from './model.js';

export interface DraftWordsLine {
  readonly text: string;
  /** The phrases of the extension in the sentence, for the accent. */
  readonly phrases: readonly string[];
  readonly bad?: string;
}

/** The order of a step in words: the phrase that is accented and what follows it. With a delay the property comes after the delay and is not accented, and no time in the mapping is left to the reason under the step. */
function afterWords(properties: readonly string[], within: PatternWithin | undefined): { readonly accent: string; readonly rest: string } {
  const by = properties.length === 0 ? '' : ` (by ${properties.join(' or ')})`;
  if (within !== undefined) return { accent: `after the previous step, within ${withinWords(within)}`, rest: by };
  return { accent: `after the previous step (${properties.length === 0 ? 'no time in the mapping' : `by ${properties.join(' or ')}`})`, rest: '' };
}

const DIRECTION_WORD = { out: 'forward', in: 'backward', both: 'in either direction' } as const;

/** The draft said by the client, for the time the source's words cannot be had: its parts disagree with the mapping or the source refused it. Each step that is kept and not valid has its reason under it. */
export function draftWords(profile: SourceProfile, draft: Draft, nameOf: (type: string | undefined) => string, breaks: readonly Break[], problems: readonly PatternProblem[]): readonly DraftWordsLine[] {
  const lines: DraftWordsLine[] = [{ text: `Start: ${nameOf(draft.anchorType)}`, phrases: [] }];
  draft.steps.forEach((step, index) => {
    const phrases = [
      ...(step.fan === undefined ? [] : [`at least ${step.fan.atLeast} other ${nameOf(step.arrivesAt)}s`]),
      ...(step.closesAtAnchor === undefined ? [] : [`close back at the start ${nameOf(draft.anchorType)}`]),
      ...(step.after === undefined ? [] : [afterWords(timePropertiesOf(profile, draft, index), step.within).accent]),
    ];
    const fan = step.fan === undefined ? '' : `at least ${step.fan.atLeast} other ${nameOf(step.arrivesAt)}s`;
    const lead = `Step ${index + 1}: follow ${step.relationshipTypes.join(' or ')} ${DIRECTION_WORD[step.direction ?? 'out']}`;
    const to = step.closesAtAnchor === undefined ? `to ${fan === '' ? nameOf(step.arrivesAt) : fan}` : `and ${phrases.find((phrase) => phrase.startsWith('close')) ?? ''}${fan === '' ? '' : ` with ${fan} to choose from`}`;
    const order = step.after === undefined ? undefined : afterWords(timePropertiesOf(profile, draft, index), step.within);
    const after = order === undefined ? '' : `, ${order.accent}${order.rest}`;
    const reasons = [
      ...breaks.filter((found) => found.step === index).map((found) => (found.kind === 'no-time' && found.within !== undefined ? `“within” needs a time, and ${found.types.join(' and ')} ${found.types.length === 1 ? 'has' : 'have'} none in the mapping.` : breakText(found, nameOf))),
      ...problems.filter((problem) => problem.path[0] === 'steps' && problem.path[1] === index).map((problem) => problemText(problem)),
    ];
    lines.push({ text: `${lead} ${to}${after}`, phrases, ...(reasons.length === 0 ? {} : { bad: `Kept, not valid: ${reasons.join(' ')}` }) });
  });
  return lines;
}

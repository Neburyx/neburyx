import type { PatternProblem, SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { breakText } from './copy.js';
import type { Break, Draft } from './model.js';
import { timePropertiesOf } from './model.js';

export interface DraftWordsLine {
  readonly text: string;
  /** The phrases of the extension in the sentence, for the accent. */
  readonly phrases: readonly string[];
  readonly bad?: string;
}

const afterPhrase = (properties: readonly string[]): string => `after the previous step (${properties.length === 0 ? 'no time in the mapping' : `by ${properties.join(' or ')}`})`;

const DIRECTION_WORD = { out: 'forward', in: 'backward', both: 'in either direction' } as const;

/** The draft said by the client, for the time the source's words cannot be had: its parts disagree with the mapping or the source refused it. Each step that is kept and not valid has its reason under it. */
export function draftWords(profile: SourceProfile, draft: Draft, nameOf: (type: string | undefined) => string, breaks: readonly Break[], problems: readonly PatternProblem[]): readonly DraftWordsLine[] {
  const lines: DraftWordsLine[] = [{ text: `Start: ${nameOf(draft.anchorType)}`, phrases: [] }];
  draft.steps.forEach((step, index) => {
    const phrases = [
      ...(step.fan === undefined ? [] : [`at least ${step.fan.atLeast} other ${nameOf(step.arrivesAt)}s`]),
      ...(step.closesAtAnchor === undefined ? [] : [`close back at the start ${nameOf(draft.anchorType)}`]),
      ...(step.after === undefined ? [] : [afterPhrase(timePropertiesOf(profile, draft, index))]),
    ];
    const fan = step.fan === undefined ? '' : `at least ${step.fan.atLeast} other ${nameOf(step.arrivesAt)}s`;
    const lead = `Step ${index + 1}: follow ${step.relationshipTypes.join(' or ')} ${DIRECTION_WORD[step.direction ?? 'out']}`;
    const to = step.closesAtAnchor === undefined ? `to ${fan === '' ? nameOf(step.arrivesAt) : fan}` : `and ${phrases.find((phrase) => phrase.startsWith('close')) ?? ''}${fan === '' ? '' : ` with ${fan} to choose from`}`;
    const after = step.after === undefined ? '' : `, ${phrases.find((phrase) => phrase.startsWith('after')) ?? ''}`;
    const reasons = [
      ...breaks.filter((found) => found.step === index).map((found) => breakText(found, nameOf)),
      ...problems.filter((problem) => problem.path[0] === 'steps' && problem.path[1] === index).map((problem) => problemText(problem)),
    ];
    lines.push({ text: `${lead} ${to}${after}`, phrases, ...(reasons.length === 0 ? {} : { bad: `Kept, not valid: ${reasons.join(' ')}` }) });
  });
  return lines;
}

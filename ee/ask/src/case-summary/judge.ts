import { JUDGE_MODULE, parseJudged, type CheckedText, type HeavyCheck, type JudgeInput, type Judged } from '@neburyx/ee-ai-runtime';
import type { AssembledText } from './assemble.js';
import { judgeSentences } from './checks.js';

/** The check of the sentences of a reply, run by the check runner: inline when short, in a worker when long. */
export const judgeCheck: HeavyCheck<JudgeInput, Judged> = { name: 'judge-sentences', inline: (input) => judgeSentences(input.sentences, input.text), module: JUDGE_MODULE, parse: parseJudged };

/** What the checks read of the text, without the references each key stands for, which a worker thread would have to copy. */
export const checkedTextOf = (assembled: AssembledText): CheckedText => ({ text: assembled.text, keys: new Map([...assembled.keys.keys()].map((key) => [key, true] as const)), lines: assembled.lines, inexactCounts: assembled.inexactCounts, unknownCountKeys: assembled.unknownCountKeys });

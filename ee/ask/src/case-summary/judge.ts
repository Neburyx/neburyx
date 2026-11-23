import { JUDGE_MODULE, parseJudged, type CheckedText, type HeavyCheck, type JudgeInput, type Judged } from '@neburyx/ee-ai-runtime';
import type { AssembledText } from './assemble.js';
import { judgeSentences } from './checks.js';

/** The check of the sentences of a reply, run by the check runner: inline when short, in a worker when long. */
export const judgeCheck: HeavyCheck<JudgeInput, Judged> = { name: 'judge-sentences', inline: (input) => judgeSentences(input.sentences, input.text, { tableRows: input.tableRows === true }), module: JUDGE_MODULE, parse: parseJudged };

/** The words of a text, lower case, once each. */
const wordsOf = (text: string): string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];

/** What the checks read of the text, without the references each key stands for, which a worker thread would have to copy; with the instructions, the words the model was told to use. */
export const checkedTextOf = (assembled: AssembledText, instructions?: string): CheckedText => ({ text: assembled.text, keys: new Map([...assembled.keys.keys()].map((key) => [key, true] as const)), elementTypes: new Map([...assembled.keys].map(([key, held]) => [key, held.kind === 'entity' ? `entity ${held.ref.entityType}` : `relationship ${'aggregate' in held.ref ? held.ref.aggregate.type : 'derived' in held.ref ? held.ref.derived.ruleId : held.ref.type}`] as const)),
  ...(instructions === undefined ? {} : { knownWords: wordsOf(instructions) }),
  elementNames: new Map([...assembled.keys].map(([key, held]) => [key, [...(held.title === undefined ? [] : [held.title]), ...(held.kind === 'entity' ? [held.ref.stableId] : [])]] as const)),
  ...(assembled.propertyKeys === undefined ? {} : { propertyKeys: assembled.propertyKeys }),
  ...(assembled.readElements === undefined ? {} : { readElements: assembled.readElements }), lines: assembled.lines, inexactCounts: assembled.inexactCounts, unknownCountKeys: assembled.unknownCountKeys });

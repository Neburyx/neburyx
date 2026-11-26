import { JUDGE_MODULE, parseJudged, type CheckedText, type EntityEnd, type HeavyCheck, type JudgeInput, type Judged } from '@neburyx/ee-ai-runtime';
import type { AssembledText } from './assemble.js';
import { judgeSentences } from './checks.js';

/** The check of the sentences of a reply, run by the check runner: inline when short, in a worker when long. */
export const judgeCheck: HeavyCheck<JudgeInput, Judged> = { name: 'judge-sentences', inline: (input) => judgeSentences(input.sentences, input.text, { tableRows: input.tableRows === true }), module: JUDGE_MODULE, parse: parseJudged };

/** The words of a text, lower case, once each. */
const wordsOf = (text: string): string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];

const SENT_TITLE = /\| title: ("(?:[^"\\]|\\.)*")(?: \| id: ("(?:[^"\\]|\\.)*"))?/u;

/** The names of an element as its line sent them, once each: its title (the one the element came with, or the one its line writes) and its id only where the line writes it as `| id: "…"`. */
function namesSentOf(held: AssembledText['keys'] extends ReadonlyMap<string, infer Held> ? Held : never, line: string): string[] {
  const written = SENT_TITLE.exec(line);
  const parse = (quoted: string | undefined): string[] => {
    try {
      const value: unknown = quoted === undefined ? undefined : JSON.parse(quoted);
      return typeof value === 'string' && value !== '' ? [value] : [];
    } catch {
      return [];
    }
  };
  const id = held.kind === 'entity' && written?.[2] === JSON.stringify(held.ref.stableId) ? [held.ref.stableId] : [];
  return [...new Set([...(held.title === undefined ? parse(written?.[1]) : [held.title]), ...id])];
}

/** The entities each element is or joins: a count of entities cited through relationships is a count of these. */
function endsOf(assembled: AssembledText): ReadonlyMap<string, readonly EntityEnd[]> {
  return new Map([...assembled.keys].map(([key, held]) => [key, held.kind === 'entity' ? [[held.ref.entityType, held.ref.stableId] as const] : (assembled.relationshipEnds?.get(key) ?? []).map(([type, id]) => [type, id] as const)] as const));
}

/** What the checks read of the text, without the references each key stands for, which a worker thread would have to copy; with the instructions, the words the model was told to use. */
export const checkedTextOf = (assembled: AssembledText, instructions?: string): CheckedText => ({ text: assembled.text, keys: new Map([...assembled.keys.keys()].map((key) => [key, true] as const)), elementTypes: new Map([...assembled.keys].map(([key, held]) => [key, held.kind === 'entity' ? `entity ${held.ref.entityType}` : `relationship ${'aggregate' in held.ref ? held.ref.aggregate.type : 'derived' in held.ref ? held.ref.derived.ruleId : held.ref.type}`] as const)),
  ...(instructions === undefined ? {} : { knownWords: wordsOf(instructions) }),
  // a name is the title and the id the line sent, read from the line as it was written: a read's line holds a title and no id
  elementNames: new Map([...assembled.keys].map(([key, held]) => [key, namesSentOf(held, assembled.lines.get(key) ?? '')] as const)),
  elementEnds: endsOf(assembled),
  ...(assembled.rankedValues === undefined ? {} : { rankedValues: assembled.rankedValues }),
  ...(assembled.propertyKeys === undefined ? {} : { propertyKeys: assembled.propertyKeys }),
  // the values as they were sent, a masked one as its mask: what a claim of sameness or difference is tested against
  ...(assembled.sentValues === undefined ? {} : { elementValues: assembled.sentValues }),
  ...(assembled.readElements === undefined ? {} : { readElements: assembled.readElements }), lines: assembled.lines, inexactCounts: assembled.inexactCounts, unknownCountKeys: assembled.unknownCountKeys });

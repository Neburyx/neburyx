import type { SourceAllowlist } from '../gate/types.js';

/**
 * The grammar of a pattern statement: a language of the statements the compiler writes, learned from the compiler's own output and written down nowhere by hand. A statement is read as tokens after every backticked name
 * is replaced by its kind (a label, a relationship type, a property of a node, a property of a relationship, or all the kinds a name has) and the position `j` of a condition in `$steps[i].conditions[j]` by a mark (the step `i` is kept, and a position past the last the compiler writes is refused); it is accepted when every run of `K`
 * tokens in it, with a start and an end mark, is a run that occurs in a statement the compiler wrote. That is a language that is testable in the strict sense (a regular language): it holds the order of the compiler's own
 * words, so a word, a clause, a parameter or a name that the compiler never writes there is outside it.
 */
export const K = 6;

type Kind = 'L' | 'R' | 'NP' | 'RP';

/** The names of the allowlist by kind; a name that is of more than one kind is of all of them, and is read as such. */
function kindsOf(allowlist: SourceAllowlist): ReadonlyMap<string, string> {
  const found = new Map<string, Set<Kind>>();
  const add = (name: string, kind: Kind): void => void found.set(name, (found.get(name) ?? new Set<Kind>()).add(kind));
  for (const label of allowlist.entityLabels.values()) add(label, 'L');
  for (const type of allowlist.relationshipTypes) add(type, 'R');
  for (const property of allowlist.stableIds.values()) add(property, 'NP');
  for (const properties of allowlist.filterableProperties?.values() ?? []) for (const property of properties) add(property, 'NP');
  for (const rule of allowlist.derivedRules ?? []) if (rule.stopListProperty !== undefined) add(rule.stopListProperty, 'NP');
  for (const row of allowlist.relationshipRows) {
    for (const property of [row.stableId, row.observedAt, ...(row.filterable ?? [])]) if (property !== undefined) add(property, 'RP');
  }
  return new Map([...found].map(([name, set]) => [name, [...set].sort().join('+')]));
}

export interface Abstract {
  readonly text: string;
  /** The names the statement quotes that the allowlist does not hold. */
  readonly unmapped: readonly string[];
}

export function abstractOf(statement: string, allowlist: SourceAllowlist): Abstract {
  const kinds = kindsOf(allowlist);
  const unmapped: string[] = [];
  const text = statement
    .replaceAll(/`([^`]*)`/g, (_whole, name: string) => {
      const kind = kinds.get(name);
      if (kind === undefined) {
        unmapped.push(name);
        return '⟦?⟧';
      }
      return `⟦${kind}⟧`;
    })
    .replaceAll(/conditions\[\d+\]/g, 'conditions[#]');
  return { text, unmapped };
}

const TOKEN = /\$steps\[\d+\](?:\.[A-Za-z]+(?:\[(?:\d+|#)\])?)*|⟦[A-Z+?]+⟧|\$?[A-Za-z_][A-Za-z0-9_]*|\d+|::|<>|>=|<=|\.\.|\S/gu;
const ENDS = '⊣';
const START = '⊢';

export const tokensOf = (text: string): string[] => text.match(TOKEN) ?? [];

function windowsOf(tokens: readonly string[], k: number): string[] {
  const padded = [...Array.from({ length: k - 1 }, () => START), ...tokens, ENDS];
  return Array.from({ length: padded.length - k + 1 }, (_unused, index) => padded.slice(index, index + k).join(' '));
}

export interface PatternGrammar {
  readonly k: number;
  /** The greatest position of a condition in a step that a statement of the compiler holds; a position is otherwise not read, so that a condition at any position meets any word that may follow it. */
  readonly maxPosition: number;
  readonly windows: ReadonlySet<string>;
  /** The most tokens of a statement the compiler wrote, which bounds a statement. */
  readonly longest: number;
}

/** Learns the grammar from statements the compiler wrote. */
export function learnGrammar(statements: Iterable<string>, allowlist: SourceAllowlist, k: number = K): PatternGrammar {
  const windows = new Set<string>();
  let longest = 0;
  let maxPosition = 0;
  for (const statement of statements) {
    for (const match of statement.matchAll(/conditions\[(\d+)\]/g)) maxPosition = Math.max(maxPosition, Number(match[1]));
    const { text } = abstractOf(statement, allowlist);
    const tokens = tokensOf(text);
    longest = Math.max(longest, tokens.length);
    for (const window of windowsOf(tokens, k)) windows.add(window);
  }
  return { k, maxPosition, windows, longest };
}

/** What is wrong with a statement against the grammar: empty when it is accepted. The first place the grammar stops is named. */
export function grammarProblems(statement: string, grammar: PatternGrammar, allowlist: SourceAllowlist): string[] {
  const { text, unmapped } = abstractOf(statement, allowlist);
  const problems = unmapped.map((name) => `quotes ${JSON.stringify(name)}, which the mapping does not hold`);
  for (const match of statement.matchAll(/conditions\[(\d+)\]/g)) if (Number(match[1]) > grammar.maxPosition) problems.push(`a condition at position ${match[1]}, past the last position the compiler writes (${grammar.maxPosition})`);
  const tokens = tokensOf(text);
  if (tokens.length > grammar.longest) problems.push(`longer than any statement the compiler writes (${tokens.length} tokens, at most ${grammar.longest})`);
  const { k } = grammar;
  const padded = [...Array.from({ length: k - 1 }, () => START), ...tokens, ENDS];
  for (let index = 0; index + k <= padded.length; index += 1) {
    const window = padded.slice(index, index + k).join(' ');
    if (!grammar.windows.has(window)) {
      problems.push(`outside the grammar at token ${index}: ${JSON.stringify(window.replaceAll(START, '').trim())}`);
      break;
    }
  }
  return problems;
}

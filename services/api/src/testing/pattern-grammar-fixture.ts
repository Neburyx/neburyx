import { learnGrammar, type PatternGrammar } from './pattern-grammar.js';
import { PATHS, grammarCorpus, pathStatements, shapeAllowlist, statementOfShape } from './pattern-shapes.js';

/** The names the grammar of the fixture's pattern statements is learned over. */
export const GRAMMAR_ALLOWLIST = shapeAllowlist(2, 2);
export const PATH_COUNT = PATHS.length;

let learned: PatternGrammar | undefined;

/** The grammar of the pattern statements, learned once from the shapes of the corpus and the paths over two types: the words are the compiler's, the names are read by their kind, so it holds for any mapping. */
export function learnedGrammar(): PatternGrammar {
  learned ??= learnGrammar([...grammarCorpus().map((shape) => statementOfShape(shape)), ...pathStatements()], GRAMMAR_ALLOWLIST);
  return learned;
}

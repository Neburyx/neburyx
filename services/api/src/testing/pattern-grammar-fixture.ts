import { learnGrammar, type PatternGrammar } from './pattern-grammar.js';
import { PATHS, countStatementOfShape, grammarCorpus, pathCountStatements, pathStatements, shapeAllowlist, statementOfShape } from './pattern-shapes.js';

/** The names the grammar of the fixture's pattern statements is learned over. */
export const GRAMMAR_ALLOWLIST = shapeAllowlist(2, 2);
export const PATH_COUNT = PATHS.length;

let learned: PatternGrammar | undefined;
let learnedCount: PatternGrammar | undefined;

/** The grammar of the pattern statements, learned once from the shapes of the corpus and the paths over two types: the words are the compiler's, the names are read by their kind, so it holds for a mapping whose names have the kinds the corpus holds (a kind the corpus never saw would be refused). */
export function learnedGrammar(): PatternGrammar {
  learned ??= learnGrammar([...grammarCorpus().map((shape) => statementOfShape(shape)), ...pathStatements()], GRAMMAR_ALLOWLIST);
  return learned;
}

/** The grammar of the count statements of a run, learned the same way from the count statement of each shape of the corpus and of each path: the run's fragments with the count's own tail. */
export function learnedCountGrammar(): PatternGrammar {
  learnedCount ??= learnGrammar([...grammarCorpus().map((shape) => countStatementOfShape(shape)), ...pathCountStatements()], GRAMMAR_ALLOWLIST);
  return learnedCount;
}

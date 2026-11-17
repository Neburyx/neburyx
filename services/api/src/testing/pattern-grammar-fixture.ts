import { learnGrammar, type PatternGrammar } from './pattern-grammar.js';
import { SEED_OF_RECORD, countStatementOfShape, enumerateExtendedShapes, grammarCorpus, pathCountStatements, pathStatements, randomExtendedShapes, shapeAllowlist, statementOfShape, type Shape } from './pattern-shapes.js';

/** The names the grammar of the fixture's pattern statements is learned over. */
export const GRAMMAR_ALLOWLIST = shapeAllowlist(2, 2);

let learned: PatternGrammar | undefined;
let learnedCount: PatternGrammar | undefined;
let learnedBase: PatternGrammar | undefined;

/** The shapes of the extension the grammar is learned from: the enumerated ones and shapes drawn from the seed of the record (the run route test draws from another). */
const extendedCorpus = (): Shape[] => [...enumerateExtendedShapes(), ...randomExtendedShapes(SEED_OF_RECORD, 400)];

/** The grammar of the statements before the fan, time order and cycle, learned from the shapes that had no fan, time order or cycle: it must accept every such statement and none that holds a fragment of the extension. */
export function learnedBaseGrammar(): PatternGrammar {
  learnedBase ??= learnGrammar([...grammarCorpus().map((shape) => statementOfShape(shape)), ...pathStatements()], GRAMMAR_ALLOWLIST);
  return learnedBase;
}

/** The grammar of the pattern statements, learned once from the shapes of the corpus and the paths over two types: the words are the compiler's, the names are read by their kind, so it holds for a mapping whose names have the kinds the corpus holds (a kind the corpus never saw would be refused). */
export function learnedGrammar(): PatternGrammar {
  learned ??= learnGrammar([...grammarCorpus().map((shape) => statementOfShape(shape)), ...extendedCorpus().map((shape) => statementOfShape(shape)), ...pathStatements()], GRAMMAR_ALLOWLIST);
  return learned;
}

/** The grammar of the count statements of a run, learned the same way from the count statement of each shape of the corpus and of each path: the run's fragments with the count's own tail. */
export function learnedCountGrammar(): PatternGrammar {
  learnedCount ??= learnGrammar([...grammarCorpus().map((shape) => countStatementOfShape(shape)), ...extendedCorpus().map((shape) => countStatementOfShape(shape)), ...pathCountStatements()], GRAMMAR_ALLOWLIST);
  return learnedCount;
}

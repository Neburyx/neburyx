import { learnGrammar, type PatternGrammar } from './pattern-grammar.js';
import { PATHS, grammarCorpus, pathStatements, shapeAllowlist, statementOfShape } from './pattern-shapes.js';

/** The grammar of the fixture's pattern statements, learned once for a file from the shapes of the corpus and the paths over two types. */
export const GRAMMAR_ALLOWLIST = shapeAllowlist(2, 2);
export const GRAMMAR: PatternGrammar = learnGrammar([...grammarCorpus().map((shape) => statementOfShape(shape)), ...pathStatements()], GRAMMAR_ALLOWLIST);
export const PATH_COUNT = PATHS.length;

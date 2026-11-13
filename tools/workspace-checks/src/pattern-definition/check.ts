import { loadTree } from '../architecture/tree.js';

/** The one file that defines a pattern; every other file imports it. */
export const PATTERN_DEFINITION_FILE = 'packages/contracts/src/pattern.ts';
export const PATTERN_SCAN_ROOTS: readonly string[] = ['apps', 'packages', 'services', 'tools', 'ee'];

export interface PatternDefinitionViolation {
  readonly file: string;
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** A step of a pattern built as an object schema: the key that only a pattern step has, given a schema. */
const STEP_SCHEMA = /\barrivesAt\s*:\s*z\./;
const OBJECT_SCHEMA = /\bz\.(?:strictObject|object|looseObject)\(/;

/** The files, other than the one that defines it, that define a second schema of a pattern. */
export function checkPatternDefinition(root: string): PatternDefinitionViolation[] {
  return loadTree(root, { include: PATTERN_SCAN_ROOTS })
    .filter((file) => file.path !== PATTERN_DEFINITION_FILE && !TEST_FILE.test(file.path))
    .filter((file) => OBJECT_SCHEMA.test(file.text) && STEP_SCHEMA.test(file.text))
    .map((file) => ({ file: file.path }));
}

export const formatPatternViolations = (violations: readonly PatternDefinitionViolation[]): string =>
  violations.map((violation) => `${violation.file} defines a pattern schema of its own; import it from ${PATTERN_DEFINITION_FILE}`).join('\n');

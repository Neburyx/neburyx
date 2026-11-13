import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { patternRequestOf } from '../gate/templates/pattern-request.js';
import { patternStatementOf } from '../gate/templates/pattern-statement.js';
import { GRAMMAR, GRAMMAR_ALLOWLIST } from '../testing/pattern-grammar-fixture.js';
import { grammarProblems, learnGrammar, K } from '../testing/pattern-grammar.js';
import { PATHS, SHAPE_RELATIONSHIPS, enumerateShapes, formsOf, pathStatements, paramsOf, randomShapes, shapeAllowlist, statementOfShape } from '../testing/pattern-shapes.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { statementProblems, quotedNamesOf } from '../testing/fuzz-closed-set.js';
import type { FuzzRig } from '../testing/fuzz-rig.js';

// compiling every shape is slow when the suites run together
vi.setConfig({ testTimeout: 60_000 });

const allowlist = GRAMMAR_ALLOWLIST;
const grammar = GRAMMAR;
const problems = (statement: string): string[] => grammarProblems(statement, grammar, allowlist);
const NAMES = new Set(['Maker', 'Tool', 'makerId', 'region', 'rank', 'lane', 'seenAt', 'spottedAt', 'linkId', 'trustId', 'serveId', 'pairId', 'isCommon', 'isHub', 'LINKS', 'ALLIES', 'TRUSTS', 'KNOWS', 'SERVES', 'PAIRS']);

const FOUR_STEPS = statementOfShape({ steps: [0, 1, 2, 3].map((index) => ({ direction: 'out' as const, typeClass: index, conditions: [], windowed: false })), stopRules: 1 });
const TWO_STEPS = statementOfShape({ steps: [0, 1].map((index) => ({ direction: 'out' as const, typeClass: index, conditions: [], windowed: false })), stopRules: 0 });
const ONE_STEP = statementOfShape({ steps: [{ direction: 'out', typeClass: 0, conditions: [], windowed: false }], stopRules: 0 });

describe('the grammar of a pattern statement', () => {
  it('is built from the compiler\'s own output: its module holds no Cypher clause or keyword written by hand', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'pattern-grammar.ts'), 'utf8');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(MATCH|WHERE|RETURN|UNWIND|CALL|LIMIT|UNION|WITH|ORDER|COLLECT|DISTINCT|OPTIONAL|DELETE|CREATE|MERGE|SET|REMOVE|ALL)\b/);
    expect(K).toBeGreaterThan(3);
  });

  it('accepts every statement of the enumerator and of the generator over several seeds', () => {
    for (const shape of enumerateShapes()) expect(problems(statementOfShape(shape)), JSON.stringify(shape)).toEqual([]);
    for (const seed of [5017, 7777, 31337, 424242, 99, 1234]) for (const shape of randomShapes(seed, 200)) expect(problems(statementOfShape(shape)), `${seed} ${JSON.stringify(shape)}`).toEqual([]);
  });

  it('accepts the statements of the paths over two types, with the stop-list rules of each type', () => {
    expect(pathStatements().length).toBe(3 * 3 * PATHS.length * 2);
    for (const statement of pathStatements()) expect(problems(statement), statement).toEqual([]);
  });

  it('holds on another mapping, whose names are other and one of which is of two kinds, learned there and accepted there', () => {
    const mapping = linkedMappingOf({
      entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region', 'shared'] }],
      relationships: SHAPE_RELATIONSHIPS.map((row) => ({ ...row, filterable: ['lane', 'shared'] })),
      derived: [],
      patterns: [],
    });
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const other = allowlistFromMapping(source);
    const shape = (target: 'neighbor' | 'relationship') => ({ steps: [{ direction: 'out' as const, typeClass: 0, conditions: [], windowed: false }], stopRules: 0 as const, target });
    const compile = (target: 'neighbor' | 'relationship'): string => {
      const params = paramsOf(shape(target)) as { steps: Record<string, unknown>[] };
      const conditions = [{ on: target, property: 'shared', op: 'eq', value: { kind: 'text', value: 'a' } }];
      return patternStatementOf(other, patternRequestOf(other, { ...params, steps: [{ ...params.steps[0], conditions }] } as never));
    };
    const learned = learnGrammar([compile('neighbor'), compile('relationship')], other);
    expect(grammarProblems(compile('neighbor'), learned, other)).toEqual([]);
    expect(grammarProblems(compile('relationship'), learned, other)).toEqual([]);
    expect(compile('neighbor')).toContain('`shared`');
  });
});

/** The faults of the check, each a statement the compiler cannot write. */
const FAULTS: readonly (readonly [string, string, (statement: string) => string])[] = [
  ['a keyword changed', 'one', (s) => s.replace('UNWIND', 'UNWINDS')],
  ['a clause removed', 'two', (s) => s.replace(' WITH n1, r1 LIMIT $countCap + 1', '')],
  ['a clause appended', 'one', (s) => `${s}\nDETACH DELETE a`],
  ['a parameter renamed to one the compiler never writes', 'one', (s) => s.replace('$countCap', '$cap')],
  ['a variable of a step renamed to another step\'s', 'two', (s) => s.replace('(n2:', '(n3:')],
  ['a condition block moved to another step', 'cond', (s) => s.replaceAll('$steps[0].conditions[0]', '$steps[1].conditions[0]')],
  ['a block repeated past the cap', 'cond', (s) => s.replaceAll('conditions[5]', 'conditions[12]')],
  ['a name of another kind where a label belongs', 'one', (s) => s.replace(/MATCH \(a:`[^`]*`\)/, 'MATCH (a:`LINKS`)')],
  ['a line comment', 'one', (s) => `${s} // note`],
  ['a block comment', 'one', (s) => s.replace('RETURN a,', '/* x */ RETURN a,')],
  ['a second statement after a semicolon', 'one', (s) => `${s}; MATCH (n) DETACH DELETE n`],
  ['a block cut in two', 'two', (s) => s.slice(0, Math.floor(s.length * 0.6))],
  ['two lines swapped', 'two', (s) => ((lines) => [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'))(s.split('\n'))],
  ['a limit of another size', 'one', (s) => s.replace('LIMIT $limit + 1', 'LIMIT 100')],
  ['a condition glued on with OR', 'two', (s) => s.replace('WHERE n1 <> a', 'WHERE n1 <> a OR true')],
  ['a write', 'one', (s) => s.replace('RETURN a,', 'SET a.x = 1 RETURN a,')],
  ['an extra parameter', 'one', (s) => s.replace('$stableId', '$stableId, $other')],
];
const WITH_CONDITIONS = statementOfShape({ steps: [{ direction: 'out', typeClass: 0, conditions: [...formsOf('neighbor').slice(0, 3), ...formsOf('relationship').slice(0, 3)], windowed: true }, { direction: 'out', typeClass: 0, conditions: [], windowed: false }], stopRules: 0 });
const BASE: Readonly<Record<string, string>> = { one: ONE_STEP, two: TWO_STEPS, cond: WITH_CONDITIONS };

describe('a statement outside the grammar', () => {
  it.each(FAULTS)('is rejected: %s, naming where the grammar stops', (_name, base, fault) => {
    const faulty = fault(BASE[base] as string);
    expect(faulty).not.toBe(BASE[base]);
    const found = problems(faulty);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(' ')).toMatch(/outside the grammar|quotes|longer than|past the last position/);
  });

  it('is rejected when it quotes a name the mapping does not hold', () => {
    expect(problems(ONE_STEP.replace('`makerId`', '`evil`'))).toEqual([expect.stringContaining('quotes "evil"'), expect.stringContaining('outside the grammar')]);
    expect(quotedNamesOf(ONE_STEP.replace('`makerId`', '`evil`'))).toContain('evil');
  });

  it('is rejected when it is longer than any statement the compiler writes', () => {
    expect(problems(`${FOUR_STEPS}\n${FOUR_STEPS}`).join(' ')).toMatch(/longer than|outside the grammar/);
  });
});

describe('the check of a recorded call', () => {
  const rig = (calls: readonly { templateId: string; cypher: string }[]): FuzzRig => ({ executor: { calls } }) as unknown as FuzzRig;

  it('applies the grammar to the statements of the pattern template in place of the closed set, and the closed set to every other template', () => {
    const calls = [
      { templateId: 'pattern', cypher: TWO_STEPS },
      { templateId: 'shared-attribute', cypher: 'RETURN 1' },
    ];
    const found = statementProblems(rig(calls), new Set(), [], { grammar, allowlist, names: NAMES });
    expect(found).toEqual([{ cypher: 'RETURN 1', reason: 'not in the closed set' }]);
    expect(statementProblems(rig([calls[0] as { templateId: string; cypher: string }]), new Set(), [])).toContainEqual({ cypher: TWO_STEPS, reason: 'not in the closed set' });
  });

  it('fails a statement of the pattern template that wrote a value of the request into its text', () => {
    const wrote = TWO_STEPS.replace('$stableId', "'A-1'");
    const found = statementProblems(rig([{ templateId: 'pattern', cypher: wrote }]), new Set(), ['A-1'], { grammar, allowlist, names: NAMES });
    expect(found.map((problem) => problem.reason)).toEqual(expect.arrayContaining([expect.stringContaining('outside the grammar'), expect.stringContaining('holds request text "A-1"')]));
  });

  it('holds no problem for statements the compiler writes, with the request values of its own run', () => {
    const params = paramsOf({ steps: [{ direction: 'out', typeClass: 0, conditions: [], windowed: false }], stopRules: 0 }) as { stableId: string };
    const text = patternStatementOf(allowlist, patternRequestOf(allowlist, paramsOf({ steps: [{ direction: 'out', typeClass: 0, conditions: [], windowed: false }], stopRules: 0 }) as never));
    expect(statementProblems(rig([{ templateId: 'pattern', cypher: text }]), new Set(), [params.stableId], { grammar, allowlist, names: NAMES })).toEqual([]);
  });
});

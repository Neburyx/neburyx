import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { quotedNamesOf } from '../testing/fuzz-closed-set.js';
import { parsedPatternParams, patternAllowlist, step } from '../testing/pattern-fixtures.js';
import { quoteName } from './render.js';
import { patternRequestOf } from './templates/pattern-request.js';
import { patternStatementOf } from './templates/pattern-statement.js';

const allowlist = patternAllowlist();
const compile = (steps: Record<string, unknown>[]): string => patternStatementOf(allowlist, patternRequestOf(allowlist, parsedPatternParams(steps)));

/** Every name the mapping gives, which a statement may quote. */
const ALLOWED = new Set([
  ...allowlist.entityLabels.values(),
  ...allowlist.relationshipTypes,
  ...allowlist.stableIds.values(),
  ...(allowlist.derivedRules ?? []).flatMap((rule) => (rule.stopListProperty === undefined ? [] : [rule.stopListProperty])),
  ...[...(allowlist.filterableProperties ?? new Map<string, readonly string[]>()).values()].flat(),
  ...allowlist.relationshipRows.flatMap((row) => [...(row.filterable ?? []), ...(row.observedAt === undefined ? [] : [row.observedAt])]),
]);

const WRITE = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD\s+CSV|IN\s+TRANSACTIONS|USING\s+PERIODIC)\b/i;
const withoutQuoted = (text: string): string => text.replace(/`[^`]*`/g, '``');

const NEIGHBOR_CONDITIONS: Record<string, readonly Record<string, unknown>[]> = {
  maker: [
    { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } },
    { on: 'neighbor', property: 'region', op: 'in', values: [{ kind: 'text', value: 'x' }] },
    { on: 'neighbor', property: 'rank', op: 'between', from: { kind: 'number', value: 1 } },
  ],
  tool: [{ on: 'neighbor', property: 'kind', op: 'eq', value: { kind: 'text', value: 'x' } }],
  shop: [],
};
const OPTIONS: Record<string, readonly { types: readonly string[]; direction: string; arrivesAt: string }[]> = {
  maker: [
    ...(['out', 'in', 'both'] as const).flatMap((direction) => [{ types: ['LINKS'], direction, arrivesAt: 'maker' }, { types: ['LINKS', 'TRUSTS'], direction, arrivesAt: 'maker' }]),
    { types: ['USES_TOOL'], direction: 'out', arrivesAt: 'tool' },
  ],
  tool: [{ types: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' }, { types: ['STOCKED_AT'], direction: 'out', arrivesAt: 'shop' }],
  shop: [{ types: ['STOCKED_AT'], direction: 'in', arrivesAt: 'tool' }, { types: ['ENDORSES'], direction: 'out', arrivesAt: 'maker' }],
};

/** A valid pattern of one to four steps, walked over the mapping's types, each step with some conditions and a window or not. */
const patternArbitrary = fc.integer({ min: 1, max: 4 }).chain((count) =>
  fc.tuple(...Array.from({ length: count }, () => fc.tuple(fc.nat(), fc.boolean(), fc.boolean(), fc.boolean()))).map((picks) => {
    let from = 'maker';
    return picks.map(([pick, windowed, withNeighbor, withRelationship]) => {
      const options = OPTIONS[from] ?? [];
      const option = options[pick % options.length];
      if (option === undefined) throw new Error('no option');
      const neighbor = NEIGHBOR_CONDITIONS[option.arrivesAt] ?? [];
      const conditions = [
        ...(withNeighbor && neighbor.length > 0 ? [neighbor[pick % neighbor.length]] : []),
        ...(withRelationship && option.types.length === 1 && option.types[0] === 'LINKS' ? [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } }] : []),
      ];
      from = option.arrivesAt;
      return step({ relationshipTypes: option.types, direction: option.direction, arrivesAt: option.arrivesAt, ...(conditions.length > 0 ? { conditions } : {}), ...(windowed ? { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' } : {}) });
    });
  }),
);

describe('the statements of the pattern compiler, over a sample of shapes', () => {
  it('hold no write clause and no procedure call, outside a quoted name', () => {
    fc.assert(
      fc.property(patternArbitrary, (steps) => {
        const text = withoutQuoted(compile(steps));
        expect(text).not.toMatch(WRITE);
        for (const call of text.matchAll(/\bCALL\b/g)) expect(text.slice((call.index ?? 0) + 4, (call.index ?? 0) + 6)).toBe(' {');
        expect(text).not.toMatch(/\bapoc\./i);
        expect(text).not.toMatch(/\[[^\]]*\*/);
      }),
      { seed: 5017, numRuns: 150 },
    );
  });

  it('quote every name through quoteName and only names of the mapping, and have no literal of a request', () => {
    fc.assert(
      fc.property(patternArbitrary, (steps) => {
        const statement = compile(steps);
        for (const name of quotedNamesOf(statement)) {
          expect(ALLOWED.has(name), name).toBe(true);
          expect(statement).toContain(quoteName(name));
        }
        const literals = [...withoutQuoted(statement).matchAll(/'[^']*'/g)].map((match) => match[0]);
        expect(literals.every((literal) => literal === "'UTC'" || literal === "''")).toBe(true);
        const parameters = new Set([...statement.matchAll(/\$([A-Za-z]+)/g)].map((match) => match[1]));
        expect([...parameters].every((name) => ['stableId', 'stableInteger', 'countCap', 'limit', 'steps', 'cursor', 'endType'].includes(name ?? ''))).toBe(true);
      }),
      { seed: 5017, numRuns: 150 },
    );
  });

  it('read nothing without a bound: the anchor line is cut at one, every other MATCH sits in a block that is cut', () => {
    fc.assert(
      fc.property(patternArbitrary, (steps) => {
        for (const line of compile(steps).split('\n')) {
          if (line.startsWith('MATCH (a:')) expect(line).toMatch(/LIMIT 1$/);
          else if (line.includes('MATCH ')) expect(line).toMatch(/LIMIT \$countCap \+ 1|LIMIT \$limit \+ 1/);
        }
      }),
      { seed: 5017, numRuns: 150 },
    );
  });

  it('refuse to quote a name that cannot sit inside backticks', () => {
    for (const name of ['a`b', 'a\\b', 'a\nb']) expect(() => quoteName(name)).toThrow(AppError);
  });
});

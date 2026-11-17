import { patternDefinitionSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { patternParamsSchema, patternRequestOf } from '../gate/templates/pattern-request.js';
import { patternCountStatementOf, patternStatementOf } from '../gate/templates/pattern-statement.js';
import { parseMapping } from '../mapping/load.js';
import { PACKS, packMappingText } from '../testing/pack-fixtures.js';
import { learnedCountGrammar, learnedGrammar } from '../testing/pattern-grammar-fixture.js';
import { grammarProblems } from '../testing/pattern-grammar.js';

const SENTINEL_ANCHOR = 'zz-sentinel-anchor-6161';

describe('the built-in definitions of every shipped pack', () => {
  const grammar = learnedGrammar();
  const countGrammar = learnedCountGrammar();

  it.each(PACKS)('%s: each is accepted by the strict schema, compiles to a statement and a count statement the grammar accepts, quotes only names the mapping holds, and writes no value of its own or of the request into the text', (pack) => {
    const [source] = parseMapping(packMappingText(pack), 'neburyx.yaml').sources;
    if (source === undefined) throw new Error('the pack has no source');
    const allowlist = allowlistFromMapping(source);
    for (const entry of source.builtInDefinitions ?? []) {
      const definition = patternDefinitionSchema.parse(entry.definition);
      expect(JSON.stringify(Object.keys(definition)), entry.id).toBe(JSON.stringify(['anchorType', 'steps']));
      const params = patternParamsSchema.parse({
        anchorType: definition.anchorType,
        stableId: SENTINEL_ANCHOR,
        steps: definition.steps.map(({ window: _window, ...rest }) => rest),
      });
      const request = patternRequestOf(allowlist, params, source.budgets.heavyOpThreshold);
      for (const [statement, learned] of [[patternStatementOf(allowlist, request), grammar], [patternCountStatementOf(allowlist, request), countGrammar]] as const) {
        expect(grammarProblems(statement, learned, allowlist), entry.id).toEqual([]);
        expect(statement, entry.id).not.toContain(SENTINEL_ANCHOR);
        for (const step of definition.steps) if (step.fan !== undefined) expect(statement, `${entry.id}: the fan threshold is a parameter`).not.toMatch(new RegExp(`>=\\s*${step.fan.atLeast}\\b`));
        expect(statement, entry.id).not.toMatch(/\b(DELETE|CREATE|MERGE|SET|REMOVE|DROP)\b/);
      }
    }
  });

  it('holds the four typologies in the banking pack and none in the insurance pack', () => {
    const idsOf = (pack: (typeof PACKS)[number]) => (parseMapping(packMappingText(pack), 'neburyx.yaml').sources[0]?.builtInDefinitions ?? []).map((entry) => entry.id);
    expect(idsOf('banking-fraud')).toEqual(['fan-out', 'fan-in', 'cycles', 'pass-through']);
    expect(idsOf('insurance-claims')).toEqual([]);
  });
});

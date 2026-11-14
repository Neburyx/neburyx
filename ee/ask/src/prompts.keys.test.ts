import { askPlanSchema, plannedSavedPatternParamsSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { PATTERN_CATALOG_INTRO } from './patterns/catalog-text.js';
import { BUILT_IN_PROMPTS } from './prompts.js';

/** A schema as the test reads it: no schema library is imported, only what a schema of the contract exposes. */
interface Walkable {
  readonly def?: { readonly type?: string; readonly options?: readonly Walkable[]; readonly values?: readonly unknown[] };
  readonly shape?: Readonly<Record<string, Walkable>>;
}

interface Shape {
  readonly label: string;
  readonly keys: readonly string[];
}

/** Every object shape of a reply union, with the text of its `kind` and `templateId`, and its top-level keys, required or optional. A schema the test does not know is a failure, never skipped. */
function shapesOf(schema: Walkable): readonly Shape[] {
  switch (schema.def?.type) {
    case 'union':
      return (schema.def.options ?? []).flatMap(shapesOf);
    case 'object': {
      const shape = schema.shape ?? {};
      const literal = (key: string): string | undefined => {
        const value = shape[key]?.def?.values?.[0];
        return typeof value === 'string' ? value : undefined;
      };
      return [{ label: [literal('kind'), literal('templateId')].filter((part) => part !== undefined).join(' '), keys: Object.keys(shape) }];
    }
    default:
      throw new Error(`a reply shape of a type this test does not know: ${schema.def?.type ?? 'none'}`);
  }
}

/** The keys a prompt text does not name in the quoted form the prompts use. */
function missingKeys(text: string, keys: readonly string[]): readonly string[] {
  return keys.filter((key) => !text.includes(`"${key}"`));
}

const PROMPTS = ['ask.plan', 'ask.plan.repair'] as const;
const SHAPES = shapesOf(askPlanSchema as unknown as Walkable);

describe('the shapes of a reply, read from the contract', () => {
  it('are the shapes of a plan of each template, of a saved pattern and of a refusal, and the keys of a refusal include its family', () => {
    expect(SHAPES.length).toBeGreaterThan(8);
    const refusal = SHAPES.find((shape) => shape.label === 'unsupported');
    expect(refusal?.keys).toEqual(expect.arrayContaining(['kind', 'family', 'reason']));
    expect(SHAPES.find((shape) => shape.label === 'plan shared-attribute')?.keys).toEqual(expect.arrayContaining(['kind', 'templateId', 'templateVersion', 'params', 'rationale']));
    expect(SHAPES.some((shape) => shape.label === 'plan saved-pattern')).toBe(true);
  });

  it('are refused when a shape is of a type the test does not know', () => {
    expect(() => shapesOf({ def: { type: 'intersection' } })).toThrow(/does not know: intersection/);
  });
});

describe('what the built-in prompts name of the reply', () => {
  it.each(PROMPTS.flatMap((id) => SHAPES.map((shape) => [id, shape.label, shape] as const)))('%s names every key of the reply shape "%s"', (id, _label, shape) => {
    const missing = missingKeys(BUILT_IN_PROMPTS[id].instructions, shape.keys);
    expect(missing, `the prompt ${id} does not name ${missing.map((key) => `"${key}"`).join(', ')} of the reply shape "${shape.label}"`).toEqual([]);
  });

  it('are checked against the keys of the parameters a saved pattern is answered with, which the list of saved patterns names', () => {
    const keys = Object.keys((plannedSavedPatternParamsSchema as unknown as Walkable).shape ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(PATTERN_CATALOG_INTRO, `the list of saved patterns does not name ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
  });
});

describe('the check itself', () => {
  const extended: Walkable = { def: { type: 'object' }, shape: { kind: { def: { values: ['plan'] } }, templateId: { def: { values: ['x'] } }, invented: {} } };

  it('fails for a key added to a shape that a text does not name, and passes once the text names it', () => {
    const [shape] = shapesOf(extended);
    expect(shape?.keys).toContain('invented');
    expect(missingKeys('"kind" "templateId"', shape?.keys ?? [])).toEqual(['invented']);
    expect(missingKeys('"kind" "templateId" "invented"', shape?.keys ?? [])).toEqual([]);
  });

  it('does not count a key written as a bare word', () => {
    expect(missingKeys('the kind plan, the template identifier and a reason', ['kind', 'reason'])).toEqual(['kind', 'reason']);
  });
});

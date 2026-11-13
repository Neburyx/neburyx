import type { AiMappingView, AskPatternOffer, AskPatternProjection } from '@neburyx/contracts';
import { BUILT_IN_PROMPTS } from '../prompts.js';
import { PATTERN_CATALOG_CUT_SENTENCE, PATTERN_CATALOG_INTRO, PATTERN_LABEL_NOTE } from './catalog-text.js';
import { descriptionWords } from './describe.js';

export type PatternGuardKind = 'projection' | 'catalog' | 'text';

/** A saved pattern's text would have reached the model. It says which kind of check failed and the position of the pattern in the listing, never the text. */
export class PatternGuardError extends Error {
  readonly kind: PatternGuardKind;
  readonly position: number | undefined;

  constructor(kind: PatternGuardKind, position?: number) {
    super('a saved pattern text would reach the model');
    this.name = 'PatternGuardError';
    this.kind = kind;
    this.position = position;
  }
}

const DIRECTIONS: ReadonlySet<string> = new Set(['out', 'in', 'both']);
const STARTS: ReadonlySet<string> = new Set(['asked', 'held']);
const KINDS: ReadonlySet<string> = new Set(['eq', 'in', 'between']);
const ELEMENTS: ReadonlySet<string> = new Set(['neighbor', 'relationship']);
const TEMPLATES: ReadonlySet<string> = new Set(['shared-attribute', 'linked-entities']);

interface Names {
  readonly entities: ReadonlySet<string>;
  readonly relationships: ReadonlySet<string>;
}

function namesOf(view: AiMappingView | undefined): Names {
  const types = view?.types ?? [];
  return { entities: new Set(types.filter((type) => type.kind === 'entity').map((type) => type.name)), relationships: new Set(types.filter((type) => type.kind === 'relationship').map((type) => type.name)) };
}

const whole = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1;

/** A projection is vetted when every name in it is a type of the mapping, every other field is a number, a flag or one of the fixed words: nothing a person typed can be in it. */
function isVetted(projection: AskPatternProjection, names: Names): boolean {
  if (!names.entities.has(projection.anchorType) || !STARTS.has(projection.startingEntity)) return false;
  if (projection.kind === 'definition') {
    return projection.steps.every(
      (step) =>
        step.relationshipTypes.every((type) => names.relationships.has(type)) &&
        DIRECTIONS.has(step.direction) &&
        names.entities.has(step.arrivesAt) &&
        typeof step.windowed === 'boolean' &&
        step.conditions.every((condition) => ELEMENTS.has(condition.on) && KINDS.has(condition.kind)),
    );
  }
  return (
    TEMPLATES.has(projection.template) &&
    names.entities.has(projection.otherType) &&
    projection.relationshipTypes.every((type) => names.relationships.has(type)) &&
    (projection.direction === undefined || DIRECTIONS.has(projection.direction)) &&
    (projection.maxHops === undefined || whole(projection.maxHops)) &&
    (projection.minShared === undefined || whole(projection.minShared)) &&
    typeof projection.windowed === 'boolean'
  );
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the text holds the needle as a whole word or phrase, not as part of a longer word. */
function holds(text: string, needle: string): boolean {
  return needle !== '' && new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(needle)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

const STATIC_PARAMETERS: readonly string[] = ['catalog', 'vocabulary'];
const NOT_SCANNED: readonly string[] = ['question'];

export interface PatternGuard {
  check(parameters: Readonly<Record<string, string | number>>): void;
}

/**
 * The check on every model request of a turn: the pattern section is exactly the one the real renderer gives for the vetted offers, and nothing the caller typed into a saved pattern (a name, an identifier) is in the rest of the request,
 * unless it is also a word of the static instructions, the catalog, the vocabulary or the fixed words of the pattern section, where it cannot be told apart and is not a leak of the pattern. The pattern section is scanned too: its text is the renderer's, so a name, a blocked token or an identifier
 * in it is a leak whoever wrote it. The question, which the allowlist rebuilt, is not scanned for it; a name that was offered as a label is not looked for, since it may be in the section.
 */
export interface GuardedOffer {
  readonly offer: AskPatternOffer;
  /** The tokens of the name the allowlist blocked: looked for besides the name; a name that was offered as a label has none and may reach the model, in the pattern section only. */
  readonly blocked: readonly string[];
  readonly offered: boolean;
}

export function createPatternGuard(guarded: readonly GuardedOffer[], view: AiMappingView | undefined, expectedText: string): PatternGuard {
  const names = namesOf(view);
  guarded.forEach(({ offer }, position) => {
    if (!isVetted(offer.projection, names)) throw new PatternGuardError('projection', position);
  });
  const typed = guarded.flatMap(({ offer, blocked, offered }, position) => [...(offered ? [] : [{ text: offer.name, position }]), ...blocked.map((text) => ({ text, position })), { text: offer.id, position }]);
  const instructions = [BUILT_IN_PROMPTS['ask.plan'].instructions, BUILT_IN_PROMPTS['ask.plan.repair'].instructions, PATTERN_CATALOG_INTRO, PATTERN_LABEL_NOTE, PATTERN_CATALOG_CUT_SENTENCE, descriptionWords()];
  return {
    check(parameters) {
      if (parameters['patterns'] !== expectedText) throw new PatternGuardError('catalog');
      const staticText = [...instructions, ...STATIC_PARAMETERS.map((name) => String(parameters[name] ?? ''))];
      const scanned = Object.entries(parameters).filter(([name]) => !NOT_SCANNED.includes(name));
      for (const { text, position } of typed) {
        if (staticText.some((part) => holds(part, text))) continue;
        if (scanned.some(([, value]) => holds(String(value), text))) throw new PatternGuardError('text', position);
      }
    },
  };
}

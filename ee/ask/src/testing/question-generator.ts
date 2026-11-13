import type { TypedToken } from './leakage-rig.js';

/** A small seeded generator (mulberry32): the same seed gives the same sequence. Test support only. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = ['zor', 'qui', 'vel', 'brax', 'mir', 'tho', 'kel', 'dru', 'fen', 'gal', 'hax', 'jor'];
const MIDDLES = ['va', 'lla', 'nde', 'ri', 'sko', 'mu', 'pe', 'xa'];
const ENDS = ['th', 'n', 'x', 'ric', 'dan', 'vik', 'lor', 'mar'];
const FRAMES: readonly ((mentions: readonly string[]) => string)[] = [
  (m) => `which are the same as ${m.join(' and ')}`,
  (m) => `which are the same as ${m.join(' and ')}?`,
  (m) => `which are linked to ${m.join(' and ')}`,
];

export interface GeneratedQuestion {
  readonly message: string;
  /** What the stand-in search resolves: the typed mention and the stable ID of the reference it finds. */
  readonly known: Readonly<Record<string, string>>;
  readonly tokens: readonly TypedToken[];
  /** The kinds of token in the question, in order: what a failure prints in place of the tokens. */
  readonly shape: readonly string[];
  /** True when the question holds a bare long number, which is meant to be blocked. */
  readonly blocked: boolean;
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const word = (random: () => number): string => pick(random, ONSETS) + pick(random, MIDDLES) + pick(random, ENDS);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const digits = (random: () => number, length: number): string => Array.from({ length }, () => Math.floor(random() * 10)).join('');

/** One question of a seed: one to three mentions of the kinds name, ID, email and number, in an allowed frame. */
export function generateQuestion(random: () => number, index: number): GeneratedQuestion {
  const count = 1 + Math.floor(random() * 3);
  const mentions: string[] = [];
  const tokens: TypedToken[] = [];
  const known: Record<string, string> = {};
  let blocked = false;
  for (let i = 0; i < count; i++) {
    const kind = pick(random, ['name', 'name', 'id', 'email', 'number'] as const);
    let text: string;
    if (kind === 'name') text = `${capital(word(random))} ${capital(word(random))}`;
    else if (kind === 'id') text = `${word(random).slice(0, 2).toUpperCase()}-${digits(random, 4 + Math.floor(random() * 4))}`;
    else if (kind === 'email') text = `${word(random)}.${word(random)}@${word(random)}.example.test`;
    else text = digits(random, 4 + Math.floor(random() * 6));
    mentions.push(text);
    tokens.push({ kind, text });
    if (kind === 'number') blocked = true;
    else known[text] = `G-${index}-${i}`;
  }
  return { message: pick(random, FRAMES)(mentions), known, tokens, shape: tokens.map((token) => token.kind), blocked };
}

export function generateQuestions(seed: number, count: number): readonly GeneratedQuestion[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => generateQuestion(random, index));
}

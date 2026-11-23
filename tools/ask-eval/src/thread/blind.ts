import { createHash } from 'node:crypto';
import type { EnrichedRepeat } from './enrich.js';
import { citedLinesOf, linesOfAnswer } from './lines.js';

export interface ArmRepeat {
  readonly arm: string;
  readonly repeat: number;
  readonly enriched: EnrichedRepeat;
}

export interface KeyEntry {
  readonly repeat: number;
  readonly turn: number;
  /** Label to arm, for this turn of this repeat. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface BlindOutput {
  /** One set per repeat, by repeat number, as text for the scorer. */
  readonly sets: ReadonlyMap<number, string>;
  /** The key: label to arm per turn per repeat, the seed and the manifest hash. Never referred to by a set. */
  readonly key: { readonly seed: string; readonly manifestSha256: string; readonly entries: readonly KeyEntry[] };
  /** The expected answers of each set (repeat, turn, label), the slots the scores must cover exactly. */
  readonly slots: readonly { readonly repeat: number; readonly turn: number; readonly label: string }[];
}

/** A seeded generator (mulberry32) over the hash of the seed text: the same seed gives the same order. */
function generator(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The order of the arms for one turn: a seeded shuffle of the arm names. */
export function permutationOf(arms: readonly string[], random: () => number): string[] {
  const order = [...arms];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other] as string, order[index] as string];
  }
  return order;
}

const LABELS = ['A', 'B', 'C', 'D'];
const NO_ANSWER = '(no answer: this turn did not run or did not give an answer)';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The answer as the scorer reads it: its sentences or table rows with their cites, and the notes the server wrote; never an id, a model name or an arm. */
function answerText(answer: unknown): string {
  if (!isRecord(answer)) return NO_ANSWER;
  const parts: string[] = [];
  if (Array.isArray(answer['sentences'])) for (const sentence of answer['sentences']) if (isRecord(sentence) && typeof sentence['text'] === 'string') parts.push(`- ${sentence['text']} [${Array.isArray(sentence['cites']) ? sentence['cites'].join(', ') : ''}]`);
  if (isRecord(answer['table']) && Array.isArray(answer['table']['rows'])) {
    const table = answer['table'];
    if (typeof table['title'] === 'string') parts.push(`Table: ${table['title']}`);
    if (Array.isArray(table['columns'])) parts.push(`| ${table['columns'].join(' | ')} | cites |`);
    for (const row of table['rows'] as unknown[]) if (isRecord(row) && Array.isArray(row['cells'])) parts.push(`| ${row['cells'].join(' | ')} | ${Array.isArray(row['cites']) ? row['cites'].join(', ') : ''} |`);
  }
  for (const name of ['sentence', 'pointer', 'lastCallNote', 'noDescription']) if (typeof answer[name] === 'string') parts.push(`(server note) ${answer[name]}`);
  return parts.length === 0 ? NO_ANSWER : parts.join('\n');
}

function coverageText(answer: unknown): string {
  if (!isRecord(answer) || !isRecord(answer['coverage'])) return '(none)';
  const coverage = answer['coverage'];
  return [coverage['retrieval'], coverage['summary']].filter((part): part is string => typeof part === 'string').map((part) => part.replace(/\s+/gu, ' ').trim()).join(' | ');
}

/** The leak check: a forbidden text (an arm name, a trace id, a model name, a manifest or file name) in a written set fails and names the turn. */
export function leakIn(set: string, forbidden: readonly string[]): string | undefined {
  return forbidden.find((text) => text !== '' && set.includes(text));
}

/**
 * The blind sets and the key. For every turn the answers of the arms appear in a seeded random order under neutral labels, each with the message, the answer, the cited lines the model was shown, the coverage lines and the
 * answer's own earlier questions and replies (C2); a turn that did not run or failed is a slot with no answer, never dropped. A set holding an arm name, a trace id or a model name is refused.
 */
export function blindSets(repeats: readonly ArmRepeat[], options: { readonly seed: string; readonly manifestSha256: string; readonly forbidden: readonly string[] }): BlindOutput {
  const random = generator(options.seed);
  const arms = [...new Set(repeats.map((entry) => entry.arm))].sort();
  const numbers = [...new Set(repeats.map((entry) => entry.repeat))].sort((a, b) => a - b);
  const turnCount = Math.max(...repeats.map((entry) => entry.enriched.file.turns.length === 0 ? 0 : Math.max(...entry.enriched.file.turns.map((turn) => turn.n))), 0);
  const manifestTurns = Math.max(turnCount, ...repeats.map((entry) => entry.enriched.file.turns.length));
  const sets = new Map<number, string>();
  const entries: KeyEntry[] = [];
  const slots: { repeat: number; turn: number; label: string }[] = [];
  for (const repeat of numbers) {
    const mine = repeats.filter((entry) => entry.repeat === repeat);
    const expected = Math.max(...mine.map((entry) => entry.enriched.file.turns.length), manifestTurns);
    const out: string[] = [`# Set ${repeat}`, ''];
    for (let turn = 1; turn <= expected; turn += 1) {
      const order = permutationOf(arms, random);
      const labels: Record<string, string> = {};
      order.forEach((arm, index) => {
        labels[LABELS[index] as string] = arm;
      });
      entries.push({ repeat, turn, labels });
      out.push(`## Turn ${turn}`);
      const first = mine[0]?.enriched.file.turns[turn - 1];
      out.push(`Message: ${first?.message ?? '(not run)'}`, '');
      for (const [label, arm] of Object.entries(labels)) {
        const source = mine.find((entry) => entry.arm === arm);
        const index = turn - 1;
        const record = source?.enriched.file.turns[index];
        const turnRecords = source?.enriched.records[index];
        out.push(`### Answer ${label}`);
        if (record === undefined || record.status === 'failed') out.push(NO_ANSWER);
        else {
          out.push(answerText(record.answer), `Coverage: ${coverageText(record.answer)}`);
          const cited = citedLinesOf(record.answer, turnRecords === undefined ? undefined : linesOfAnswer(turnRecords));
          for (const [key, line] of cited.mapped) out.push(`Cited line ${key}: ${line}`);
          if (cited.missing.length > 0) out.push(`Cited keys with no line: ${cited.missing.join(', ')}`);
          const earlier = (source?.enriched.file.turns ?? []).slice(0, index);
          if (earlier.length > 0) {
            out.push('Earlier in this answerer\'s thread:');
            for (const turnBefore of earlier) out.push(`  Q${turnBefore.n}: ${turnBefore.message}`, ...answerText(turnBefore.answer).split('\n').map((line) => `  A${turnBefore.n}: ${line}`));
          }
        }
        out.push('');
        slots.push({ repeat, turn, label });
      }
    }
    const text = `${out.join('\n')}\n`;
    const leaked = leakIn(text, options.forbidden);
    if (leaked !== undefined) throw new Error(`a blind set of repeat ${repeat} holds identifying text (${leaked.length} characters)`);
    sets.set(repeat, text);
  }
  return { sets, key: { seed: options.seed, manifestSha256: options.manifestSha256, entries }, slots };
}

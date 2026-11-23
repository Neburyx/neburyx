import { createHash } from 'node:crypto';
import type { EnrichedRepeat } from './enrich.js';
import { UsageError } from '../questions.js';

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
  readonly key: { readonly seed: string; readonly manifestSha256: string; readonly entries: readonly KeyEntry[]; readonly sets: Readonly<Record<string, string>>; readonly noAnswer: readonly string[] };
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

const QUALITY = /\b(exact|estimated|lower[ -]?bound|unknown)\b/iu;

/**
 * The coverage lines of an answer in one neutral form: whitespace collapsed, the separators made one, the quality words written one way. Each line must hold a count and a quality label, so a format that cannot be
 * made neutral fails and names the turn rather than reaching a scorer in an arm-specific shape.
 */
function coverageText(answer: unknown, where: string): string {
  if (!isRecord(answer) || answer['status'] !== 'answered' || answer['route'] === 'refuse') return '(none)';
  const coverage = answer['coverage'];
  if (!isRecord(coverage)) throw new UsageError(`${where}: the coverage lines are missing, so they cannot be made neutral`);
  const lines = ['retrieval', 'summary'].map((name) => coverage[name]).filter((line) => line !== undefined);
  if (lines.length === 0 || !lines.every((line): line is string => typeof line === 'string')) throw new UsageError(`${where}: the coverage lines are not text, so they cannot be made neutral`);
  const retrieval = coverage['retrieval'];
  if (typeof retrieval === 'string' && (!/\d/u.test(retrieval) || !QUALITY.test(retrieval))) throw new UsageError(`${where}: the retrieval line holds no count or no quality label, so it cannot be made neutral`);
  return lines.map((line) => line.replace(/[·•|]/gu, ' · ').replace(/lower[ -]?bound/giu, 'lower bound').replace(/\s+/gu, ' ').trim()).join(' | ');
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
  if (repeats.length === 0) throw new UsageError('no run was given');
  const seen = new Set<string>();
  for (const entry of repeats) {
    const file = entry.enriched.file;
    const identity = `${entry.arm}/${entry.repeat}`;
    if (seen.has(identity)) throw new UsageError(`the run of arm ${entry.arm} repeat ${entry.repeat} was given twice`);
    seen.add(identity);
    if (file.arm !== entry.arm || file.repeat !== entry.repeat) throw new UsageError(`a records file says arm ${file.arm} repeat ${file.repeat} but was given as arm ${entry.arm} repeat ${entry.repeat}`);
    if (file.manifest.sha256 !== options.manifestSha256) throw new UsageError(`the run of arm ${entry.arm} repeat ${entry.repeat} was made from another manifest`);
    if (JSON.stringify(file.expectedMessages) !== JSON.stringify(repeats[0]?.enriched.file.expectedMessages)) throw new UsageError(`the run of arm ${entry.arm} repeat ${entry.repeat} was to send other messages than the first run`);
  }
  const arms = [...new Set(repeats.map((entry) => entry.arm))].sort();
  const numbers = [...new Set(repeats.map((entry) => entry.repeat))].sort((a, b) => a - b);
  for (const arm of arms) for (const repeat of numbers) if (!seen.has(`${arm}/${repeat}`)) throw new UsageError(`the run of arm ${arm} repeat ${repeat} is missing`);
  const expected = repeats[0]?.enriched.file.expectedMessages ?? [];
  const sets = new Map<number, string>();
  const entries: KeyEntry[] = [];
  const slots: { repeat: number; turn: number; label: string }[] = [];
  const noAnswer: string[] = [];
  const hashes: Record<string, string> = {};
  for (const repeat of numbers) {
    const mine = repeats.filter((entry) => entry.repeat === repeat);
    const out: string[] = [`# Set ${repeat}`, ''];
    for (let turn = 1; turn <= expected.length; turn += 1) {
      const order = permutationOf(arms, random);
      const labels: Record<string, string> = {};
      order.forEach((arm, index) => {
        labels[LABELS[index] as string] = arm;
      });
      entries.push({ repeat, turn, labels });
      out.push(`## Turn ${turn}`);
      out.push(`Message: ${expected[turn - 1] ?? ''}`, '');
      for (const [label, arm] of Object.entries(labels)) {
        const source = mine.find((entry) => entry.arm === arm);
        const index = turn - 1;
        const record = source?.enriched.file.turns[index];
        const evidence = source?.enriched.evidence[index];
        out.push(`### Answer ${label}`);
        if (record === undefined || record.status === 'failed') {
          out.push(NO_ANSWER);
          noAnswer.push(`${repeat}/${turn}/${label}`);
        } else {
          const shown = answerText(record.answer);
          if (shown === NO_ANSWER) noAnswer.push(`${repeat}/${turn}/${label}`);
          out.push(shown, `Coverage: ${coverageText(record.answer, `repeat ${repeat} turn ${turn} of arm ${arm}`)}`);
          for (const [key, line] of evidence?.citations.mapped ?? []) out.push(`Cited line ${key}: ${line}`);
          if ((evidence?.citations.missing.length ?? 0) > 0) out.push(`Cited keys with no line: ${evidence?.citations.missing.join(', ') ?? ''}`);
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
    hashes[String(repeat)] = createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return { sets, key: { seed: options.seed, manifestSha256: options.manifestSha256, entries, sets: hashes, noAnswer }, slots };
}

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Slot {
  readonly repeat: number;
  readonly turn: number;
  readonly label: string;
}

export interface Score {
  readonly repeat: number;
  readonly turn: number;
  readonly label: string;
  readonly c1: 0 | 1;
  readonly c2: 0 | 1;
  readonly c3: 0 | 1;
  readonly c4: 0 | 1;
}

export interface ScoreFile {
  /** Who scored: `codex`, `opus` run by the harness, or a name given to scores ingested from a file. */
  readonly scorer: string;
  /** `harness` when this tool ran the scorer and counted its calls; `ingested` for scores made outside it. */
  readonly origin: 'harness' | 'ingested';
  /** The invocations the harness made (a count it enforced); absent for an ingested file. */
  readonly invocations?: number;
  readonly scores: readonly Score[];
}

/** A scorer run: the prompt goes in, the reply text comes out. A failure to run is `ScorerUnavailable`. */
export type Runner = (prompt: string) => Promise<string>;

export class ScorerUnavailable extends Error {
  constructor(cause: string) {
    super(`scorer unavailable: ${cause}`);
    this.name = 'ScorerUnavailable';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const RESPONSE_SHAPE = 'Reply with one JSON array and nothing else. One object per answer: {"repeat":<number>,"turn":<number>,"label":"<A|B|C|D>","c1":0|1,"c2":0|1,"c3":0|1,"c4":0|1}.';

/** The prompt of a set: the private rubric as given, the set, and the fixed reply shape. The scorer receives nothing else. */
export function promptOf(rubric: string, set: string): string {
  return `${rubric.trim()}\n\n${RESPONSE_SHAPE}\nScore every answer of the set below, once, for criteria C1 to C4.\n\n${set}`;
}

/** The scores of a reply: the first JSON array in it, each entry with its slot and four scores; a reply of another shape gives undefined. */
export function parseScores(reply: string): Score[] | undefined {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const scores: Score[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return undefined;
    const bit = (value: unknown): 0 | 1 | undefined => (value === 0 || value === 1 ? value : undefined);
    const [c1, c2, c3, c4] = [bit(entry['c1']), bit(entry['c2']), bit(entry['c3']), bit(entry['c4'])];
    if (typeof entry['repeat'] !== 'number' || typeof entry['turn'] !== 'number' || typeof entry['label'] !== 'string' || c1 === undefined || c2 === undefined || c3 === undefined || c4 === undefined) return undefined;
    scores.push({ repeat: entry['repeat'], turn: entry['turn'], label: entry['label'], c1, c2, c3, c4 });
  }
  return scores;
}

const slotKey = (slot: Slot): string => `${slot.repeat}/${slot.turn}/${slot.label}`;

/** The problems of a score list against the slots it must cover exactly: a missing, duplicate or extra entry, named by slot. A slot with no answer is the caller's to zero (`zeroNoAnswers`). */
export function scoreProblems(slots: readonly Slot[], scores: readonly Score[]): string[] {
  const expected = new Set(slots.map(slotKey));
  const seen = new Map<string, number>();
  for (const score of scores) seen.set(slotKey(score), (seen.get(slotKey(score)) ?? 0) + 1);
  const problems: string[] = [];
  for (const key of expected) if (!seen.has(key)) problems.push(`missing score for ${key}`);
  for (const [key, count] of seen) {
    if (count > 1) problems.push(`duplicate score for ${key}`);
    if (!expected.has(key)) problems.push(`extra score for ${key}`);
  }
  return problems;
}

/** Scores of an answer that does not exist are zero on every criterion: no answer earns no point. */
export function zeroNoAnswers(scores: readonly Score[], noAnswer: ReadonlySet<string>): Score[] {
  return scores.map((score) => (noAnswer.has(slotKey(score)) ? { ...score, c1: 0, c2: 0, c3: 0, c4: 0 } : score));
}

/** Scores a set: one run, and one more with a fixed note when the reply is not the shape or does not cover the slots; a second bad reply fails the set naming it. */
export async function scoreSet(runner: Runner, rubric: string, set: string, slots: readonly Slot[], name: string): Promise<Score[]> {
  const prompt = promptOf(rubric, set);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reply = await runner(attempt === 1 ? prompt : `${prompt}\n\nYour last reply was not valid: ${RESPONSE_SHAPE}`);
    const scores = parseScores(reply);
    if (scores !== undefined && scoreProblems(slots, scores).length === 0) return scores;
  }
  throw new Error(`the scorer's replies for ${name} are not scores that cover its answers exactly`);
}

/** A runner that stops at a number of invocations: the count the approver approved. */
export function countedRunner(runner: Runner, maxInvocations: number): { readonly run: Runner; readonly made: () => number } {
  let made = 0;
  return {
    run: async (prompt) => {
      if (made >= maxInvocations) throw new ScorerUnavailable(`the approved number of invocations (${maxInvocations}) is used up`);
      made += 1;
      return runner(prompt);
    },
    made: () => made,
  };
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => { readonly stdin: { end(text: string): void } | null; readonly stdout: NodeJS.ReadableStream | null; readonly stderr: NodeJS.ReadableStream | null; on(event: 'close', listener: (code: number | null) => void): unknown; on(event: 'error', listener: () => void): unknown };

const QUOTA = /usage limit|quota|rate limit|try again at/iu;

function runCommand(spawn: Spawn, command: string, args: readonly string[], prompt: string): Promise<{ readonly code: number | null; readonly out: string; readonly err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', () => reject(new ScorerUnavailable('the command could not be started')));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin?.end(prompt);
  });
}

/** The Codex CLI as the workflows call it: the named model, high effort, read-only, the prompt on its input; out of quota is `ScorerUnavailable`. */
export function codexRunner(spawn: Spawn = nodeSpawn as unknown as Spawn): Runner {
  return async (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-scorer-'));
    const reply = join(dir, 'reply.txt');
    try {
      const result = await runCommand(spawn, 'codex', ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-s', 'read-only', '--skip-git-repo-check', '-C', dir, '-o', reply, '-'], prompt);
      if (QUOTA.test(`${result.out}\n${result.err}`)) throw new ScorerUnavailable('out of quota');
      if (result.code !== 0) throw new ScorerUnavailable('the command failed');
      return readFileSync(reply, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** An Opus agent run by the harness through the Claude CLI in print mode with no tools; out of quota is `ScorerUnavailable`. */
export function opusRunner(spawn: Spawn = nodeSpawn as unknown as Spawn): Runner {
  return async (prompt) => {
    const result = await runCommand(spawn, 'claude', ['-p', '--model', 'opus', '--allowedTools', '', '--output-format', 'text'], prompt);
    if (QUOTA.test(`${result.out}\n${result.err}`) && result.code !== 0) throw new ScorerUnavailable('out of quota');
    if (result.code !== 0) throw new ScorerUnavailable('the command failed');
    return result.out;
  };
}

export interface Approval {
  readonly exceptionConfirmed: boolean;
  readonly invocations: number;
  readonly by: string;
  readonly at: string;
}

/** Reads an approval file: the approver's written confirmation of the exception and the number of invocations; anything else is no approval. */
export function parseApproval(text: string): Approval | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['exceptionConfirmed'] !== true || typeof parsed['invocations'] !== 'number' || !Number.isInteger(parsed['invocations']) || parsed['invocations'] < 1 || typeof parsed['by'] !== 'string' || typeof parsed['at'] !== 'string') return undefined;
  return { exceptionConfirmed: true, invocations: parsed['invocations'], by: parsed['by'], at: parsed['at'] };
}

/** The agreement of two scorers on the same slots, per criterion and overall, in percent; the overall below 90 marks the set indicative. */
export function agreement(a: readonly Score[], b: readonly Score[]): { readonly overall: number; readonly c1: number; readonly c2: number; readonly c3: number; readonly c4: number; readonly slots: number; readonly indicative: boolean } {
  const byKey = new Map(b.map((score) => [slotKey(score), score]));
  const pairs = a.flatMap((score) => {
    const other = byKey.get(slotKey(score));
    return other === undefined ? [] : [[score, other] as const];
  });
  const share = (pick: (score: Score) => number): number => (pairs.length === 0 ? 0 : (pairs.filter(([x, y]) => pick(x) === pick(y)).length / pairs.length) * 100);
  const [c1, c2, c3, c4] = [share((s) => s.c1), share((s) => s.c2), share((s) => s.c3), share((s) => s.c4)];
  const overall = (c1 + c2 + c3 + c4) / 4;
  return { overall, c1, c2, c3, c4, slots: pairs.length, indicative: overall < 90 };
}

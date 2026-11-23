import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseApprovalFile, parseScoreList, type Score, type ScoreFile } from './schemas.js';

export interface Slot {
  readonly repeat: number;
  readonly turn: number;
  readonly label: string;
}

/** A scorer run: the prompt goes in, the reply text and the number of model calls the run made come out. A failure to run is `ScorerUnavailable`. */
export type Runner = (prompt: string) => Promise<{ readonly text: string; readonly calls: number }>;

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

/** The scores of a reply: the first JSON array in it, each entry with its slot and four scores of 0 or 1; a reply of another shape gives undefined. */
export function parseScores(reply: string): Score[] | undefined {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end < start) return undefined;
  try {
    return parseScoreList(JSON.parse(reply.slice(start, end + 1)));
  } catch {
    return undefined;
  }
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
    const scores = parseScores(reply.text);
    if (scores !== undefined && scoreProblems(slots, scores).length === 0) return scores;
  }
  throw new Error(`the scorer's replies for ${name} are not scores that cover its answers exactly`);
}

/**
 * A runner that stops at a number of model calls: the count the approver approved. Each launch is counted, and reserved durably through `reserve` when one is given, before the program starts, so a launch that fails or is cut off
 * still counts; a run that reports more calls than were left is refused and counted in full.
 */
export function countedRunner(runner: Runner, maxCalls: number, reserve?: () => void): { readonly run: Runner; readonly made: () => number } {
  let made = 0;
  return {
    run: async (prompt) => {
      if (made >= maxCalls) throw new ScorerUnavailable(`the approved number of calls (${maxCalls}) is used up`);
      reserve?.();
      made += 1;
      const result = await runner(prompt);
      made += Math.max(0, result.calls - 1);
      if (made > maxCalls) throw new ScorerUnavailable(`the run made ${made} calls and the approved number is ${maxCalls}`);
      return result;
    },
    made: () => made,
  };
}

export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => { readonly stdin: { end(text: string): void } | null; readonly stdout: NodeJS.ReadableStream | null; readonly stderr: NodeJS.ReadableStream | null; on(event: 'close', listener: (code: number | null) => void): unknown; on(event: 'error', listener: () => void): unknown };

/** The real `spawn` as the runners use it; the wrapper is the one place the library's wider child type is narrowed to what the runners read of it. */
const realSpawn: Spawn = (command, args, options) => nodeSpawn(command, [...args], options);

const QUOTA = /usage limit|quota|rate limit|try again at/iu;

/** The environment a scorer is given: a short allowlist of what its program needs to run and sign in with its own account, and nothing of the product's settings, database or provider key. */
function scorerEnv(source: NodeJS.ProcessEnv, own: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', ...own]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function runCommand(spawn: Spawn, command: string, args: readonly string[], prompt: string, options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): Promise<{ readonly code: number | null; readonly out: string; readonly err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd, env: options.env });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', () => reject(new ScorerUnavailable('the command could not be started')));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin?.end(prompt);
  });
}

/** The Codex CLI as the workflows call it: the named model, high effort, read-only, an empty working folder of its own, a home and configuration folder of its own that holds only its sign-in, an environment of its own and the prompt on its input; out of quota is `ScorerUnavailable`. */
export function codexRunner(spawn: Spawn = realSpawn, env: NodeJS.ProcessEnv = process.env): Runner {
  return async (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-scorer-'));
    const reply = join(dir, 'reply.txt');
    try {
      const args = ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-c', 'shell_environment_policy.inherit="none"', '-s', 'read-only', '--skip-git-repo-check', '-C', dir, '-o', reply, '-'];
      const home = join(dir, 'home');
      mkdirSync(home);
      const signIn = join(env['CODEX_HOME'] ?? join(env['HOME'] ?? '', '.codex'), 'auth.json');
      if (existsSync(signIn)) copyFileSync(signIn, join(home, 'auth.json'));
      const result = await runCommand(spawn, 'codex', args, prompt, { cwd: dir, env: { ...scorerEnv(env, ['OPENAI_API_KEY']), HOME: home, CODEX_HOME: home } });
      if (QUOTA.test(`${result.out}\n${result.err}`)) throw new ScorerUnavailable('out of quota');
      if (result.code !== 0) throw new ScorerUnavailable('the command failed');
      return { text: readFileSync(reply, 'utf8'), calls: 1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The key the Opus scorer signs in with: the one in its environment, else the one in the file the product's own key setting names, read here and never printed or kept. */
function opusKey(env: NodeJS.ProcessEnv): string | undefined {
  const own = env['ANTHROPIC_API_KEY'];
  if (own !== undefined && own !== '') return own;
  const path = env['NEBURYX_ASK_API_KEY_FILE'];
  if (path === undefined || path === '') return undefined;
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * An Opus agent run by the harness through the Claude CLI in print mode: no tools, no extra servers or commands, nothing kept of the session, bare mode (no hooks, memory or settings), an empty working folder and configuration
 * folder of its own and an environment of its own. It runs only with an API key of its own, taken by reference from its environment or from the product's key file; signed in through the user's account it would see that account's
 * settings and memory, so with no key the scoring waits (`ScorerUnavailable`). With no tool a run is one model call; the CLI states the turns it made, and that figure is the count of calls, so a run that made more than one is counted in full and refused by the cap.
 */
export function opusRunner(spawn: Spawn = realSpawn, env: NodeJS.ProcessEnv = process.env): Runner {
  return async (prompt) => {
    const key = opusKey(env);
    if (key === undefined) throw new ScorerUnavailable('Opus scores only in bare mode with an API key of its own (ANTHROPIC_API_KEY, or the product key file): none is available, so scoring waits');
    const dir = mkdtempSync(join(tmpdir(), 'thread-scorer-'));
    try {
      const args = ['-p', '--model', 'opus', '--bare', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json'];
      const home = join(dir, 'home');
      mkdirSync(home);
      const result = await runCommand(spawn, 'claude', args, prompt, { cwd: dir, env: { ...scorerEnv(env, []), ANTHROPIC_API_KEY: key, HOME: home, CLAUDE_CONFIG_DIR: home } });
      if (QUOTA.test(`${result.out}\n${result.err}`) && result.code !== 0) throw new ScorerUnavailable('out of quota');
      if (result.code !== 0) throw new ScorerUnavailable('the command failed');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.out);
      } catch {
        throw new ScorerUnavailable('the reply is not the JSON the command was asked for');
      }
      if (!isRecord(parsed) || typeof parsed['result'] !== 'string' || typeof parsed['num_turns'] !== 'number' || !Number.isInteger(parsed['num_turns']) || parsed['num_turns'] < 1) throw new ScorerUnavailable('the reply does not state the calls it made');
      return { text: parsed['result'], calls: parsed['num_turns'] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  try {
    return parseApprovalFile(JSON.parse(text));
  } catch {
    return undefined;
  }
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

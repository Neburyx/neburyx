import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError } from './questions.js';

const MIN_LINE_LENGTH = 40;
const SKIPPED = new Set(['.git', 'node_modules', 'dist']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ScanInput {
  /** Whole wordings of questions. */
  readonly questions: readonly string[];
  /** Intent names, matched as whole tokens. */
  readonly intentNames: readonly string[];
  /** The text of a classification file: a line counts only when it is whole, trimmed and at least `MIN_LINE_LENGTH` long. */
  readonly classification: string;
  /** Paths (files or folders) the scan leaves out. */
  readonly exclude: readonly string[];
  /** Paths whose lines are not private (the text the private classification shares with the public ones, such as the reply form): a line found there is not counted. */
  readonly common: readonly string[];
}

export interface ScanCounts {
  readonly questions: number;
  readonly intentNames: number;
  readonly lines: number;
  /** Long classification lines left out of the count because a `common` path holds them too. */
  readonly exempted: number;
  /** Files over the size limit, which the scan could not read: a scan with any is not clean. */
  readonly skipped: number;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function* filesUnder(root: string, exclude: ReadonlySet<string>, skipped: { count: number }): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (SKIPPED.has(entry.name) || exclude.has(resolve(path))) continue;
    if (entry.isDirectory()) yield* filesUnder(path, exclude, skipped);
    else if (entry.isFile()) {
      if (statSync(path).size <= MAX_FILE_BYTES) yield path;
      else skipped.count += 1;
    }
  }
}

/** How many of the private questions, intent names and long classification lines occur anywhere under a tree. Counts only: nothing found is ever reported. */
export function scanTree(root: string, input: ScanInput): ScanCounts {
  const exclude = new Set(input.exclude.map((path) => resolve(path)));
  const skipped = { count: 0 };
  const scanned = resolve(root);
  for (const path of input.common) {
    const given = resolve(path);
    if (given === scanned || scanned.startsWith(`${given}/`)) throw new UsageError('a common path may not be the scanned tree or contain it');
  }
  const shared = new Set<string>();
  for (const path of input.common) {
    const found = statSync(resolve(path));
    for (const file of found.isDirectory() ? filesUnder(resolve(path), new Set(), { count: 0 }) : [resolve(path)]) for (const line of readFileSync(file, 'utf8').split('\n')) shared.add(line.trim());
  }
  const longLines = input.classification.split('\n').map((line) => line.trim()).filter((line) => line.length >= MIN_LINE_LENGTH);
  const wholeLines = new Set(longLines.filter((line) => !shared.has(line)));
  const exempted = new Set(longLines.filter((line) => shared.has(line))).size;
  const names = input.intentNames.map((name) => ({ name, pattern: new RegExp(`(?<![A-Za-z0-9_-])${escaped(name)}(?![A-Za-z0-9_-])`) }));
  const foundQuestions = new Set<string>();
  const foundNames = new Set<string>();
  const foundLines = new Set<string>();
  for (const path of filesUnder(scanned, exclude, skipped)) {
    const text = readFileSync(path, 'utf8');
    if (text.includes('\u0000')) continue;
    for (const wording of input.questions) if (!foundQuestions.has(wording) && text.includes(wording)) foundQuestions.add(wording);
    for (const { name, pattern } of names) if (!foundNames.has(name) && pattern.test(text)) foundNames.add(name);
    if (wholeLines.size > 0) for (const line of text.split('\n')) if (wholeLines.has(line.trim())) foundLines.add(line.trim());
  }
  return { questions: foundQuestions.size, intentNames: foundNames.size, lines: foundLines.size, exempted, skipped: skipped.count };
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadQuestions } from './questions.js';

const PLACEHOLDER = /‹[A-Za-z0-9_-]+#[1-9][0-9]*›/g;
const PLACEHOLDER_PATTERN = '‹[^›]*›';
const SKIPPED = new Set(['node_modules', '.git', 'dist']);
const MAX_FILE_BYTES = 2_000_000;

function filesUnder(root: string): readonly string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    if (SKIPPED.has(name)) continue;
    const path = join(root, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...filesUnder(path));
    else if (info.size <= MAX_FILE_BYTES) files.push(path);
  }
  return files;
}

function patternOf(wording: string): RegExp {
  const parts = wording.replace(/\s+/g, ' ').trim().split(PLACEHOLDER).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join(PLACEHOLDER_PATTERN));
}

/** How many questions of a file appear whole (a placeholder matching any placeholder) in a file of the tree; the number is all it returns. */
export function countWordingHits(questionsPath: string, root: string): number {
  const texts = filesUnder(root).map((path) => readFileSync(path, 'utf8').replace(/\s+/g, ' '));
  return loadQuestions(questionsPath).filter((question) => {
    const pattern = patternOf(question.wording);
    return texts.some((text) => pattern.test(text));
  }).length;
}

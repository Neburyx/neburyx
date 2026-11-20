import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

const CHECKS_SOURCE = resolve(import.meta.dirname, '../../../ee/ai-runtime/src/reply-checks.ts');

export interface Mutation {
  readonly name: string;
  /** The text of the product's source that is taken out, and what stands in its place. */
  readonly from: string;
  readonly to: string;
}

/** The product's checks with one of its tests taken out of the source: the module the mutated source makes, which has no import but types. */
export async function mutatedChecks(mutation: Mutation): Promise<Record<string, unknown>> {
  const source = readFileSync(CHECKS_SOURCE, 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`the product's checks no longer hold the text of the mutation ${mutation.name}: update the mutation`);
  const mutated = source.replace(mutation.from, mutation.to);
  const { outputText } = ts.transpileModule(mutated, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const directory = mkdtempSync(join(tmpdir(), 'nbx-mutant-'));
  try {
    const file = join(directory, 'checks.mjs');
    writeFileSync(file, outputText);
    return z.record(z.string(), z.unknown()).parse(await import(pathToFileURL(file).href));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const CASE_SUMMARY = resolve(import.meta.dirname, '../../../ee/ask/src/case-summary');

/**
 * Another module of the case summary with one piece of its source taken out. Its relative imports are rewritten to the product's own sources, which the runtime reads as they are (types stripped).
 */
export async function mutatedModule(file: string, mutation: Mutation): Promise<Record<string, unknown>> {
  const source = readFileSync(join(CASE_SUMMARY, file), 'utf8');
  if (!source.includes(mutation.from)) throw new Error(`the product's ${file} no longer holds the text of the mutation ${mutation.name}: update the mutation`);
  const mutated = source.replace(mutation.from, mutation.to).replace(/from '(\.{1,2}\/[a-z/-]+)\.js'/gu, (_whole, name: string) => `from '${pathToFileURL(resolve(CASE_SUMMARY, `${name}.ts`)).href}'`);
  const { outputText } = ts.transpileModule(mutated, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const directory = mkdtempSync(join(tmpdir(), 'nbx-mutant-'));
  try {
    const target = join(directory, 'module.mjs');
    writeFileSync(target, outputText);
    return z.record(z.string(), z.unknown()).parse(await import(pathToFileURL(target).href));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The export's renderer over a copy of the judgement of a draft (`rejudge.ts`) with one piece of its source taken out: the copy of the renderer imports the changed judgement and the product's own sources for everything else.
 */
export async function mutatedRenderer(mutation: Mutation): Promise<Record<string, unknown>> {
  const judged = readFileSync(join(CASE_SUMMARY, 'rejudge.ts'), 'utf8');
  if (!judged.includes(mutation.from)) throw new Error(`the product's rejudge.ts no longer holds the text of the mutation ${mutation.name}: update the mutation`);
  const rewritten = (text: string, own: Readonly<Record<string, string>> = {}): string => text.replace(/from '(\.{1,2}\/[a-z/-]+)\.js'/gu, (_whole, name: string) => `from '${own[name] ?? pathToFileURL(resolve(CASE_SUMMARY, `${name}.ts`)).href}'`);
  const transpile = (text: string): string => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const directory = mkdtempSync(join(tmpdir(), 'nbx-mutant-'));
  try {
    const rejudge = join(directory, 'rejudge.mjs');
    writeFileSync(rejudge, transpile(rewritten(judged.replace(mutation.from, mutation.to))));
    const render = join(directory, 'export-render.mjs');
    writeFileSync(render, transpile(rewritten(readFileSync(join(CASE_SUMMARY, 'export-render.ts'), 'utf8'), { './rejudge': pathToFileURL(rejudge).href })));
    return z.record(z.string(), z.unknown()).parse(await import(pathToFileURL(render).href));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

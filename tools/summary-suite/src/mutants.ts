import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

const CHECKS_SOURCE = resolve(import.meta.dirname, '../../../ee/ask/src/case-summary/checks.ts');

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

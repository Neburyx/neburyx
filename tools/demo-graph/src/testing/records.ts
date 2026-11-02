import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Generated } from '../generate.js';

const lineSchema = z.object({ p: z.record(z.string(), z.unknown()), f: z.string().optional(), t: z.string().optional() });
const manifestSchema = z.object({
  version: z.number(),
  seed: z.number(),
  sourceId: z.string(),
  files: z.array(z.object({ kind: z.string(), type: z.string(), label: z.string(), from: z.string(), to: z.string(), file: z.string(), count: z.number(), sha256: z.string() })),
});

export type Line = z.infer<typeof lineSchema>;
export type LooseManifest = z.infer<typeof manifestSchema>;

export function parseLine(line: string): Line {
  return lineSchema.parse(JSON.parse(line));
}

export function linesOf(generated: Generated, type: string): Line[] {
  return (generated.files.find((file) => file.type === type)?.lines ?? []).map(parseLine);
}

export function readManifest(directory: string): LooseManifest {
  return manifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
}

export function tagText(value: unknown, tag: '$int' | '$date' | '$datetime'): string {
  const text = z.record(z.string(), z.string()).parse(value)[tag];
  if (text === undefined) throw new Error('the value does not carry that tag');
  return text;
}

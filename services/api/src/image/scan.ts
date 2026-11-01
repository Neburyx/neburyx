import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const manifestSchema = z.array(z.object({ Layers: z.array(z.string()) })).min(1);
const GREP_NO_MATCH = 1;
const NAMES_OF_CONFIGURATION = /(^|\/)(neburyx\.yaml|\.env[^/]*)$/;

export async function extractLayers(saved: string, into: string): Promise<readonly string[]> {
  const [image] = manifestSchema.parse(JSON.parse(readFileSync(join(saved, 'manifest.json'), 'utf8')));
  const folders: string[] = [];
  for (const [index, layer] of (image?.Layers ?? []).entries()) {
    const target = join(into, `layer-${index}`);
    mkdirSync(target);
    await run('tar', ['-xf', join(saved, layer), '-C', target], { maxBuffer: 256 * 1024 * 1024 });
    folders.push(target);
  }
  return folders;
}

export async function containsText(folder: string, text: string): Promise<boolean> {
  try {
    await run('grep', ['-rlF', '--', text, folder], { maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === GREP_NO_MATCH) return false;
    throw error;
  }
}

export function configurationFilesIn(folder: string): readonly string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((entry) => NAMES_OF_CONFIGURATION.test(entry));
}

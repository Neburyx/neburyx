import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';

/** The most characters of the preset's entity type and stable ID, and of its case reference: the limits the API's mapping holds a demo case to. */
export const MAX_PRESET_TEXT = 200;
export const MAX_PRESET_CASE_REF = 100;

const UNUSABLE_CHARACTER = /[\p{Cc}\p{Cs}]/u;

const presetText = (limit: number) =>
  z
    .string()
    .refine((value) => [...value].length >= 1 && [...value].length <= limit && !UNUSABLE_CHARACTER.test(value));

export const presetSchema = z.strictObject({
  entity: z.strictObject({ type: presetText(MAX_PRESET_TEXT), id: presetText(MAX_PRESET_TEXT) }),
  case_ref: presetText(MAX_PRESET_CASE_REF),
});

export type RawPreset = z.infer<typeof presetSchema>;

export class PresetError extends Error {}

function placeOf(path: readonly PropertyKey[]): string {
  return path.map(String).join('.') || 'preset';
}

/** Reads the preset of a `cases.yaml`: nothing when the file does not exist; an error that names the place and never the value when the file or its preset is not usable. */
export function readPreset(file: string): RawPreset | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new PresetError('the cases file cannot be read');
  }
  const document = parseDocument(text);
  let data: unknown;
  try {
    data = document.errors.length > 0 ? undefined : document.toJS();
  } catch {
    data = undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('preset' in data)) throw new PresetError('the cases file has no preset');
  const parsed = presetSchema.safeParse(data.preset);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new PresetError(`the preset is not usable at ${placeOf(issue?.path ?? [])}`);
  }
  return parsed.data;
}

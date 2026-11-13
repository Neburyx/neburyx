import { readFileSync } from 'node:fs';
import { replaySchema, type Replay } from './types.js';

export class ReplayFileError extends Error {}

export function parseReplay(text: string): Replay {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ReplayFileError('the replay file is not valid JSON');
  }
  const parsed = replaySchema.safeParse(data);
  if (!parsed.success) throw new ReplayFileError('the replay file is malformed');
  return parsed.data;
}

export function loadReplay(path: string): Replay {
  return parseReplay(readFileSync(path, 'utf8'));
}

import { hkdfSync } from 'node:crypto';
import { REFERENCE_KEY_BYTES } from '../db/reference-key-repository.js';

const KEY_BYTES = 32;

/** One label for each use of the key, so no two uses share a key: a token made under one cannot be checked under another. */
export const KEY_LABELS = {
  tokenMac: 'neburyx reference token mac v1',
  tokenEncryption: 'neburyx reference token encryption v1',
  filterHash: 'neburyx filter hash v1',
} as const;

export interface ReferenceKeys {
  readonly tokenMac: Buffer;
  readonly tokenEncryption: Buffer;
  readonly filterHash: Buffer;
}

const derive = (master: Buffer, label: string): Buffer => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), label, KEY_BYTES));

/** The three keys of a deployment, derived from its one reference key with HKDF-SHA-256; a master key of another length is refused. */
export function deriveReferenceKeys(master: Buffer): ReferenceKeys {
  if (master.length !== REFERENCE_KEY_BYTES) throw new Error('the reference key must be 32 bytes');
  return { tokenMac: derive(master, KEY_LABELS.tokenMac), tokenEncryption: derive(master, KEY_LABELS.tokenEncryption), filterHash: derive(master, KEY_LABELS.filterHash) };
}

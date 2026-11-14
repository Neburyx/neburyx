import { createHmac, hkdfSync } from 'node:crypto';

const PURPOSE = 'neburyx.ask.preview.v1';
const KEY_BYTES = 32;

/** A key for signing, derived from the key material that signs page cursors; the same material gives the same key, and neither key can stand in for the other. */
export function deriveSigningKey(material: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), PURPOSE, KEY_BYTES));
}

/** The signing function the extension gets (it signs the Continue token of a heavy run): a text in, 64 lowercase hex characters out; the key stays here. */
export function createSigner(key: Buffer): (canonical: string) => string {
  return (canonical) => createHmac('sha256', key).update(canonical).digest('hex');
}

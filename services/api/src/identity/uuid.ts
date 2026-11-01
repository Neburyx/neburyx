import { randomBytes } from 'node:crypto';

const TIMESTAMP_BYTES = 6;
const VERSION_7 = 0x70;
const VARIANT = 0x80;

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, TIMESTAMP_BYTES);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | VERSION_7;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | VARIANT;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

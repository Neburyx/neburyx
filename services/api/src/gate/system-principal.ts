import type { Principal } from '../seams/seams.js';

/** A version 4 UUID, so `uuidv7()`, which makes every user id, can never produce it. */
export const SYSTEM_ID = '00000000-0000-4000-8000-000000000000';

export const SYSTEM_PRINCIPAL: Principal = Object.freeze({ id: SYSTEM_ID, displayName: 'System', role: null });

const SYSTEM_DIGITS = SYSTEM_ID.replaceAll('-', '');

/** True for the system id in any spelling a UUID column accepts: upper case, braces, hyphens anywhere or none (`{00000000-0000-4000-8000-000000000000}`). */
export function isSystemId(id: string): boolean {
  return id.toLowerCase().replace(/^\{(.*)\}$/, '$1').replaceAll('-', '') === SYSTEM_DIGITS;
}

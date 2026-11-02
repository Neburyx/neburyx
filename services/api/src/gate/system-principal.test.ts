import { describe, expect, it } from 'vitest';
import { meResponseSchema } from '@neburyx/contracts';
import { uuidv7 } from '../identity/uuid.js';
import { isSystemId, SYSTEM_ID, SYSTEM_PRINCIPAL } from './system-principal.js';

describe('the system principal', () => {
  it('has a fixed id that is not a version 7 UUID, so uuidv7() cannot make it', () => {
    expect(SYSTEM_ID[14]).toBe('4');
    expect(SYSTEM_ID[14]).not.toBe('7');
    const made = new Set(Array.from({ length: 2000 }, () => uuidv7()));
    expect(made.has(SYSTEM_ID)).toBe(false);
    expect([...made].every((id) => id[14] === '7')).toBe(true);
  });

  it('parses with the principal schema of GET /v1/me, with no role, and is the only principal that isSystemId accepts', () => {
    expect(meResponseSchema.shape.principal.parse(SYSTEM_PRINCIPAL)).toEqual({ id: SYSTEM_ID, displayName: 'System', role: null });
    expect(isSystemId(SYSTEM_PRINCIPAL.id)).toBe(true);
    expect(isSystemId(uuidv7())).toBe(false);
  });

  it('is recognised in every spelling a UUID column accepts, and not in a different id', () => {
    for (const id of [SYSTEM_ID.toUpperCase(), SYSTEM_ID.replaceAll('-', ''), `{${SYSTEM_ID}}`, '0000-0000-0000-4000-8000-0000-0000-0000']) expect(isSystemId(id), id).toBe(true);
    for (const id of ['', 'system', '00000000-0000-4000-8000-000000000001', `{${SYSTEM_ID}`, `${SYSTEM_ID}}`]) expect(isSystemId(id), id).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SYSTEM_PRINCIPAL)).toBe(true);
  });
});

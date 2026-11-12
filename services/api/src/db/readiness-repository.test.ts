import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { checkMigrations, migrationsState } from './readiness-repository.js';

describe('migrationsState', () => {
  it.each([
    [['0001', '0002'], ['0001', '0002'], 'ok'],
    [['0001', '0002'], ['0001'], 'pending'],
    [['0001', '0002'], [], 'pending'],
    [['0001'], ['0001', '0002'], 'ok'],
    [[], ['0001'], 'ok'],
    [[], [], 'ok'],
  ] as const)('with %j shipped and %j applied the state is %s', (shipped, applied, expected) => {
    expect(migrationsState(shipped, applied)).toBe(expected);
  });
});

describe('checkMigrations with the preview migrations', () => {
  const UNDEFINED_FUNCTION = Object.assign(new Error('function does not exist'), { code: '42883' });

  function poolAnswering(answers: Readonly<Record<string, readonly string[] | Error>>): pg.Pool {
    const asked: string[] = [];
    const pool = {
      query: (text: string) => {
        asked.push(text);
        const found = Object.entries(answers).find(([listing]) => text.includes(listing));
        if (found === undefined) return Promise.reject(new Error('unexpected query'));
        const [, answer] = found;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ rows: answer.map((name) => ({ name })) });
      },
      asked,
    };
    // only `query` is used, and the real pool's overloaded signature cannot be written out for a stand-in
    return pool as unknown as pg.Pool;
  }

  it('is ok when both histories hold every shipped name, and asks for the preview names only when it is given preview names', async () => {
    const pool = poolAnswering({ 'applied_migrations()': ['0001'], 'applied_preview_migrations()': ['0001', '0002'] });
    expect(await checkMigrations(pool, ['0001'], ['0001', '0002'])).toBe('ok');
    const plain = poolAnswering({ 'applied_migrations()': ['0001'] });
    expect(await checkMigrations(plain, ['0001'])).toBe('ok');
  });

  it.each([
    ['one preview migration is not applied', { 'applied_migrations()': ['0001'], 'applied_preview_migrations()': ['0001'] }, 'pending'],
    ['no preview migration was ever applied', { 'applied_migrations()': ['0001'], 'applied_preview_migrations()': [] }, 'pending'],
    ['the preview function is missing', { 'applied_migrations()': ['0001'], 'applied_preview_migrations()': UNDEFINED_FUNCTION }, 'pending'],
    ['the preview history cannot be read', { 'applied_migrations()': ['0001'], 'applied_preview_migrations()': new Error('connection lost') }, 'unknown'],
    ['a product migration is pending and the preview history cannot be read', { 'applied_migrations()': [], 'applied_preview_migrations()': new Error('connection lost') }, 'pending'],
  ] as const)('is not ok when %s', async (_name, answers, expected) => {
    expect(await checkMigrations(poolAnswering(answers), ['0001'], ['0001', '0002'])).toBe(expected);
  });
});

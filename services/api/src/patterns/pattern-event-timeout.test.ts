import { describe, expect, it } from 'vitest';
import { insertPatternEvent } from './pattern-events.js';

const EVENT = { id: 'i', sourceId: 's', patternId: 'p', actorId: 'a', action: 'saved', version: 1 } as const;

describe('the time limit of a pattern history write', () => {
  it('is set on the statement at the server, in the transaction of the insert, when the queue gives one, and not when it does not', async () => {
    const statements: string[] = [];
    const client = { query: (text: string, values?: unknown[]) => (statements.push(`${text.split(' ')[0]} ${String(values?.[0] ?? '')}`.trim()), Promise.resolve({})), release: () => statements.push('release') };
    const pool = { query: (text: string) => (statements.push(`pool ${text.split(' ')[0]}`), Promise.resolve({})), connect: () => Promise.resolve(client) } as never;
    await insertPatternEvent(pool, EVENT, 250);
    expect(statements).toEqual(['BEGIN', 'SELECT 250', 'INSERT i', 'COMMIT', 'release']);
    statements.length = 0;
    await insertPatternEvent(pool, EVENT);
    expect(statements).toEqual(['pool INSERT']);
  });
});

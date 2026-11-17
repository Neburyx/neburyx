import type pg from 'pg';
import { PREFERENCE_KEYS, preferencesSchema, type Preferences } from '@neburyx/contracts';

export interface PreferenceStore {
  /** The stored preferences of a user, only the keys of the closed list whose stored value is still allowed. */
  readPreferences(userId: string): Promise<Preferences>;
  /** Stores the keys named, leaves every other key as it was, and answers the whole map after the write. */
  writePreferences(userId: string, preferences: Preferences): Promise<Preferences>;
}

interface PreferenceRow {
  readonly key: string;
  readonly value: unknown;
}

function known(rows: readonly PreferenceRow[]): Preferences {
  const entries = rows.filter((row) => (PREFERENCE_KEYS as readonly string[]).includes(row.key)).map((row) => [row.key, row.value] as const);
  const parsed = preferencesSchema.safeParse(Object.fromEntries(entries));
  if (parsed.success) return parsed.data;
  return preferencesSchema.parse(Object.fromEntries(entries.filter(([key, value]) => preferencesSchema.safeParse({ [key]: value }).success)));
}

export function createPreferenceStore(pool: pg.Pool): PreferenceStore {
  const read = async (db: pg.Pool | pg.PoolClient, userId: string): Promise<Preferences> => {
    const result = await db.query<PreferenceRow>('SELECT key, value FROM user_preferences WHERE user_id = $1', [userId]);
    return known(result.rows);
  };
  return {
    readPreferences: (userId) => read(pool, userId),
    async writePreferences(userId, preferences) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(preferences)) {
          await client.query(
            `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [userId, key, JSON.stringify(value)],
          );
        }
        const stored = await read(client, userId);
        await client.query('COMMIT');
        return stored;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

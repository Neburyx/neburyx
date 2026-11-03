import { randomBytes } from 'node:crypto';

export const SETTING_KEYS = ['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'DEMO_NEO4J_PASSWORD', 'NEBURYX_CURSOR_KEY'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type Settings = Readonly<Record<SettingKey, string>>;

const PASSWORD_BYTES = 12;
const CURSOR_KEY_BYTES = 32;
const MIN_NEO4J_PASSWORD = 8;
const LETTERS_AND_DIGITS = /^[A-Za-z0-9]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type Random = (bytes: number) => Buffer;

export function generateSettings(random: Random = randomBytes): Settings {
  const password = (): string => random(PASSWORD_BYTES).toString('hex');
  return {
    NEBURYX_DB_ADMIN_PASSWORD: password(),
    NEBURYX_DB_MIGRATION_PASSWORD: password(),
    NEBURYX_DB_APP_PASSWORD: password(),
    DEMO_NEO4J_PASSWORD: password(),
    NEBURYX_CURSOR_KEY: random(CURSOR_KEY_BYTES).toString('base64'),
  };
}

export function formatSettings(settings: Settings): string {
  return [
    '# Local development settings, made by pnpm dev. Never committed, never overwritten.',
    ...SETTING_KEYS.map((key) => `${key}=${settings[key]}`),
    '',
  ].join('\n');
}

export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const value = trimmed.slice(at + 1).trim();
    values.set(trimmed.slice(0, at).trim(), value.length >= 2 && /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);
  }
  return values;
}

function isCursorKey(value: string): boolean {
  if (!BASE64.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  return (value === canonical || value === canonical.replace(/=+$/, '')) && bytes.length >= CURSOR_KEY_BYTES;
}

/** The keys of the five settings that are missing or not usable; never a value. */
export function invalidKeys(values: ReadonlyMap<string, string>): SettingKey[] {
  return SETTING_KEYS.filter((key) => {
    const value = values.get(key);
    if (value === undefined || value === '') return true;
    if (key === 'NEBURYX_CURSOR_KEY') return !isCursorKey(value);
    if (key === 'DEMO_NEO4J_PASSWORD') return !LETTERS_AND_DIGITS.test(value) || value.length < MIN_NEO4J_PASSWORD;
    return !LETTERS_AND_DIGITS.test(value);
  });
}

export function settingsOf(values: ReadonlyMap<string, string>): Settings {
  const read = (key: SettingKey): string => values.get(key) ?? '';
  return {
    NEBURYX_DB_ADMIN_PASSWORD: read('NEBURYX_DB_ADMIN_PASSWORD'),
    NEBURYX_DB_MIGRATION_PASSWORD: read('NEBURYX_DB_MIGRATION_PASSWORD'),
    NEBURYX_DB_APP_PASSWORD: read('NEBURYX_DB_APP_PASSWORD'),
    DEMO_NEO4J_PASSWORD: read('DEMO_NEO4J_PASSWORD'),
    NEBURYX_CURSOR_KEY: read('NEBURYX_CURSOR_KEY'),
  };
}

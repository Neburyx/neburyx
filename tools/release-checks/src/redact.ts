export const DATA_SECRET_ENV_NAMES = ['NBX_EE_URI', 'NBX_EE_PASSWORD'] as const;
export const SECRET_ENV_NAMES = [...DATA_SECRET_ENV_NAMES, 'NBX_EE_USER'] as const;

const MIN_SECRET_LENGTH = 3;
const MASK = '***';

/** Drops values too short to mask without hiding more than they protect. */
export function longEnough(values: readonly string[]): readonly string[] {
  return values.filter((value) => value.length >= MIN_SECRET_LENGTH);
}

export function secretValues(env: Readonly<Record<string, string | undefined>>, names: readonly string[] = SECRET_ENV_NAMES): readonly string[] {
  return names.flatMap((name) => {
    const value = env[name];
    return value !== undefined && value.length >= MIN_SECRET_LENGTH ? [value] : [];
  });
}

/** Longest values first, so a value that holds another is masked whole. */
export function redact(text: string, secrets: readonly string[]): string {
  return [...secrets].sort((a, b) => b.length - a.length).reduce((result, secret) => result.split(secret).join(MASK), text);
}

export function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item, secrets));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
  return value;
}

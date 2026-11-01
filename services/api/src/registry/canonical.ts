import { BIND_KEYS } from '@neburyx/contracts';

export function sortedEntries(map: Readonly<Record<string, string>>): [string, string][] {
  return Object.getOwnPropertyNames(map)
    .sort()
    .flatMap((key) => {
      const value: unknown = Object.getOwnPropertyDescriptor(map, key)?.value;
      return typeof value === 'string' ? [[key, value]] : [];
    });
}

export function canonicalBind(bind: Readonly<Record<string, string>>): Partial<Record<(typeof BIND_KEYS)[number], string>> {
  return Object.fromEntries(BIND_KEYS.flatMap((key) => (Object.hasOwn(bind, key) ? [[key, bind[key]]] : [])));
}

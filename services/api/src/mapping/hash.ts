import { createHash } from 'node:crypto';
import type { SourceModel } from './model.js';

export function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.getOwnPropertyNames(value)
      .sort()
      .flatMap((key) => {
        const member: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
        return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalText(member)}`];
      });
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashSource(source: Omit<SourceModel, 'configHash'>): string {
  return createHash('sha256').update(canonicalText(source)).digest('hex');
}

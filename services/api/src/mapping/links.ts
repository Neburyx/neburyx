import type { LinkKind, LinkTemplate } from './model.js';

const PLACEHOLDER = /\{([^{}]*)\}/g;
const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
const SAMPLE_VALUES = ['x', 'other.example.test'] as const;
// Stands in for a placeholder while the address is split, so a property name holding / ? # or & cannot change the structure.
const TOKEN = '';

/** The longest link template, in characters. TBD (needs a decision): a placeholder until the limit is agreed. */
export const LINK_TEMPLATE_MAX_LENGTH = 2048;

const UNSAFE_CHARACTER = /[\s\u0000-\u001f\u007f\\]/;

export interface LinkRules {
  readonly kind: LinkKind;
  readonly allowed: readonly string[];
  readonly allowedDescription: string;
  readonly piiProperties: readonly string[];
}

export type LinkCheck =
  | { readonly status: 'valid'; readonly link: LinkTemplate }
  | { readonly status: 'invalid'; readonly reasons: readonly string[] };

function hasPlaceholder(masked: string): boolean {
  return masked.includes(TOKEN) || /[{}]/.test(masked);
}

function checkPosition(parts: RegExpExecArray): string[] {
  const [, , authority = '', path = '', query, fragment] = parts;
  const reasons: string[] = [];
  if (hasPlaceholder(authority)) reasons.push('has a placeholder in the scheme or host');
  if (fragment !== undefined && hasPlaceholder(fragment)) reasons.push('has a placeholder in the fragment');
  if (path.split('/').some((segment) => hasPlaceholder(segment) && segment !== TOKEN)) {
    reasons.push('has a placeholder that is not a whole path segment');
  }
  const pairs = query === undefined ? [] : query.slice(1).split('&');
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    const key = separator < 0 ? pair : pair.slice(0, separator);
    const value = separator < 0 ? '' : pair.slice(separator + 1);
    if (hasPlaceholder(key)) reasons.push('has a placeholder in a query key');
    else if (hasPlaceholder(value) && value !== TOKEN) reasons.push('has a placeholder that is not a whole query value');
  }
  return reasons;
}

function hostWithSample(masked: string, sample: string): string | undefined {
  try {
    const url = new URL(masked.replace(TOKEN, sample));
    return url.protocol === 'https:' && url.hostname !== '' ? url.host : undefined;
  } catch {
    return undefined;
  }
}

function hasFixedHost(masked: string): boolean {
  const [first, second] = SAMPLE_VALUES.map((sample) => hostWithSample(masked, sample));
  return first !== undefined && first === second;
}

export function checkLink(template: string, rules: LinkRules): LinkCheck {
  if (template.includes(TOKEN)) return { status: 'invalid', reasons: ['has a character that is not allowed'] };
  if (template.length > LINK_TEMPLATE_MAX_LENGTH) return { status: 'invalid', reasons: [`is longer than ${LINK_TEMPLATE_MAX_LENGTH} characters`] };
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  const masked = template.replace(PLACEHOLDER, TOKEN);
  if (UNSAFE_CHARACTER.test(masked)) return { status: 'invalid', reasons: ['has a whitespace, control character or backslash outside its placeholder'] };
  const parts = ABSOLUTE_URL.exec(masked);
  if (parts === null) return { status: 'invalid', reasons: ['is not an absolute https address'] };
  const reasons: string[] = [];
  if (parts[1]?.toLowerCase() !== 'https') reasons.push('has a scheme that is not https');

  const [placeholder] = names;
  if (names.length !== 1 || placeholder === undefined || /[{}]/.test(masked)) {
    reasons.push('needs exactly one placeholder');
    return { status: 'invalid', reasons };
  }
  if (placeholder === '') reasons.push('has an empty placeholder');
  if (parts[2] === '') reasons.push('has no host');
  if (parts[2]?.includes('@') === true) reasons.push('has user-info before the host');
  reasons.push(...checkPosition(parts));
  if (!rules.allowed.includes(placeholder)) reasons.push(`has placeholder ${placeholder}, which is not ${rules.allowedDescription}`);
  if (rules.piiProperties.includes(placeholder)) reasons.push(`has placeholder ${placeholder}, which is marked pii`);
  if (reasons.length === 0 && !hasFixedHost(masked)) reasons.push('is not a valid https address with a fixed host');
  if (reasons.length > 0) return { status: 'invalid', reasons };
  return { status: 'valid', link: { kind: rules.kind, template, placeholder } };
}

import { isWellFormed } from '../reference/well-formed.js';
import type { LinkTemplate } from './model.js';

/** The longest address a link may build, in characters. TBD (needs a decision): a placeholder until the limit is agreed. */
export const SOURCE_LINK_MAX_LENGTH = 4096;

const ONLY_DOTS = /^\.+$/;
const SAMPLE = 'x';

function parsed(address: string): URL | undefined {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address a link template gives for a value, or undefined when none may be built: a value that is only dots (a browser reads it as a path step even when encoded), a value with an unpaired surrogate,
 * or an address that does not parse again as `https` with the template's own host and no user-info, or is over `SOURCE_LINK_MAX_LENGTH`. The address returned is the parsed form, in ASCII, so it is safe in a
 * header. It never throws. This is the one place an address is made.
 */
export function buildLinkAddress(link: LinkTemplate, value: string): string | undefined {
  if (ONLY_DOTS.test(value) || !isWellFormed(value)) return undefined;
  const marker = `{${link.placeholder}}`;
  const address = link.template.replace(marker, () => encodeURIComponent(value));
  const url = parsed(address);
  const expected = parsed(link.template.replace(marker, () => SAMPLE));
  if (url === undefined || expected === undefined || url.host !== expected.host || url.href.length > SOURCE_LINK_MAX_LENGTH) return undefined;
  return url.href;
}

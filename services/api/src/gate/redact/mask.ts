import type { PiiClass } from '@neburyx/contracts';

/** What is shown for a value that cannot be shown in any shape: six bullets, whatever the value. */
export const FULL_MASK = '••••••';

const BULLETS = '•••';

const firstCharacter = (text: string): string => Array.from(text)[0] ?? '';

function maskName(value: string): string {
  const words = value.trim().split(/\s+/).filter((word) => word !== '');
  return words.length === 0 ? FULL_MASK : words.map((word) => `${firstCharacter(word)}${BULLETS}`).join(' ');
}

function maskEmail(value: string): string {
  const parts = value.trim().split('@');
  const [local, domain] = parts;
  if (parts.length !== 2 || local === undefined || domain === undefined || local === '' || domain === '') return FULL_MASK;
  return `${firstCharacter(local)}${BULLETS}@${BULLETS}`;
}

/** A phone is shown by its country code (the one to three digits after the `+` and before the first separator) and its last two digits; any other form is masked fully. */
function maskPhone(value: string): string {
  const match = /^\+(\d{1,3})(?=\D)/.exec(value.trim());
  const countryCode = match?.[1];
  if (countryCode === undefined) return FULL_MASK;
  const digits = value.replace(/\D/g, '');
  if (digits.length < countryCode.length + 2) return FULL_MASK;
  return `+${countryCode} ${FULL_MASK}${digits.slice(-2)}`;
}

/**
 * The mask of a value in the shape of its class (TAS §10.1): a name shows an initial and three bullets for each word, an email its initial and `@`, a phone its country
 * code and last two digits; a date, a text, a value with no class, a class that does not fit the value and a value that is not text are masked fully. A mask does not
 * depend on how many characters it hides, and a class is never guessed from the value.
 */
export function maskValue(value: unknown, piiClass?: PiiClass): string {
  if (typeof value !== 'string') return FULL_MASK;
  switch (piiClass) {
    case 'name':
      return maskName(value);
    case 'email':
      return maskEmail(value);
    case 'phone':
      return maskPhone(value);
    default:
      return FULL_MASK;
  }
}

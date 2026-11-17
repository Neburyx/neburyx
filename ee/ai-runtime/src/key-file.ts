export type KeyText = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly problem: string };

const ASSIGNMENT = /^(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=(.*)$/;

function unquoted(value: string): string {
  const text = value.trim();
  const first = text.charAt(0);
  return text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first) ? text.slice(1, -1).trim() : text;
}

/** Reads a key file's text: one bare key, or one `NAME=value` line. The problem never holds any of the text. */
export function parseKeyText(text: string): KeyText {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length === 0) return { ok: false, problem: 'the file holds no key' };
  const assignments = lines.filter((line) => ASSIGNMENT.test(line));
  if (assignments.length > 1) return { ok: false, problem: 'the file holds more than one assignment; give one key' };
  if (lines.length > 1) return { ok: false, problem: 'the file holds more than one line; give one key' };
  const line = lines[0] ?? '';
  const match = ASSIGNMENT.exec(line);
  if (match === null) return { ok: true, key: line };
  const value = unquoted(match[1] ?? '');
  return value === '' ? { ok: false, problem: 'the assignment has an empty value' } : { ok: true, key: value };
}

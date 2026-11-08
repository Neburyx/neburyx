/** Reads `NAME=value` lines: a `#` starts a comment only at the start of a line, a line without `=` is skipped, one pair of matching quotes is removed. */
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

const SIGN_OFF = /^Signed-off-by: \S.* <[^<>\s]+@[^<>\s]+>$/;

/** Git never reads the first paragraph (the subject) as trailers, so the line counts only in the last of two or more paragraphs. */
export function hasSignOff(message: string): boolean {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1);
  if (paragraphs.length < 2 || last === undefined) return false;
  return last.split('\n').some((line) => SIGN_OFF.test(line));
}

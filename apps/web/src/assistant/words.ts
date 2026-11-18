/** The words of a message: runs of characters between white space, counted as the server counts them. */
export function countWords(message: string): number {
  const trimmed = message.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

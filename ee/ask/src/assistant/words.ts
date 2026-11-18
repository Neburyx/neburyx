/** The words of a message: runs of characters between white space. The panel counts the same way. */
export function countWords(message: string): number {
  const trimmed = message.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

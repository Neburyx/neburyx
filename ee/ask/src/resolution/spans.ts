export interface Word {
  readonly start: number;
  readonly end: number;
}

/** The most words one candidate span holds. */
export const MAX_SPAN_WORDS = 3;
/** The shortest span, in characters, that is searched. */
export const MIN_SPAN_LENGTH = 2;

const EDGE_PUNCTUATION = /^[\s"'()[\]{}<>?!.,;:]+|[\s"'()[\]{}<>?!.,;:]+$/g;

/** The words of a message, as offsets in UTF-16 code units: runs of non-space characters with the punctuation around them trimmed, so `A-1029,` is the word `A-1029`. */
export function wordsOf(message: string): Word[] {
  const words: Word[] = [];
  for (const match of message.matchAll(/\S+/g)) {
    const raw = match[0];
    const trimmed = raw.replace(EDGE_PUNCTUATION, '');
    if (trimmed === '') continue;
    const start = match.index + raw.indexOf(trimmed);
    words.push({ start, end: start + trimmed.length });
  }
  return words;
}

export function overlaps(left: Word, right: Word): boolean {
  return left.start < right.end && right.start < left.end;
}

/** Spans of 1 to `MAX_SPAN_WORDS` consecutive words that overlap none of the blocked ranges: longest first, then left to right. */
export function candidateSpans(message: string, blocked: readonly Word[]): Word[] {
  const words = wordsOf(message).filter((word) => !blocked.some((range) => overlaps(word, range)));
  const spans: Word[] = [];
  for (let size = MAX_SPAN_WORDS; size >= 1; size -= 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const first = words[index];
      const last = words[index + size - 1];
      if (first === undefined || last === undefined) continue;
      const span = { start: first.start, end: last.end };
      if (blocked.some((range) => overlaps(span, range))) continue;
      spans.push(span);
    }
  }
  return spans;
}

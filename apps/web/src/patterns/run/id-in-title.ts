const WORD = /[\p{L}\p{N}_]/u;

/** Whether a title already carries an ID as a whole token: it is the title, or it sits between the start, the end, a space or punctuation. "10" is not found in "Unit 100". */
export function titleHoldsId(title: string, id: string): boolean {
  if (id === '') return false;
  for (let at = title.indexOf(id); at !== -1; at = title.indexOf(id, at + 1)) {
    const before = at === 0 ? '' : (title[at - 1] ?? '');
    const after = title[at + id.length] ?? '';
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

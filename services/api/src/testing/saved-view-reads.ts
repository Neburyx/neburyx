const KEYWORDS = new Set(['where', 'on', 'join', 'left', 'inner', 'set', 'for', 'order', 'limit', 'group', 'union', 'using', 'cross', 'right']);

/** The statements of a source file: its template literals that mention `saved_views`. */
export function savedViewStatements(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '').filter((text) => /\bsaved_views\b/.test(text));
}

/**
 * The references to `saved_views` in a statement that may reach a deleted view: each `FROM` or `JOIN` of the table, by its alias (or none), unless the statement restricts that reference to drafts or to rows whose own `deleted_at` is null. A predicate on another table (`i.deleted_at IS NULL`) does not count. The targets of an `UPDATE` and the rows of an `INSERT` are not reads, and are left out.
 */
export function unfilteredViewReads(statement: string): string[] {
  const unfiltered: string[] = [];
  for (const match of statement.matchAll(/\b(?:FROM|JOIN)\s+saved_views\b(?:\s+AS)?(?:\s+([a-z_][a-z0-9_]*))?/gi)) {
    const word = match[1];
    const alias = word !== undefined && !KEYWORDS.has(word.toLowerCase()) ? word : undefined;
    const qualified = alias === undefined ? '' : `${alias}\\.`;
    const draftOnly = new RegExp(`(?<![\\w.])${qualified}kind\\s*=\\s*'draft'`, 'i').test(statement);
    const own = new RegExp(`(?<![\\w.])${qualified}deleted_at\\s+IS\\s+NULL`, 'i').test(statement);
    if (!draftOnly && !own) unfiltered.push(alias ?? 'saved_views');
  }
  return unfiltered;
}

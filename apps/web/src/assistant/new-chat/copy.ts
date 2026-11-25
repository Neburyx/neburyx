/** The words of the picker of a new chat (frame 5b-1). The names of investigations, case references and sources come from the investigations themselves. */
export const NEW_CHAT_COPY = {
  title: 'New chat about…',
  description: 'Pick the investigation this chat is about.',
  footer: 'A chat belongs to one investigation. Picking one that already has a chat opens it. Closed investigations are not listed.',
  loading: 'Loading open investigations…',
  failed: 'The open investigations could not be read.',
  tryAgain: 'Try again',
  listLabel: 'Open investigations',
  searchLabel: 'Search open investigations',
  empty: 'There is no open investigation.',
  noMatch: 'No open investigation matches this text.',
  showMore: 'Show more',
  loadingMore: 'Loading…',
  moreFailed: 'The next investigations could not be read.',
} as const;

/** The second line of a row: the case reference and the source, or the source alone when there is no case reference. */
export const rowDetailOf = (caseRef: string | null, sourceAlias: string): string => (caseRef === null ? sourceAlias : `${caseRef} · ${sourceAlias}`);

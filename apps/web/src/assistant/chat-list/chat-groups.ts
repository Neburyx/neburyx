const CHAT_GROUPS = ['today', 'previous7', 'older'] as const;
export type ChatGroup = (typeof CHAT_GROUPS)[number];

/** The calendar day of an instant in a time zone (the browser's when none is given), as a whole number of days since 1970-01-01, so two days compare by subtraction whatever the length of a day. */
function dayOf(instant: Date, timeZone: string | undefined): number {
  const [calendarYear, calendarMonth, calendarDay] = new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant).split('-').map(Number);
  return Math.round(Date.UTC(calendarYear ?? 1970, (calendarMonth ?? 1) - 1, calendarDay ?? 1) / 86_400_000);
}

/** The group of a chat by the calendar day of its last question: today (a day in the future, from a clock that is ahead, too), the seven days before today, or older. */
export function groupOf(lastQuestionAt: string, now: Date, timeZone?: string): ChatGroup {
  const age = dayOf(now, timeZone) - dayOf(new Date(lastQuestionAt), timeZone);
  if (age <= 0) return 'today';
  return age <= 7 ? 'previous7' : 'older';
}

export interface GroupedChats<T> {
  readonly group: ChatGroup;
  readonly rows: readonly T[];
}

/** The chats in the order they came, split into the groups that hold one, in the order of the groups. */
export function groupChats<T extends { readonly lastQuestionAt: string }>(rows: readonly T[], now: Date, timeZone?: string): readonly GroupedChats<T>[] {
  const held = new Map<ChatGroup, T[]>();
  for (const row of rows) {
    const group = groupOf(row.lastQuestionAt, now, timeZone);
    held.set(group, [...(held.get(group) ?? []), row]);
  }
  return CHAT_GROUPS.flatMap((group) => {
    const members = held.get(group);
    return members === undefined ? [] : [{ group, rows: members }];
  });
}

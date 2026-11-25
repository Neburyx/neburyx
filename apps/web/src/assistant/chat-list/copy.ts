import { TRY_AGAIN } from '../../investigations/messages.js';
import type { ChatGroup } from './chat-groups.js';

export const CHAT_LIST_COPY = {
  label: 'Chats',
  newChat: 'New chat',
  searchLabel: 'Search chats',
  searchPlaceholder: 'Search chats',
  groups: { today: 'Today', previous7: 'Previous 7 days', older: 'Older' } satisfies Record<ChatGroup, string>,
  note: 'One chat per investigation. A chat is cleared when its investigation closes.',
  noQuestions: 'No questions yet',
  loading: 'Loading chats…',
  empty: 'No chats yet.',
  noMatch: 'No chats match your search.',
  moreMayExist: 'More chats may exist.',
  showMore: 'Show more',
  loadingMore: 'Loading…',
  retry: TRY_AGAIN,
  retryLabel: 'Try again to load the chats',
} as const;

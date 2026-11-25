import { z } from 'zod';

/** The most investigations one lookup of chats asks about: below the 200 ids the application names investigations for in one call. */
export const ASSISTANT_CHAT_LOOKUP_IDS_MAX = 100;

/** `POST /v1/assistant/threads/lookup`: the investigations, by id, whose chat the caller wants to know of. At least one and at most 100, each once. */
export const assistantChatLookupRequestSchema = z.strictObject({
  investigationIds: z
    .array(z.uuid())
    .min(1)
    .max(ASSISTANT_CHAT_LOOKUP_IDS_MAX)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, { message: 'an investigation is named once' }),
});
export type AssistantChatLookupRequest = z.infer<typeof assistantChatLookupRequestSchema>;

/** The ids, of those asked about and in the order asked, for which the caller has a chat. Ids only: no title, question, count or date. */
export const assistantChatLookupResponseSchema = z.strictObject({ withChat: z.array(z.uuid()).max(ASSISTANT_CHAT_LOOKUP_IDS_MAX) });
export type AssistantChatLookupResponse = z.infer<typeof assistantChatLookupResponseSchema>;

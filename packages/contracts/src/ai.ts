import { z } from 'zod';

export const aiStatusResponseSchema = z.strictObject({ preview: z.literal(true) });

export type AiStatusResponse = z.infer<typeof aiStatusResponseSchema>;

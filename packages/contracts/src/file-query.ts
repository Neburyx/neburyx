import { z } from 'zod';
import { countSchema, edgeSchema, nodeSchema } from './graph.js';
import { templateRunNoticeSchema } from './template-run.js';

/** The answer of a file query: what the query returned as nodes and relationships of the source's mapping, the number of rows it returned (a lower bound when the read was cut), and what the normalizer left out. */
export const fileQueryResultSchema = z.strictObject({
  status: z.literal('ok'),
  intent: z.string().min(1),
  count: countSchema,
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  notices: z.array(templateRunNoticeSchema),
  warnings: z.array(z.string()),
});

export type FileQueryResult = z.infer<typeof fileQueryResultSchema>;

import type { ZodType } from 'zod';
import { AppError } from '../errors.js';
import {
  SCHEMA_DRAFT_CONSTRAINTS_ID,
  SCHEMA_DRAFT_INDEXES_ID,
  SCHEMA_DRAFT_TOKENS_ID,
  schemaDraftConstraintsItemSchema,
  schemaDraftIndexesItemSchema,
  schemaDraftTokensItemSchema,
  type SchemaDraftConstraint,
  type SchemaDraftIndex,
} from '../gate/templates/schema-draft.js';
import { isUnreadable } from '../gate/templates/unreadable.js';
import type { SystemRunner } from '../gate/types.js';
import { FAILURE_SENTENCES, failureReasonOf } from '../source-test/reasons.js';

/** What a source's schema holds, each list as the database listed it, with a flag for a list that was cut at the bound. No property value is in it. */
export interface SourceSchema {
  readonly labels: readonly string[];
  readonly labelsCut: boolean;
  readonly types: readonly string[];
  readonly typesCut: boolean;
  readonly propertyKeys: readonly string[];
  readonly propertyKeysCut: boolean;
  readonly indexes: readonly SchemaDraftIndex[];
  readonly indexesCut: boolean;
  readonly constraints: readonly SchemaDraftConstraint[];
  readonly constraintsCut: boolean;
}

export type SchemaRead = { readonly ok: true; readonly schema: SourceSchema } | { readonly ok: false; readonly message: string };

class ReadFailure extends Error {}

async function readOne<T>(system: SystemRunner, sourceId: string, traceId: string, templateId: string, schema: ZodType<T>): Promise<T> {
  let items;
  try {
    items = (await system.run({ traceId, sourceId, templateId, params: {}, limit: 1 })).items;
  } catch (error) {
    const reason = failureReasonOf(error);
    if (reason !== undefined) throw new ReadFailure(FAILURE_SENTENCES[reason]);
    if (error instanceof AppError && error.code === 'INTERNAL_ERROR') throw new ReadFailure(`The source's answer to the read ${templateId} could not be used${error.reason === undefined ? '' : ` (${error.reason})`}.`);
    throw error;
  }
  const [item] = items;
  const parsed = items.length === 1 && item !== undefined && !isUnreadable(item) ? schema.safeParse(item) : undefined;
  if (parsed === undefined || !parsed.success) throw new ReadFailure(`The source's answer to the read ${templateId} could not be used.`);
  return parsed.data;
}

/**
 * Reads the schema with the three fixed schema templates, one after another, through the gate's system runner. A read that fails is a failure with the sentence
 * `test-source` uses for it, and no partial schema is returned; a failure that says nothing about the source (a busy source, a closed executor) is rethrown.
 */
export async function readSchema(system: SystemRunner, sourceId: string, traceId: string): Promise<SchemaRead> {
  try {
    const tokens = await readOne(system, sourceId, traceId, SCHEMA_DRAFT_TOKENS_ID, schemaDraftTokensItemSchema);
    const indexes = await readOne(system, sourceId, traceId, SCHEMA_DRAFT_INDEXES_ID, schemaDraftIndexesItemSchema);
    const constraints = await readOne(system, sourceId, traceId, SCHEMA_DRAFT_CONSTRAINTS_ID, schemaDraftConstraintsItemSchema);
    return { ok: true, schema: { ...tokens, indexes: indexes.indexes, indexesCut: indexes.truncated, constraints: constraints.constraints, constraintsCut: constraints.truncated } };
  } catch (error) {
    if (error instanceof ReadFailure) return { ok: false, message: error.message };
    throw error;
  }
}

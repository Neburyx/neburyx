import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';

const documentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.object({ schemas: z.record(z.string(), z.record(z.string(), z.unknown())) }),
});

export type OpenApiDocument = z.infer<typeof documentSchema>;

export function parseDocument(value: unknown): OpenApiDocument {
  return documentSchema.parse(value);
}

export function loadCommittedDocument(): OpenApiDocument {
  const file = fileURLToPath(new URL('../../../../packages/contracts/openapi.json', import.meta.url));
  return parseDocument(JSON.parse(readFileSync(file, 'utf8')));
}

export function validatorFor(document: OpenApiDocument, schemaName: string): ValidateFunction {
  const schema = document.components.schemas[schemaName];
  if (schema === undefined) throw new Error(`the document has no schema ${schemaName}`);
  return new Ajv2020().compile(schema);
}

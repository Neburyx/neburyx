import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { buildOpenApiDocument } from './openapi.js';

const committed: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8'));

describe('the committed packages/contracts/openapi.json', () => {
  it('differs from a document built from a changed schema', () => {
    const changed = errorResponseSchema.extend({ extra: z.string() });
    expect(buildOpenApiDocument(changed)).not.toEqual(committed);
  });

  it('equals the generated document', () => {
    expect(buildOpenApiDocument()).toEqual(committed);
  });
});

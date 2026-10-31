import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly ErrorResponse: Record<string, unknown> } };
}

export function buildOpenApiDocument(errorResponse: z.ZodType = errorResponseSchema): OpenApiDocument {
  const { $schema: _dialect, ...errorResponseSchemaJson } = z.toJSONSchema(errorResponse, { target: 'draft-2020-12' });
  return {
    openapi: '3.1.0',
    info: { title: API_TITLE, version: API_VERSION },
    paths: {},
    components: { schemas: { ErrorResponse: errorResponseSchemaJson } },
  };
}

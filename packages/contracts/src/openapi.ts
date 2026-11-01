import { z } from 'zod';
import { errorResponseSchema } from './error-response.js';
import { meResponseSchema } from './me.js';

const API_TITLE = 'Neburyx API';
const API_VERSION = '0.0.0';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: { readonly ErrorResponse: Record<string, unknown>; readonly MeResponse: Record<string, unknown> } };
}

function schemaJson(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  return json;
}

const jsonBody = (name: string): Record<string, unknown> => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
});

export function buildOpenApiDocument(errorResponse: z.ZodType = errorResponseSchema, meResponse: z.ZodType = meResponseSchema): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: API_TITLE, version: API_VERSION },
    paths: {
      '/v1/me': {
        get: {
          operationId: 'getMe',
          summary: 'The calling principal, the edition and the permitted sources',
          responses: {
            '200': { description: 'The principal', content: jsonBody('MeResponse') },
            '500': { description: 'The identity could not be read', content: jsonBody('ErrorResponse') },
          },
        },
      },
    },
    components: { schemas: { ErrorResponse: schemaJson(errorResponse), MeResponse: schemaJson(meResponse) } },
  };
}

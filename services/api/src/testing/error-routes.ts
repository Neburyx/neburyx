import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';

export const CYPHER = "MATCH (a:Account {id: 'ACC-12345'}) RETURN a";
export const IDENTIFIER = 'ACC-12345';

export function registerErrorRoutes(server: FastifyInstance): void {
  server.get('/v1/test/denied', async () => {
    throw new AppError('ACCESS_DENIED');
  });
  server.get('/v1/test/leaky-app-error', async () => {
    throw Object.assign(new AppError('ACCESS_DENIED'), { message: `${CYPHER} for ${IDENTIFIER}` });
  });
  server.get('/v1/test/leaky-error', async () => {
    throw new Error(`${CYPHER} for ${IDENTIFIER}`);
  });
  server.get('/v1/test/details', async (request) => {
    const { code, details } = z.object({ code: z.string(), details: z.string() }).parse(request.query);
    throw new AppError(z.enum(['QUERY_BUDGET_EXCEEDED', 'RATE_LIMITED']).parse(code), JSON.parse(details));
  });
  server.post('/v1/test/echo', async () => ({ ok: true }));
}

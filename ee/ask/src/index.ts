import { fileURLToPath } from 'node:url';
import { aiStatusResponseSchema, type ProfileExtension } from '@neburyx/contracts';

export const AI_STATUS_URL = '/v1/ai/status';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

export function createEnterpriseExtension(): ProfileExtension {
  return {
    name: 'ask',
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    routeGroups: [
      {
        routes: [
          {
            method: 'GET',
            url: AI_STATUS_URL,
            permission: 'principal',
            responseSchema: aiStatusResponseSchema,
            handler: async () => ({ preview: true }),
          },
        ],
      },
    ],
  };
}

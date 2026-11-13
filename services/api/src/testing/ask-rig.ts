import { createEntityReader } from '../entities/entity-reader.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { createRequestLimiter } from '../rate/request-limiter.js';
import { createSearchService } from '../search/search-service.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_IDENTITY } from './app-store.js';
import { TEST_REFERENCE_KEYS } from './gate.js';
import { startSearchApp, type SearchApp, type SearchAppOptions } from './search-app.js';
import pino from 'pino';
import type { AskSearchContext } from '../ask/entity-search.js';

export interface AskRig extends SearchApp {
  readonly searching: ReturnType<typeof createSearchService>;
  readonly reader: ReturnType<typeof createEntityReader>;
  readonly limiter: ReturnType<typeof createRequestLimiter>;
  readonly context: (overrides?: Partial<AskSearchContext>) => AskSearchContext;
}

/** The real search service and entity reader over the real gate, with a fake adapter that answers what `options.respond` says. */
export async function startAskRig(options: SearchAppOptions): Promise<AskRig> {
  const app = await startSearchApp(options);
  const limiter = createRequestLimiter();
  const access = createSourceAccess({ mapping: app.mapping, seams: communitySeams(), logger: pino({ level: 'silent' }), limiter });
  const searching = createSearchService({ gate: app.gate, mapping: app.mapping, access, references: TEST_REFERENCE_KEYS });
  const reader = createEntityReader({ gate: app.gate, mapping: app.mapping, access });
  return { ...app, searching, reader, limiter, context: (overrides = {}) => ({ principal: LOCAL_IDENTITY.principal, sourceId: 'demo', traceId: 'tr-ask', mask: true, ...overrides }) };
}

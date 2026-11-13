import type { IncomingMessage, ServerResponse } from 'node:http';
import { paramsJsonSchemaOf, templateRunRequestSchema, templateRunResponseSchema, type TemplateRunResponse } from '@neburyx/contracts';

interface PatternProfile {
  readonly sourceId: string;
  readonly presets?: readonly unknown[];
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const BUSY = { status: 503, body: { error: { code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId: 'tr-support' } } };

const ref = (sourceId: string, entityType: string, stableId: string) => ({ sourceId, entityType, stableId });
const node = (sourceId: string, entityType: string, stableId: string) => ({
  ref: ref(sourceId, entityType, stableId),
  display: { title: stableId, type: entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

/** How many accounts the scripted six-account ring holds besides the one the run starts from. */
export const RING_MATES = 5;

/**
 * What the support server does with a run, chosen by what the form sends, so a spec reaches each state with the form alone: a `limit` of 1 gives no match, 3 a run that waits until the client leaves, 4 a busy source; a `minShared` of 2 gives a heavy stop,
 * whose `continueLimit` is the product's 25 lowered by the page the run asked for, as the API does, and the same request with the continue flag gives the ring. Any other request gets the ring.
 */
export const LIMITS = { none: 1, slow: 3, busy: 4 } as const;
export const HEAVY_MIN_SHARED = 2;
const CONTINUE_LIMIT = 25;

function ring(sourceId: string, anchor: string, mates: number, presetId: string | undefined): TemplateRunResponse {
  const matches = Array.from({ length: mates }, (_, index) => `AC-${index + 2}`).filter((id) => id !== anchor);
  const edges = matches.map((id, index) => ({
    ref: { sourceId, type: 'USES_DEVICE', from: 'account', to: 'device', stableId: `ud-${index}` },
    from: ref(sourceId, 'account', id),
    to: ref(sourceId, 'device', 'DV-1'),
    type: 'USES_DEVICE',
    direction: 'from-to' as const,
    semantics: 'stored' as const,
    properties: [],
    evidenceRefs: [`AUTH-7710${index}`],
    qualityFlags: [],
  }));
  return templateRunResponseSchema.parse({
    status: 'ok',
    templateId: 'shared-attribute',
    templateVersion: '1',
    ...(presetId === undefined ? {} : { presetId }),
    count: { value: matches.length, quality: 'exact', scope: 'matches' },
    matchIds: matches.map((id) => ref(sourceId, 'account', id)),
    nodes: [node(sourceId, 'account', anchor), node(sourceId, 'device', 'DV-1'), ...matches.map((id) => node(sourceId, 'account', id))],
    edges,
    notices: [],
    warnings: [],
  });
}

/** `GET /v1/templates` and `POST /v1/templates/{id}/run`, scripted: the list is the profile's presets (or none while the mode says so) and the run answers by the limit of the request. */
export function createPatterns(profiles: () => readonly PatternProfile[]) {
  let noPresets = false;
  return {
    setMode(body: unknown, response: ServerResponse): void {
      noPresets = typeof body === 'object' && body !== null && 'noPresets' in body && body.noPresets === true;
      json(response, 200, {});
    },
    list(sourceId: string | null, response: ServerResponse): void {
      const profile = profiles().find((candidate) => candidate.sourceId === sourceId);
      if (profile === undefined) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-support' } });
      json(response, 200, {
        sourceId: profile.sourceId,
        templates: (['shared-attribute', 'linked-entities'] as const).map((id) => ({ id, version: '1', name: id, description: id, paramsSchema: paramsJsonSchemaOf(id) })),
        presets: noPresets ? [] : (profile.presets ?? []),
      });
    },
    async run(presetId: string, body: unknown, response: ServerResponse, request: IncomingMessage): Promise<void> {
      const parsed = templateRunRequestSchema.safeParse(body);
      const params = parsed.success ? parsed.data.params : undefined;
      const anchor = typeof params?.['ref'] === 'object' && params['ref'] !== null && 'stableId' in params['ref'] ? String(params['ref'].stableId) : undefined;
      if (!parsed.success || anchor === undefined) return json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } });
      const sourceId = parsed.data.sourceId;
      const limit = typeof params?.['limit'] === 'number' ? params['limit'] : undefined;
      if (limit === LIMITS.busy) return json(response, BUSY.status, BUSY.body);
      if (limit === LIMITS.slow) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          request.on('close', () => (clearTimeout(timer), resolve()));
        });
        if (!response.destroyed) json(response, 200, ring(sourceId, anchor, 1, presetId));
        return;
      }
      if (params?.['minShared'] === HEAVY_MIN_SHARED && parsed.data.continue !== true) {
        return json(response, 200, templateRunResponseSchema.parse({ status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', presetId, estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: Math.min(CONTINUE_LIMIT, limit ?? CONTINUE_LIMIT), notices: [], warnings: [] }));
      }
      json(response, 200, ring(sourceId, anchor, limit === LIMITS.none ? 0 : RING_MATES, presetId));
    },
  };
}

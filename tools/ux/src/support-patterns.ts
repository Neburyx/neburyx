import type { IncomingMessage, ServerResponse } from 'node:http';
import { paramsJsonSchemaOf, patternProblemsOf, patternValidateRequestSchema, templateRunRequestSchema, templateRunResponseSchema, type TemplateRunResponse } from '@neburyx/contracts';

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
const RING_MATES = 5;

/**
 * What the support server does with a run, chosen by what the form sends, so a spec reaches each state with the form alone: a `limit` of 1 gives no match, 3 a run that waits until the client leaves, 4 a busy source, 5 a cut result (a lower-bound count), 6 a result with the stop-list notice; a `minShared` of 2 gives a heavy stop,
 * whose `continueLimit` is the product's 25 lowered by the page the run asked for, as the API does, and the same request with the continue flag gives the ring. Any other request gets the ring.
 */
const LIMITS = { none: 1, slow: 3, busy: 4, cut: 5, stopList: 6 } as const;
const HEAVY_MIN_SHARED = 2;
/** The start type for which the support server answers one problem. */
const SCRIPTED_START = 'merchant';
const CONTINUE_LIMIT = 25;

const evidenceEdge = (sourceId: string, type: string, fromType: string, toType: string, id: string, from: string, to: string, evidence: string[]) => ({
  ref: { sourceId, type, from: fromType, to: toType, stableId: id },
  from: ref(sourceId, fromType, from),
  to: ref(sourceId, toType, to),
  type,
  direction: 'from-to' as const,
  semantics: 'stored' as const,
  properties: [],
  evidenceRefs: evidence,
  qualityFlags: [],
});

const BANKING = { anchor: 'account', attribute: 'device', via: 'USES_DEVICE', prefix: 'AC-', shared: 'DV-1', mates: RING_MATES };
const INSURANCE = { anchor: 'claimant', attribute: 'address', via: 'LIVES_AT', prefix: 'CL-', shared: 'AD-1', mates: 2 };
const typesOfSource = (sourceId: string) => (sourceId === 'claims-demo' ? INSURANCE : BANKING);

interface RingOptions {
  readonly cut?: boolean;
  readonly stopList?: boolean;
}

function ring(sourceId: string, anchor: string, mates: number, presetId: string | undefined, options: RingOptions = {}): TemplateRunResponse {
  const types = typesOfSource(sourceId);
  const matches = Array.from({ length: mates }, (_, index) => `${types.prefix}${index + 2}`).filter((id) => id !== anchor);
  const edges = [anchor, ...matches].map((id, index) => evidenceEdge(sourceId, types.via, types.anchor, types.attribute, `ud-${index}`, id, types.shared, [`AUTH-7710${index}`]));
  return templateRunResponseSchema.parse({
    status: 'ok',
    templateId: 'shared-attribute',
    templateVersion: '1',
    ...(presetId === undefined ? {} : { presetId }),
    count: { value: matches.length, quality: options.cut === true ? 'lowerBound' : 'exact', scope: 'matches' },
    matchIds: matches.map((id) => ref(sourceId, types.anchor, id)),
    nodes: [node(sourceId, types.anchor, anchor), node(sourceId, types.attribute, types.shared), ...matches.map((id) => node(sourceId, types.anchor, id))],
    edges,
    notices: options.stopList === true ? [{ code: 'stopListSkipped' }] : [],
    warnings: [],
  });
}

/** A linked-entities answer: one match one hop from the anchor and one two hops away through a third entity, so the answer holds four entities and three relationships. */
function linked(sourceId: string, anchor: string, presetId: string | undefined): TemplateRunResponse {
  const from = 'account';
  const to = 'account';
  const via = 'TRANSFERRED_TO';
  const id = (n: number): string => `AC-${n}`;
  const near = id(2);
  const between = id(3);
  const far = id(4);
  return templateRunResponseSchema.parse({
    status: 'ok',
    templateId: 'linked-entities',
    templateVersion: '1',
    ...(presetId === undefined ? {} : { presetId }),
    count: { value: 2, quality: 'exact', scope: 'matches' },
    matchIds: [ref(sourceId, to, near), ref(sourceId, to, far)],
    links: [
      { match: ref(sourceId, to, near), hops: 1 },
      { match: ref(sourceId, to, far), hops: 2, through: ref(sourceId, to, between) },
    ],
    nodes: [node(sourceId, from, anchor), node(sourceId, to, near), node(sourceId, to, between), node(sourceId, to, far)],
    edges: [
      evidenceEdge(sourceId, via, from, to, 'lk-0', anchor, near, ['AUTH-77200']),
      evidenceEdge(sourceId, via, from, to, 'lk-1', anchor, between, ['AUTH-77201']),
      evidenceEdge(sourceId, via, to, to, 'lk-2', between, far, ['AUTH-77202']),
    ],
    notices: [],
    warnings: [],
  });
}

/** The four typologies of the banking pack, as its mapping declares them, so that the panel lists them when a spec asks (`typologies` in the mode). */
const TRANSFER = { relationshipTypes: ['TRANSFERRED_TO'], direction: 'out', arrivesAt: 'account' };
const TYPOLOGIES = [
  { id: 'fan-out', name: 'Fan-out', description: 'One account sends to many accounts.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'account', steps: [{ ...TRANSFER, fan: { atLeast: 10 } }] } },
  { id: 'fan-in', name: 'Fan-in', description: 'Many accounts send to one account.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'account', steps: [{ ...TRANSFER, direction: 'in', fan: { atLeast: 10 } }] } },
  { id: 'cycles', name: 'Cycles', description: 'Money leaves an account and comes back to it.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'account', steps: [TRANSFER, TRANSFER, { ...TRANSFER, closesAtAnchor: true }] } },
  { id: 'rapid-pass-through', name: 'Rapid pass-through', description: 'Money arrives and leaves again within 24 hours.', group: 'AML typologies', tag: 'AML', definition: { anchorType: 'account', steps: [TRANSFER, { ...TRANSFER, after: 'previous', within: { hours: 24 } }] } },
];

/** `GET /v1/templates` and `POST /v1/templates/{id}/run`, scripted: the list is the profile's presets (or none while the mode says so) and the run answers by the limit of the request. */
export function createPatterns(profiles: () => readonly PatternProfile[]) {
  let noPresets = false;
  let typologies = false;
  return {
    /** `POST /v1/patterns/validate`: the contract's own check of the definition's shape and caps, and one scripted problem so that a spec reaches the not-valid state: a pattern that starts at a `merchant`. */
    validate(body: unknown, response: ServerResponse): void {
      const parsed = patternValidateRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } });
      const problems = patternProblemsOf(parsed.data.definition);
      if (problems.length === 0 && parsed.data.definition['anchorType'] === SCRIPTED_START) problems.push({ path: ['anchorType'], code: 'unknown-entity-type' });
      json(response, 200, problems.length === 0 ? { status: 'ok' } : { status: 'invalid', problems });
    },
    setMode(body: unknown, response: ServerResponse): void {
      noPresets = typeof body === 'object' && body !== null && 'noPresets' in body && body.noPresets === true;
      typologies = typeof body === 'object' && body !== null && 'typologies' in body && body.typologies === true;
      json(response, 200, {});
    },
    list(sourceId: string | null, response: ServerResponse): void {
      const profile = profiles().find((candidate) => candidate.sourceId === sourceId);
      if (profile === undefined) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-support' } });
      json(response, 200, {
        sourceId: profile.sourceId,
        templates: (['shared-attribute', 'linked-entities'] as const).map((id) => ({ id, version: '1', name: id, description: id, paramsSchema: paramsJsonSchemaOf(id) })),
        presets: noPresets ? [] : (profile.presets ?? []),
        builtInDefinitions: typologies && profile.sourceId === 'banking-demo' ? TYPOLOGIES : [],
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
      if (presetId === 'connected-accounts') return json(response, 200, linked(sourceId, anchor, presetId));
      json(response, 200, ring(sourceId, anchor, limit === LIMITS.none ? 0 : typesOfSource(sourceId).mates, presetId, { cut: limit === LIMITS.cut, stopList: limit === LIMITS.stopList }));
    },
  };
}

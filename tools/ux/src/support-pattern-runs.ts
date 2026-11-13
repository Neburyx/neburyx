import type { IncomingMessage, ServerResponse } from 'node:http';
import { patternPreviewResponseSchema, patternProblemsOf, patternRunRequestSchema, patternRunResponseSchema, patternValidateRequestSchema } from '@neburyx/contracts';

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const INVALID = { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } };
const BUSY = { error: { code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId: 'tr-support' } };

/** The starting entities for which the support server answers something other than the ring: no match, a heavy stop, a run that waits until the client leaves, a busy source. */
export const RUN_ANCHORS = { none: 'EMPTY-1', heavy: 'HEAVY-1', slow: 'SLOW-1', busy: 'BUSY-1', paged: 'PAGED-1', long: 'LONG-1' } as const;

export const LONG_MATCHES = { titled: `Ørestad Hafenbetriebsgesellschaft ${'mit sehr langem Namen '.repeat(6)}`.trim(), untitledId: `IMO-${'9'.repeat(70)}` } as const;

const refOf = (sourceId: string, entityType: string, stableId: string) => ({ sourceId, entityType, stableId });
const nodeOf = (sourceId: string, entityType: string, stableId: string) => ({
  ref: refOf(sourceId, entityType, stableId),
  display: { title: stableId, type: entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const DIRECTION_WORD = { out: 'outgoing', in: 'incoming', both: 'either way' } as const;

/** `POST /v1/patterns/preview`: the definition in words the support server writes, with the bounds of the sources it lists; a bad shape answers the contract's problems. */
/** A match whose labels are the worst a mapping can give: a long title with non-ASCII text, an entity with no title at all, a very long ID, many properties, and some empty. */
const longNode = (sourceId: string, entityType: string, stableId: string) => ({
  ...nodeOf(sourceId, entityType, stableId),
  display: { title: stableId === LONG_MATCHES.untitledId ? '' : `${LONG_MATCHES.titled} ${stableId}`, type: entityType },
  properties: [
    { key: 'a-property-with-a-label-that-runs-on-and-on', value: LONG_MATCHES.titled, dataClass: 'text', masked: false },
    { key: 'empty', value: '', dataClass: 'text', masked: false },
    ...Array.from({ length: 24 }, (_, index) => ({ key: `attribute ${index + 1}`, value: `Wert ${index + 1} · ååå`, dataClass: 'text', masked: false })),
  ],
});

export function previewPattern(body: unknown, response: ServerResponse): void {
  const parsed = patternValidateRequestSchema.safeParse(body);
  if (!parsed.success) return json(response, 400, INVALID);
  const problems = patternProblemsOf(parsed.data.definition);
  if (problems.length > 0) return json(response, 200, patternPreviewResponseSchema.parse({ status: 'invalid', problems }));
  const definition = parsed.data.definition as { anchorType: string; steps: Array<{ relationshipTypes: string[]; direction: keyof typeof DIRECTION_WORD; arrivesAt: string; conditions?: unknown[]; window?: unknown }> };
  json(
    response,
    200,
    patternPreviewResponseSchema.parse({
      status: 'ok',
      preview: {
        start: { type: definition.anchorType, name: definition.anchorType, text: `Starts at a ${definition.anchorType}.` },
        steps: definition.steps.map((step) => ({
          relationshipTypes: step.relationshipTypes,
          direction: step.direction,
          arrivesAt: { type: step.arrivesAt, name: step.arrivesAt },
          text: `Follows ${step.relationshipTypes.join(' or ')} ${DIRECTION_WORD[step.direction]} to a ${step.arrivesAt}.`,
          conditions: [],
        })),
        bounds: { hopLimit: { value: 4, text: 'At most 4 steps.' }, pageLimit: { value: 50, text: 'At most 50 results at a time.' }, countCap: { value: 500, text: 'Counts stop at 500.' } },
      },
    }),
  );
}

/** `POST /v1/patterns/run`, scripted by the starting entity (see `RUN_ANCHORS`); every other entity gets the ring: two matches, the second reached through an entity without an ID, and the two notices a run of such a pattern can carry. */
export async function runPattern(body: unknown, response: ServerResponse, request: IncomingMessage): Promise<void> {
  const parsed = patternRunRequestSchema.safeParse(body);
  if (!parsed.success) return json(response, 400, INVALID);
  const { sourceId, definition, anchor } = parsed.data;
  if (patternProblemsOf(definition).length > 0) return json(response, 400, INVALID);
  const steps = (definition as { steps: Array<{ relationshipTypes: string[] }> }).steps;
  const anchorType = String((definition as { anchorType: string }).anchorType);
  if (anchor.stableId === RUN_ANCHORS.busy) return json(response, 503, BUSY);
  if (anchor.stableId === RUN_ANCHORS.slow) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      request.on('close', () => (clearTimeout(timer), resolve()));
    });
    if (response.destroyed) return;
  }
  if (anchor.stableId === RUN_ANCHORS.heavy && parsed.data.continue !== true && parsed.data.cursor === undefined) {
    return json(response, 200, patternRunResponseSchema.parse({ status: 'heavy', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] }));
  }
  const arrival = String((definition as { steps: Array<{ arrivesAt: string }> }).steps.at(-1)?.arrivesAt ?? anchorType);
  const none = anchor.stableId === RUN_ANCHORS.none;
  const hops = steps.length;
  const typeOf = (index: number): string => steps[index]?.relationshipTypes[0] ?? 'REL';
  const secondPage = anchor.stableId === RUN_ANCHORS.paged && parsed.data.cursor !== undefined;
  const long = anchor.stableId === RUN_ANCHORS.long;
  const matches = none ? [] : long ? ['LONG-A', LONG_MATCHES.untitledId] : secondPage ? ['MATCH-3', 'MATCH-4'] : ['MATCH-1', 'MATCH-2'];
  const paged = anchor.stableId === RUN_ANCHORS.paged;
  const through = (second: boolean) => Array.from({ length: hops - 1 }, (_, index) => (second && index === 0 ? null : refOf(sourceId, anchorType, `MID-${index + 1}`)));
  const evidenceEdges = none
    ? []
    : matches.map((match, index) => ({
        ref: { sourceId, type: typeOf(hops - 1), from: arrival, to: arrival, stableId: `pr-${match}` },
        from: refOf(sourceId, anchorType, anchor.stableId),
        to: refOf(sourceId, arrival, match),
        type: typeOf(hops - 1),
        direction: 'from-to' as const,
        semantics: 'stored' as const,
        properties: [],
        evidenceRefs: [`AUTH-7730${index}`],
        qualityFlags: [],
      }));
  json(
    response,
    200,
    patternRunResponseSchema.parse({
      status: 'ok',
      templateVersion: '1',
      count: paged ? (secondPage ? { value: matches.length, quality: 'lowerBound', scope: 'matches' } : { value: 4, quality: 'exact', scope: 'matches' }) : { value: matches.length, quality: 'exact', scope: 'matches' },
      ...(paged && !secondPage ? { nextCursor: 'page-2' } : {}),
      matches: matches.map((match, index) => ({
        match: refOf(sourceId, arrival, match),
        hops,
        through: through(index === 1),
        relationships: Array.from({ length: hops }, (_, hop) => {
          const chain = [refOf(sourceId, anchorType, anchor.stableId), ...through(index === 1), refOf(sourceId, arrival, match)];
          return { relationshipType: index === 1 && hop === 0 ? null : typeOf(hop), from: chain[hop] ?? null, to: chain[hop + 1] ?? null, ...(hop === hops - 1 ? { stableId: `pr-${match}` } : {}) };
        }),
      })),
      nodes: none ? [nodeOf(sourceId, anchorType, anchor.stableId)] : [nodeOf(sourceId, anchorType, anchor.stableId), ...matches.map((match) => (long ? longNode(sourceId, arrival, match) : nodeOf(sourceId, arrival, match)))],
      edges: evidenceEdges,
      notices: none ? [] : [{ code: 'supernodesSkipped', entities: [refOf(sourceId, anchorType, 'HUB-1')] }, { code: 'windowNotApplied', relationshipTypes: [typeOf(0)] }],
      warnings: [],
    }),
  );
}

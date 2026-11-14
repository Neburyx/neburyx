import type { AskRunResult, DegreePreview, DerivedEdgeDetail, DerivedNeighborsResponse, ElementRef, ExpandResponse, GraphEdge, GraphNode, SearchResult, TemplateRunOk } from '@neburyx/contracts';

/** A fixed, contract-valid result for each template, built from the parameters of the plan that ran: what a source would answer, and nothing else. */
const exact = (value: number) => ({ quality: 'exact' as const, value, scope: 'scripted' });

const node = (ref: ElementRef, title: string): GraphNode => ({
  ref,
  display: { title, type: ref.entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const edge = (from: ElementRef, to: ElementRef, type: string, derived?: { readonly ruleId: string }): GraphEdge =>
  ({
    ref: derived === undefined ? { sourceId: from.sourceId, type, from: from.entityType, to: to.entityType, stableId: `${from.stableId}-${to.stableId}` } : { sourceId: from.sourceId, derived: { ruleId: derived.ruleId, from, to } },
    from,
    to,
    type,
    direction: 'from-to',
    semantics: derived === undefined ? 'stored' : 'derived',
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  }) as unknown as GraphEdge;

const refOf = (value: unknown, sourceId: string): ElementRef => {
  const given = value as { entityType: string; stableId: string };
  return { sourceId, entityType: given.entityType, stableId: given.stableId };
};

const otherOf = (anchor: ElementRef, entityType: string, label: string): ElementRef => ({ sourceId: anchor.sourceId, entityType, stableId: `${label}-1` });
const textOf = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : fallback);

/** The result a source would give for a stored plan, in the shape the template's answer has. */
export function scriptedResult(templateId: string, params: Record<string, unknown>, sourceId: string): AskRunResult {
  switch (templateId) {
    case 'entity':
      return { templateId, result: node(refOf(params['ref'], sourceId), 'The entity') };
    case 'degree-preview': {
      const anchor = refOf(params['ref'], sourceId);
      const result: DegreePreview = { ref: anchor, total: exact(3), byType: [{ relationshipType: 'LINKS', direction: 'out', count: exact(3), neighborTypes: ['other'] }], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
      return { templateId, result };
    }
    case 'shared-attribute':
    case 'linked-entities': {
      const anchor = refOf(params['ref'], sourceId);
      const target = textOf(params['targetType'], anchor.entityType);
      const match = otherOf(anchor, target, 'match');
      const run: TemplateRunOk = {
        status: 'ok',
        templateId,
        templateVersion: '1',
        count: exact(1),
        matchIds: [match],
        nodes: [node(anchor, 'The anchor'), node(match, 'A match')],
        edges: [],
        ...(templateId === 'linked-entities' ? { links: [{ match, hops: 1 as const }] } : {}),
        notices: [],
        warnings: [],
      };
      return { templateId, result: run } as AskRunResult;
    }
    case 'expand': {
      const anchor = refOf(params['ref'], sourceId);
      const neighbor = otherOf(anchor, textOf(params['neighborTypes'], 'other'), 'neighbor');
      const result: ExpandResponse = {
        ref: anchor,
        pageSize: 25,
        nodes: [node(anchor, 'The anchor'), node(neighbor, 'A neighbor')],
        edges: [edge(anchor, neighbor, textOf(params['relTypes'], 'LINKS'))],
        pages: [{ neighborType: neighbor.entityType, returned: 1, hasMore: false, matchingTotal: exact(1) }],
        warnings: [],
      };
      return { templateId, result };
    }
    case 'derived-rule-run': {
      const anchor = refOf(params['ref'], sourceId);
      const other = otherOf(anchor, anchor.entityType, 'other');
      const ruleId = textOf(params['ruleId'], 'rule');
      const result: DerivedNeighborsResponse = {
        ref: anchor,
        results: [{ ruleId, ruleVersion: 1, count: exact(1), nodes: [node(anchor, 'The anchor'), node(other, 'Another')], edges: [edge(anchor, other, 'DERIVED', { ruleId })], warnings: [] }],
      };
      return { templateId, result };
    }
    case 'derived-edge-support': {
      const ends = (params['ends'] as unknown[]).map((end) => refOf(end, sourceId));
      const [first, second] = ends;
      if (first === undefined || second === undefined) throw new Error('a derived-edge-support plan names two ends');
      const end = (ref: ElementRef, title: string) => ({ ref, title, type: ref.entityType });
      const result: DerivedEdgeDetail = {
        ref: { sourceId, derived: { ruleId: textOf(params['ruleId'], 'rule'), from: first, to: second } },
        type: 'DERIVED',
        semantics: 'derived',
        rule: { id: textOf(params['ruleId'], 'rule'), version: 1 },
        from: end(first, 'The first end'),
        to: end(second, 'The second end'),
        supports: { count: exact(0), groups: [] },
        qualityFlags: [],
        warnings: [],
      };
      return { templateId, result };
    }
    case 'search': {
      const found = otherOf({ sourceId, entityType: textOf(params['entityTypes'], 'entity'), stableId: 'x' }, textOf(params['entityTypes'], 'entity'), 'found');
      const result = {
        sourceId,
        exact: [node(found, 'A match')],
        exactMatches: [{ ref: found, matchedProperties: [] }],
        cap: 25,
        searchable: true,
        counts: { exact: exact(1) },
        disabledTypes: [],
        related: { hits: [], count: exact(0), searchable: true, disabledTypes: [] },
        evidence: { hits: [], count: exact(0), searchable: true, disabledRelationshipTypes: [] },
        failures: [],
        dropped: {},
        warnings: [],
        elapsedMs: 1,
      } as unknown as SearchResult;
      return { templateId, result };
    }
    default:
      throw new Error(`no scripted result for the template ${templateId}`);
  }
}

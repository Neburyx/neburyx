import { assistantTurnAnswerSchema, assistantTurnRequestSchema, expandRequestSchema, expandResponseSchema, openInvestigationRequestSchema, openInvestigationResponseSchema } from '@neburyx/contracts';

interface HttpResponse {
  readonly status: number;
  readonly header: (name: string) => string | undefined;
  readonly json: () => unknown;
}

/** One request to the running product. A turn is the only request that can start model calls. */
export type Http = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResponse>;

export interface RepeatSettings {
  readonly model: string;
  readonly callLimit: number;
  readonly effort?: string | undefined;
  /** Where the effort and the model come from: the settings file or the product's default. */
  readonly effortSource?: string | undefined;
  readonly modelSource?: string | undefined;
  /** The settings the file sets, by the name the run record holds them under: each is checked against the record of the first turn. */
  readonly configured: Readonly<Record<string, string | number | boolean>>;
}

export interface RepeatOptions {
  readonly http: Http;
  readonly manifest: { readonly name: string; readonly sourceId: string; readonly anchor: { readonly entityType: string; readonly stableId: string }; readonly neighbourType: string; readonly neighbours: number; readonly edgesView?: { readonly neighbourTypes: readonly string[]; readonly entities: number; readonly relationships: number }; readonly messages: readonly string[] };
  readonly manifestSha256: string;
  readonly repeat: number;
  readonly arm: string;
  readonly head: string;
  readonly settings: RepeatSettings;
  /** The model calls this repeat may still start; a turn is never started when the remaining budget cannot cover its most calls. Absent: no budget. */
  readonly budget?: number;
  readonly now: () => number;
  /** Called with the first turn once it is recorded: a text means its records disagree with what was verified before the run, and the repeat stops. */
  readonly verifyFirstTurn?: (turn: TurnRecord) => Promise<string | undefined>;
}

type TurnStatus = 'answered' | 'refused' | 'waiting' | 'stopped' | 'failed' | 'other';

export interface TurnRecord {
  readonly n: number;
  readonly message: string;
  readonly traceId?: string | undefined;
  readonly ms: number;
  readonly httpStatus: number;
  readonly status: TurnStatus;
  readonly answer?: unknown;
}

type RepeatEnd = 'complete' | 'waiting' | 'failed' | 'budget';

export interface RepeatFile {
  readonly manifest: { readonly name: string; readonly sha256: string };
  readonly sourceId: string;
  readonly repeat: number;
  /** The messages the repeat was to send, in order: a repeat that stopped early still names every turn it was to have. */
  readonly expectedMessages: readonly string[];
  readonly arm: string;
  readonly head: string;
  readonly settings: RepeatSettings;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly view: { readonly entities: number; readonly relationships?: number };
  readonly turns: readonly TurnRecord[];
  readonly ended: RepeatEnd;
  /** Why the repeat ended before its last message: a cause, never a value. */
  readonly stoppedBecause?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The keys of the elements of the plain view: the anchor and the first `neighbours` neighbours of the type, as the canvas names them. */
interface ViewBuild {
  readonly keys: readonly string[];
  readonly entities: number;
  /** The relationships of an edges view; absent for the plain view. */
  readonly relationships?: number;
}

class RepeatFailure extends Error {
  constructor(readonly cause_: string) {
    super(cause_);
  }
}

const keyOf = (ref: { readonly sourceId: string; readonly entityType: string; readonly stableId: string }): string => JSON.stringify(['node', ref.sourceId, ref.entityType, ref.stableId]);

/**
 * The plain view of the thread: exactly the anchor and its first neighbours of the one type, entities only, no relationship and nothing selected, read by the bounded expansion the canvas uses. A view that holds
 * another count or another type of element is refused.
 */
async function buildView(options: RepeatOptions): Promise<ViewBuild> {
  const { http, manifest } = options;
  if (manifest.edgesView !== undefined) return buildEdgesView(options, manifest.edgesView);
  const request = expandRequestSchema.safeParse({ sourceId: manifest.sourceId, ref: manifest.anchor, neighborTypes: [manifest.neighbourType], limit: manifest.neighbours });
  if (!request.success) throw new RepeatFailure('the expansion request does not fit the contract');
  const response = await call(http, 'POST', '/v1/graph/expand', request.data, 'the expansion of the anchor');
  const body = expandResponseSchema.safeParse(response.json());
  if (response.status !== 200 || !body.success) throw new RepeatFailure('the expansion of the anchor failed or did not fit the contract');
  const typed = body.data.nodes.map((node) => ({ sourceId: node.ref.sourceId, entityType: node.ref.entityType, stableId: node.ref.stableId }));
  const isAnchor = (ref: { readonly entityType: string; readonly stableId: string }): boolean => ref.entityType === manifest.anchor.entityType && ref.stableId === manifest.anchor.stableId;
  const anchors = typed.filter(isAnchor);
  const neighbours = typed.filter((ref) => !isAnchor(ref));
  if (anchors.length !== 1) throw new RepeatFailure('the view does not hold the anchor exactly once');
  if (neighbours.some((ref) => ref.entityType !== manifest.neighbourType)) throw new RepeatFailure('the view holds an element of another type than the anchor and its neighbours');
  if (neighbours.length !== manifest.neighbours) throw new RepeatFailure(`the view holds ${neighbours.length} neighbours, not ${manifest.neighbours}`);
  const entities = [...anchors, ...neighbours];
  if (new Set(entities.map(keyOf)).size !== entities.length) throw new RepeatFailure('the view holds an element twice');
  return { keys: entities.map(keyOf), entities: entities.length };
}

type ExpandEdge = ReturnType<typeof expandResponseSchema.parse>['edges'][number];

/** The key the panel sends for a relationship of the view: a stored one by its id, an aggregate (the expansion's relationships of one type between two elements) by its type and ends. A derived one has no key here: the view is the stored relationships only. */
function edgeKeyOf(edge: ExpandEdge): string {
  const ref = edge.ref;
  if ('stableId' in ref) return JSON.stringify(['edge', ref.sourceId, 'stored', ref.type, ref.from, ref.to, ref.stableId]);
  if ('aggregate' in ref) return JSON.stringify(['edge', ref.sourceId, 'aggregate', ref.aggregate.type, keyOf(ref.aggregate.from), keyOf(ref.aggregate.to)]);
  throw new RepeatFailure('the view holds a relationship that is not a stored one');
}

/**
 * The edges view: the anchor expanded to the types of neighbours the manifest names, by the bounded expansion the canvas uses, with the relationships between the elements the expansion returned. It holds exactly the entities and
 * relationships the manifest says, every element of a named type, each once, and every relationship a stored one; a view that differs is refused, as the plain view is.
 */
async function buildEdgesView(options: RepeatOptions, shape: NonNullable<RepeatOptions['manifest']['edgesView']>): Promise<ViewBuild> {
  const { http, manifest } = options;
  const request = expandRequestSchema.safeParse({ sourceId: manifest.sourceId, ref: manifest.anchor, neighborTypes: [...shape.neighbourTypes], limit: manifest.neighbours });
  if (!request.success) throw new RepeatFailure('the expansion request does not fit the contract');
  const response = await call(http, 'POST', '/v1/graph/expand', request.data, 'the expansion of the anchor');
  const body = expandResponseSchema.safeParse(response.json());
  if (response.status !== 200 || !body.success) throw new RepeatFailure('the expansion of the anchor failed or did not fit the contract');
  const entities = body.data.nodes.map((node) => ({ sourceId: node.ref.sourceId, entityType: node.ref.entityType, stableId: node.ref.stableId }));
  const isAnchor = (ref: { readonly sourceId: string; readonly entityType: string; readonly stableId: string }): boolean => ref.sourceId === manifest.sourceId && ref.entityType === manifest.anchor.entityType && ref.stableId === manifest.anchor.stableId;
  if (entities.some((ref) => ref.sourceId !== manifest.sourceId)) throw new RepeatFailure('the view holds an element of another source than the manifest names');
  if (entities.filter(isAnchor).length !== 1) throw new RepeatFailure('the view does not hold the anchor exactly once');
  if (entities.some((ref) => !isAnchor(ref) && !shape.neighbourTypes.includes(ref.entityType))) throw new RepeatFailure('the view holds an element of a type the manifest does not name');
  if (new Set(entities.map(keyOf)).size !== entities.length) throw new RepeatFailure('the view holds an element twice');
  if (entities.length !== shape.entities) throw new RepeatFailure(`the view holds ${entities.length} entities, not ${shape.entities}`);
  const edges = body.data.edges;
  // stored relationships only: one by its id, or an aggregate of stored ones; a derived relationship is another view
  if (edges.some((edge) => edge.semantics !== 'stored' || 'derived' in edge.ref)) throw new RepeatFailure('the view holds a relationship that is not a stored one');
  if (edges.some((edge) => edge.ref.sourceId !== manifest.sourceId)) throw new RepeatFailure('the view holds a relationship of another source than the manifest names');
  // the reference that names a relationship in the key must be the relationship the expansion returned: its type and ends are those the relationship itself carries
  const agrees = (edge: ExpandEdge): boolean => {
    const ref = edge.ref;
    if ('stableId' in ref) return ref.type === edge.type && ref.from === edge.from.entityType && ref.to === edge.to.entityType;
    return 'aggregate' in ref && ref.aggregate.type === edge.type && keyOf(ref.aggregate.from) === keyOf(edge.from) && keyOf(ref.aggregate.to) === keyOf(edge.to);
  };
  if (edges.some((edge) => !agrees(edge))) throw new RepeatFailure('the view holds a relationship whose reference does not agree with the relationship');
  const held = new Set(entities.map(keyOf));
  if (edges.some((edge) => !held.has(keyOf(edge.from)) || !held.has(keyOf(edge.to)))) throw new RepeatFailure('the view holds a relationship with an end that is not an element of the view');
  const edgeKeys = edges.map(edgeKeyOf);
  if (new Set(edgeKeys).size !== edgeKeys.length) throw new RepeatFailure('the view holds a relationship twice');
  if (edges.length !== shape.relationships) throw new RepeatFailure(`the view holds ${edges.length} relationships, not ${shape.relationships}`);
  return { keys: [...entities.map(keyOf), ...edgeKeys], entities: entities.length, relationships: edges.length };
}

/** One request, with a transport failure (no answer, a timeout, a redirect) turned into a named failure of the repeat, never an exception that loses the turns already recorded. */
async function call(http: Http, method: 'GET' | 'POST', path: string, body: unknown, what: string): Promise<HttpResponse> {
  try {
    return await http(method, path, body);
  } catch {
    throw new RepeatFailure(`${what}: the request did not complete (no answer, a timeout or a redirect)`);
  }
}

function statusOf(httpStatus: number, body: unknown): { readonly status: TurnStatus; readonly answer: unknown } {
  const parsed = assistantTurnAnswerSchema.safeParse(body);
  if (httpStatus !== 200 || !parsed.success) return { status: 'failed', answer: body };
  const answer = parsed.data;
  if (answer.status === 'meaning' || answer.status === 'no-description') return { status: 'answered', answer };
  if (answer.status === 'answered') return { status: answer.route === 'refuse' ? 'refused' : 'answered', answer };
  if (answer.status === 'confirmation' || answer.status === 'clarification') return { status: 'waiting', answer };
  if (answer.status === 'too-large' || answer.status === 'too-long' || answer.status === 'limit') return { status: 'stopped', answer };
  if (answer.status === 'unavailable' || answer.status === 'cancelled') return { status: 'failed', answer };
  return { status: 'other', answer };
}

/**
 * One repeat of the thread: a fresh investigation on the anchor, the plain view, and the messages sent in order as typed messages of one thread. A turn that waits for a choice or a confirmation ends the repeat with
 * that status; a turn the product stopped with its own limit sentence (limit, too-large, too-long) is an answer and the thread goes on; a failed turn stops it; the tool answers nothing on the person's behalf. The file it returns holds no key or connection string: it holds what the product returned.
 */
export async function runRepeat(options: RepeatOptions): Promise<RepeatFile> {
  const { http, manifest, settings } = options;
  const startedAt = new Date(options.now()).toISOString();
  const turns: TurnRecord[] = [];
  let view: ViewBuild = { keys: [], entities: 0 };
  let ended: RepeatEnd = 'complete';
  let stoppedBecause: string | undefined;
  let remaining = options.budget;
  const finish = (): RepeatFile => ({
    manifest: { name: manifest.name, sha256: options.manifestSha256 },
    sourceId: manifest.sourceId,
    repeat: options.repeat,
    expectedMessages: manifest.messages,
    arm: options.arm,
    head: options.head,
    settings,
    startedAt,
    endedAt: new Date(options.now()).toISOString(),
    view: { entities: view.entities, ...(view.relationships === undefined ? {} : { relationships: view.relationships }) },
    turns,
    ended,
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
  });
  try {
    const openRequest = openInvestigationRequestSchema.safeParse({ sourceId: manifest.sourceId, entity: { sourceId: manifest.sourceId, ...manifest.anchor } });
    if (!openRequest.success) throw new RepeatFailure('the investigation request does not fit the contract');
    const created = await call(http, 'POST', '/v1/investigations', openRequest.data, 'the opening of the investigation');
    const opened = openInvestigationResponseSchema.safeParse(created.json());
    if (created.status >= 300 || !opened.success) throw new RepeatFailure('the investigation could not be opened');
    if (opened.data.created !== true) throw new RepeatFailure('the investigation already existed: a fresh one is required');
    const investigationId = opened.data.investigation.id;
    view = await buildView(options);
    for (const [index, message] of manifest.messages.entries()) {
      if (remaining !== undefined && remaining < settings.callLimit) {
        ended = 'budget';
        stoppedBecause = 'the remaining budget cannot cover another turn';
        break;
      }
      const started = options.now();
      const turnRequest = assistantTurnRequestSchema.safeParse({ sourceId: manifest.sourceId, investigationId, message, viewElementKeys: view.keys });
      if (!turnRequest.success) throw new RepeatFailure('the turn request does not fit the contract');
      let response: HttpResponse;
      try {
        response = await http('POST', '/v1/assistant/turns', turnRequest.data);
      } catch {
        turns.push({ n: index + 1, message, traceId: undefined, ms: Math.max(0, Math.round(options.now() - started)), httpStatus: 0, status: 'failed', answer: undefined });
        if (remaining !== undefined) remaining -= settings.callLimit;
        ended = 'failed';
        stoppedBecause = `turn ${index + 1}: the request did not complete (no answer, a timeout or a redirect)`;
        break;
      }
      const decided = statusOf(response.status, response.json());
      const traceId = response.header('x-trace-id');
      const status: TurnStatus = decided.status !== 'failed' && traceId === undefined ? 'failed' : decided.status;
      turns.push({ n: index + 1, message, traceId, ms: Math.max(0, Math.round(options.now() - started)), httpStatus: response.status, status, answer: decided.answer });
      if (remaining !== undefined) remaining -= settings.callLimit;
      const first = turns[0];
      if (index === 0 && first !== undefined && options.verifyFirstTurn !== undefined && status !== 'failed') {
        let problem: string | undefined;
        try {
          problem = await options.verifyFirstTurn(first);
        } catch {
          problem = 'the records of the first turn could not be read: the repeat stops with its turns kept';
        }
        if (problem !== undefined) {
          ended = 'failed';
          stoppedBecause = problem;
          break;
        }
      }
      if (status === 'failed') {
        ended = 'failed';
        stoppedBecause = traceId === undefined && decided.status !== 'failed' ? `turn ${index + 1} returned no trace id` : `turn ${index + 1} failed`;
        break;
      }
      if (status === 'waiting') {
        ended = 'waiting';
        stoppedBecause = `turn ${index + 1} waits for a choice or a confirmation`;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof RepeatFailure)) throw error;
    ended = 'failed';
    stoppedBecause = error.cause_;
  }
  return finish();
}

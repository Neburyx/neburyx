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
  readonly effort?: string;
}

export interface RepeatOptions {
  readonly http: Http;
  readonly manifest: { readonly name: string; readonly sourceId: string; readonly anchor: { readonly entityType: string; readonly stableId: string }; readonly neighbourType: string; readonly neighbours: number; readonly messages: readonly string[] };
  readonly manifestSha256: string;
  readonly arm: string;
  readonly head: string;
  readonly settings: RepeatSettings;
  /** The model calls this repeat may still start; a turn is never started when the remaining budget cannot cover its most calls. Absent: no budget. */
  readonly budget?: number;
  readonly now: () => number;
  /** Called with the first turn once it is recorded: a text means its records disagree with what was verified before the run, and the repeat stops. */
  readonly verifyFirstTurn?: (turn: TurnRecord) => Promise<string | undefined>;
}

type TurnStatus = 'answered' | 'refused' | 'waiting' | 'failed' | 'other';

export interface TurnRecord {
  readonly n: number;
  readonly message: string;
  readonly traceId: string | undefined;
  readonly ms: number;
  readonly httpStatus: number;
  readonly status: TurnStatus;
  /** The answer as the product returned it. */
  readonly answer: unknown;
}

type RepeatEnd = 'complete' | 'waiting' | 'failed' | 'budget';

export interface RepeatFile {
  readonly manifest: { readonly name: string; readonly sha256: string };
  readonly arm: string;
  readonly head: string;
  readonly settings: RepeatSettings;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly view: { readonly entities: number };
  readonly turns: readonly TurnRecord[];
  readonly ended: RepeatEnd;
  /** Why the repeat ended before its last message: a cause, never a value. */
  readonly stoppedBecause?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The keys of the elements of the plain view: the anchor and the first `neighbours` neighbours of the type, as the canvas names them. */
interface ViewBuild {
  readonly keys: readonly string[];
  readonly entities: number;
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
  const response = await http('POST', '/v1/graph/expand', { sourceId: manifest.sourceId, ref: manifest.anchor, neighborTypes: [manifest.neighbourType], limit: manifest.neighbours });
  const body = response.json();
  if (response.status !== 200 || !isRecord(body) || !Array.isArray(body['nodes'])) throw new RepeatFailure('the expansion of the anchor failed');
  const refs = body['nodes'].flatMap((node) => (isRecord(node) && isRecord(node['ref']) ? [node['ref']] : []));
  const typed = refs.flatMap((ref) => (typeof ref['sourceId'] === 'string' && typeof ref['entityType'] === 'string' && typeof ref['stableId'] === 'string' ? [{ sourceId: ref['sourceId'], entityType: ref['entityType'], stableId: ref['stableId'] }] : []));
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

function statusOf(httpStatus: number, answer: unknown): TurnStatus {
  if (httpStatus !== 200 || !isRecord(answer)) return 'failed';
  const status = answer['status'];
  if (status === 'answered') return answer['route'] === 'refuse' ? 'refused' : 'answered';
  if (status === 'confirmation' || status === 'clarification') return 'waiting';
  if (status === 'unavailable' || status === 'too-large' || status === 'too-long') return 'failed';
  return 'other';
}

/**
 * One repeat of the thread: a fresh investigation on the anchor, the plain view, and the messages sent in order as typed messages of one thread. A turn that waits for a choice or a confirmation ends the repeat with
 * that status; a failed turn stops it; the tool answers nothing on the person's behalf. The file it returns holds no key or connection string: it holds what the product returned.
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
    arm: options.arm,
    head: options.head,
    settings,
    startedAt,
    endedAt: new Date(options.now()).toISOString(),
    view: { entities: view.entities },
    turns,
    ended,
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
  });
  try {
    const created = await http('POST', '/v1/investigations', { sourceId: manifest.sourceId, entity: { sourceId: manifest.sourceId, ...manifest.anchor } });
    const createdBody = created.json();
    const investigationId = isRecord(createdBody) && typeof createdBody['id'] === 'string' ? createdBody['id'] : undefined;
    if (created.status >= 300 || investigationId === undefined) throw new RepeatFailure('the investigation could not be opened');
    view = await buildView(options);
    for (const [index, message] of manifest.messages.entries()) {
      if (remaining !== undefined && remaining < settings.callLimit) {
        ended = 'budget';
        stoppedBecause = 'the remaining budget cannot cover another turn';
        break;
      }
      const started = options.now();
      const response = await http('POST', '/v1/assistant/turns', { sourceId: manifest.sourceId, investigationId, message, viewElementKeys: view.keys });
      const answer = response.json();
      const status = statusOf(response.status, answer);
      turns.push({ n: index + 1, message, traceId: response.header('x-trace-id'), ms: Math.max(0, Math.round(options.now() - started)), httpStatus: response.status, status, answer });
      if (remaining !== undefined) remaining -= settings.callLimit;
      if (index === 0 && options.verifyFirstTurn !== undefined && status !== 'failed') {
        const problem = await options.verifyFirstTurn(turns[0] as TurnRecord);
        if (problem !== undefined) {
          ended = 'failed';
          stoppedBecause = problem;
          break;
        }
      }
      if (status === 'failed') {
        ended = 'failed';
        stoppedBecause = `turn ${index + 1} failed`;
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

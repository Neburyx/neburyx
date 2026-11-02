import { z } from 'zod';
import { communitySeams } from '../seams/community-seams.js';
import type { Principal, Seams } from '../seams/seams.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { createGates } from '../gate/gate.js';
import type { GateDeps } from '../gate/deps.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../gate/executor.js';
import type {
  Budgets,
  ElementRef,
  Gate,
  SourceAllowlist,
  SystemRunner,
  GateObserver,
  GateRequest,
  GateStage,
  Item,
  Params,
  Row,
  Template,
  TemplateCatalog,
} from '../gate/types.js';
import { LOCAL_IDENTITY } from './app-store.js';

export const SOURCE_A = 'source-a';
export const SOURCE_B = 'source-b';
export const TEST_CYPHER = 'MATCH (n:Item) WHERE n.key = $key RETURN n.title AS title LIMIT $limit';

const refSchema = z.strictObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() });

export function testTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'test-read',
    version: '1',
    auditAction: 'test.read',
    cypher: TEST_CYPHER,
    paramsSchema: z.strictObject({ key: z.string(), ref: refSchema.optional() }),
    scope: 'user',
    paged: false,
    entityParams: [],
    relationshipParams: [],
    integerParameters: [],
    refsOf: (params: Params): readonly ElementRef[] => {
      const parsed = refSchema.safeParse(params['ref']);
      return parsed.success ? [parsed.data] : [];
    },
    normalize: (rows: readonly Row[]): readonly Item[] => rows.map((row) => ({ title: String(row['title']) })),
    ...overrides,
  };
}

export function testCatalog(templates: readonly Template[] = [testTemplate()], disabledFor: ReadonlySet<string> = new Set()): TemplateCatalog {
  return {
    find: (templateId) => templates.find((template) => template.id === templateId),
    isEnabled: (templateId, sourceId) => !disabledFor.has(`${templateId}@${sourceId}`),
  };
}

export class TestExecutor implements ReadExecutor {
  readonly calls: ExecuteCall[] = [];

  constructor(private readonly respond: (call: ExecuteCall) => Promise<ExecuteOutcome> = (call) => Promise.resolve(rowsOf(call.rowLimit - 1))) {}

  execute(call: ExecuteCall): Promise<ExecuteOutcome> {
    this.calls.push(call);
    return this.respond(call);
  }
}

export function rowsOf(count: number): ExecuteOutcome {
  return { status: 'rows', rows: Array.from({ length: count }, (_, index) => ({ title: `item ${index + 1}` })) };
}

export function recordingObserver(): GateObserver & { readonly events: { stage: GateStage; outcome: 'ok' | 'failed' }[] } {
  const events: { stage: GateStage; outcome: 'ok' | 'failed' }[] = [];
  return { events, stage: (stage, outcome) => void events.push({ stage, outcome }) };
}

export function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => void (current += ms) };
}

export const LOCAL_PRINCIPAL: Principal = LOCAL_IDENTITY.principal;

export function gateRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    traceId: 'tr-test',
    principal: LOCAL_PRINCIPAL,
    sourceId: SOURCE_A,
    templateId: 'test-read',
    params: { key: 'k1' },
    limit: 10,
    ...overrides,
  };
}

export const EMPTY_ALLOWLIST: SourceAllowlist = { entityLabels: new Map(), relationshipTypes: new Set() };

export interface Harness {
  readonly gate: Gate;
  readonly system: SystemRunner;
  readonly executor: TestExecutor;
  readonly observer: ReturnType<typeof recordingObserver>;
  readonly logs: { fields: object; message: string }[];
}

export interface HarnessOptions {
  readonly seams?: Partial<Pick<Seams, 'policy' | 'coordinator' | 'audit'>>;
  readonly catalog?: TemplateCatalog;
  readonly executor?: TestExecutor;
  readonly budgetsFor?: (sourceId: string) => Budgets;
  readonly allowlistFor?: (sourceId: string) => SourceAllowlist;
  readonly redact?: GateDeps['redact'];
  readonly clock?: () => number;
}

export function harness(options: HarnessOptions = {}): Harness {
  const executor = options.executor ?? new TestExecutor();
  const observer = recordingObserver();
  const logs: { fields: object; message: string }[] = [];
  const defaults = communitySeams();
  const { gate, system } = createGates({
    seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit, ...options.seams },
    catalog: options.catalog ?? testCatalog(),
    executor,
    budgetsFor: options.budgetsFor ?? (() => DEFAULT_BUDGETS),
    allowlistFor: options.allowlistFor ?? (() => EMPTY_ALLOWLIST),
    redact: options.redact ?? ((items) => items),
    clock: options.clock ?? (() => 1_000_000),
    logger: { warn: (fields, message) => void logs.push({ fields, message }) },
    observer,
  });
  return { gate, system, executor, observer, logs };
}

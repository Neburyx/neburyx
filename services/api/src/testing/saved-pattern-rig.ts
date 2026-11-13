import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import type { Identity } from '../identity/identity.js';
import type { CursorCodec } from '../gate/cursor/codec.js';
import type { Seams } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryStoreWith, type MemoryAppStore, type MemoryAppStoreOptions } from './app-store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { TemplateProbe } from '../graph/template-probes.js';
import type { MappingModel } from '../mapping/model.js';
import { TestExecutor } from './gate.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from './search-fixtures.js';
import { DERIVED_RULE } from './derived-fixtures.js';
import { LINKED_PRESET, LINKED_RELATIONSHIPS } from './linked-entities-fixtures.js';
import { baseSource, fileOf } from './mapping.js';
import { parseMapping } from '../mapping/load.js';
import { deriveReferenceKeys } from '../reference/keys.js';
import { testSourceGate } from './source-gate.js';
import { makeWebRoot } from './web-root.js';

/** The entities of the saved-pattern route tests: a maker with a filterable tier and a filterable personal phone, and a tool. */
export const PATTERN_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['tier', 'phoneNum'], pii: [{ property: 'phoneNum', class: 'phone' }] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId' },
  { type: 'shop', label: 'Shop', stable_id: 'shopId' },
  { type: 'handle', label: 'Handle', stable_id: 'handleNo', pii: [{ property: 'handleNo', class: 'phone' }] },
];
export const PATTERN_RELATIONSHIPS = [...LINKED_RELATIONSHIPS, { type: 'CALLS', from: 'handle', to: 'maker', stable_id: 'callId' }];
export const SHARED_PRESET = { id: 'shared-tools', name: 'Shared tools', template: 'shared-attribute', bind: { anchor: 'maker', attribute: 'tool', via: 'USES_TOOL' } };

const sourceOf = (id: string) => baseSource({ id, entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [LINKED_PRESET, SHARED_PRESET] });

/** Two sources with the same mapping, so that a cursor of one can be tried on the other. */
export const SAVED_PATTERN_MAPPING = parseMapping(fileOf(sourceOf('demo'), sourceOf('second')), 'neburyx.yaml');

/** The keys of the application in these tests, so a test can make the token of a keyed type's value. */
export const TEST_KEYS = deriveReferenceKeys(Buffer.alloc(32, 7));

export const DEFINITION = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }] };

export interface RecordingAudit {
  readonly sink: AuditSink;
  readonly events: AuditEvent[];
}

export function recordingAudit(): RecordingAudit {
  const events: AuditEvent[] = [];
  return {
    sink: {
      record: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    events,
  };
}

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

/** An application on the memory store, with a recording audit sink, and an executor that fails the test on any call: the saved-pattern routes read no source. */
export interface PatternAppOptions extends MemoryAppStoreOptions {
  /** Another person: the application answers for this identity. */
  readonly identity?: Identity;
  /** A store to share (the rows of another person's application), and the cursor codec of both. */
  readonly sharing?: MemoryAppStore;
  readonly cursors?: CursorCodec;
  /** The policy refuses every source. */
  readonly deny?: boolean;
  /** Another mapping than the shared one (a mapping that changed), and what the source answers to a read: with it the executor answers instead of failing the test. */
  readonly mapping?: MappingModel;
  readonly answer?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  readonly probes?: ReadonlyMap<string, TemplateProbe>;
  readonly now?: () => Date;
  readonly policyVersion?: () => string;
}

export async function patternApp(options: PatternAppOptions = {}) {
  const base: MemoryAppStore = options.sharing ?? memoryStoreWith(options);
  const store: MemoryAppStore = options.identity === undefined ? base : { ...base, current: () => Promise.resolve(options.identity as Identity) };
  const audit = recordingAudit();
  const mapping = options.mapping ?? SAVED_PATTERN_MAPPING;
  const [first] = mapping.sources;
  if (first === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(
    options.answer === undefined
      ? () => {
          throw new Error('a saved-pattern route called the source');
        }
      : withSchema(() => schemaAnswer(onlineIndexesOf(first)), options.answer),
  );
  const seams: Seams = { ...communitySeams(), audit: audit.sink, ...(options.deny === true ? { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } } : {}) };
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: parts.gate, seams, catalog: parts.catalog, referenceKeys: TEST_KEYS, ...(options.cursors === undefined ? {} : { cursors: options.cursors }), ...(options.probes === undefined ? {} : { templateProbes: options.probes }), ...(options.now === undefined ? {} : { templateRunClock: options.now }), ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }) });
  return { app, store, audit, executor };
}

export type PatternApp = Awaited<ReturnType<typeof patternApp>>;

/** A second person, for the rule that a pattern is its owner's. */
export const OTHER_IDENTITY: Identity = { principal: { id: '0192f000-0000-7000-8000-000000000002', displayName: 'Another person', role: 'administrator' }, edition: 'community', identityMode: 'none' };

export const jsonHeaders = { 'content-type': 'application/json' };
export const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;
export const reasonOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { details?: { reason?: unknown } } }).error?.details?.reason;

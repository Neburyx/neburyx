import { createCopyToNotesRoute, createReadAiNotesRoute } from '@neburyx/ee-ask';
import { aiNotesResponseSchema, type AiNotesCapability, type AuditEvent, type CopyToNotesResponse, type ElementRefs, type ElementsScope, type ExtensionRequest, type SummaryReading } from '@neburyx/contracts';
import { INVESTIGATION, KEYS } from './rig.js';

const SAVE = { state: 'unsaved', savedAt: null } as const;

/** Whatever the route stores: the entries in the order they were appended. */
interface StoredNotes {
  readonly entries: readonly Record<string, unknown>[];
  readonly appended: number;
}

export interface NotesRig {
  readonly stored: StoredNotes;
  /** The audit events the copy recorded. */
  readonly events: AuditEvent[];
  /** Copies a token as the person who generated it (a viewer-role person copies nothing). */
  copy(token: string, over?: Partial<ExtensionRequest>): Promise<CopyToNotesResponse>;
  /** Reads the stored notes as a viewer whose access is the given reading; `asked` collects what each batch asked for. */
  read(reading: SummaryReading, options?: { readonly mask?: boolean; readonly asked?: ElementRefs[]; readonly scopes?: ElementsScope[]; readonly maxRefs?: number }): Promise<ReturnType<typeof aiNotesResponseSchema.parse>>;
}

const request = (over: Partial<ExtensionRequest>, aiNotes: AiNotesCapability): ExtensionRequest => ({
  principalId: 'analyst-1',
  principalRole: 'investigator',
  previewOn: true,
  traceId: 'tr-1',
  audit: { record: async () => undefined },
  askClassifier: { availability: () => ({ available: false, reason: 'x' }), classify: async () => ({ status: 'failed' }) } as never,
  caseSummarizer: { maxElements: 300, availability: () => ({ available: true }), summarize: async () => ({ status: 'timeLimit', calls: 1 }) },
  policyVersion: () => 'policy-1',
  signal: new AbortController().signal,
  investigation: { id: INVESTIGATION, sourceId: 'demo' },
  aiNotes,
  ...over,
});

/** The real copy and read routes over an in-memory notes capability: no network and no database. */
export function startNotesRig(options: { readonly createCopyRoute?: typeof createCopyToNotesRoute } = {}): NotesRig {
  const entries: Record<string, unknown>[] = [];
  let appended = 0;
  const events: AuditEvent[] = [];
  let version = 1;
  const aiNotes: AiNotesCapability = {
    async append(call) {
      if (entries.some((entry) => entry['tokenId'] === call.entry.tokenId)) return { outcome: 'already-stored', version, save: SAVE };
      entries.push(JSON.parse(JSON.stringify(call.entry)) as Record<string, unknown>);
      appended += 1;
      version += 1;
      return { outcome: 'appended', version, save: SAVE };
    },
    async canWrite() {
      return undefined;
    },
    async read() {
      return { entries, version, save: SAVE };
    },
  };
  const copyRoute = (options.createCopyRoute ?? createCopyToNotesRoute)({ tokenKeys: () => KEYS });
  return {
    stored: {
      get entries() {
        return entries;
      },
      get appended() {
        return appended;
      },
    },
    events,
    copy: async (token, over = {}) => (await copyRoute.handler(request({ body: { summaryToken: token, version }, audit: { record: async (event) => void events.push(event) }, ...over }, aiNotes))) as CopyToNotesResponse,
    read: async (reading, options = {}) => {
      const route = createReadAiNotesRoute({ maxRefs: () => options.maxRefs ?? 300 });
      const answer = await route.handler(
        request(
          {
            principalId: 'viewer-1',
            principalRole: 'viewer',
            query: { mask: options.mask === true ? 'true' : 'false' },
            investigationReadable: async () => undefined,
            askSourceReadable: async () => undefined,
            readElements: async (scope, refs) => {
              options.scopes?.push(scope);
              options.asked?.push(refs);
              return reading;
            },
          },
          aiNotes,
        ),
      );
      return aiNotesResponseSchema.parse(answer);
    },
  };
}

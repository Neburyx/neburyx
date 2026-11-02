import type { SourceModel } from '../mapping/model.js';

/** What the write probe found: the statement was accepted, the server refused it for the login, or neither could be shown. */
export type ProbeAnswer = 'can-write' | 'cannot-write' | 'inconclusive';

/** Runs the write probe for a source; only the `test-source` command gives the tester one. */
export type WriteProbe = (source: SourceModel, traceId: string) => Promise<ProbeAnswer>;

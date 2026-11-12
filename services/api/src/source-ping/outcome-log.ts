import type { PingResult } from './ping.js';

export interface PingOutcomeLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** A source skipped on this many ticks in a row is reported at `warn`, once. */
const SKIPPED_WARN_STREAK = 2;

interface Last {
  readonly kind: 'reachable' | 'unreachable' | 'skipped';
  readonly detail: string | null;
  readonly streak: number;
}

/** Writes one line for a source when its ping outcome differs from the tick before; fields hold fixed tags and the source ID, never a message or a credential. */
export function createPingOutcomeLog(logger: PingOutcomeLogger): (results: readonly PingResult[]) => void {
  const last = new Map<string, Last>();
  const message = 'source ping outcome';
  return (results) => {
    for (const result of results) {
      const kind = result.skipped ? 'skipped' : result.current === 'reachable' ? 'reachable' : 'unreachable';
      const detail = result.skipped ? result.cause : result.failure;
      const before = last.get(result.sourceId);
      const sameKind = before !== undefined && before.kind === kind;
      const same = sameKind && (kind === 'skipped' || before.detail === detail);
      const streak = same ? before.streak + 1 : 1;
      last.set(result.sourceId, { kind, detail, streak });
      if (kind === 'reachable' && !same) logger.info({ event: 'source.ping_outcome', sourceId: result.sourceId, outcome: kind }, message);
      else if (kind === 'unreachable' && !same) logger.warn({ event: 'source.ping_outcome', sourceId: result.sourceId, outcome: kind, failure: detail }, message);
      else if (kind === 'skipped' && streak === 1) logger.info({ event: 'source.ping_outcome', sourceId: result.sourceId, outcome: kind, cause: detail }, message);
      else if (kind === 'skipped' && streak === SKIPPED_WARN_STREAK) logger.warn({ event: 'source.ping_outcome', sourceId: result.sourceId, outcome: kind, cause: detail }, message);
    }
  };
}

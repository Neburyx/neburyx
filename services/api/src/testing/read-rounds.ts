import type { Gate, IndexReader } from '../gate/types.js';

/** How long the requests of a round are given to arrive before the round is counted. */
const SETTLE_MS = 20;

/**
 * Counts how many times a request waits for the source one read after another: every read of the gate and every read of the indexes is held until no more arrive, then all that are held are let go as one round.
 */
export function inRounds(parts: { readonly gate: Gate; readonly indexes: IndexReader }) {
  let held: (() => void)[] = [];
  const hold = async <T>(read: () => Promise<T>): Promise<T> => {
    await new Promise<void>((release) => held.push(release));
    return await read();
  };
  const gate: Gate = {
    run: (request) => hold(() => parts.gate.run(request)),
    runMany: (requests) => hold(() => parts.gate.runMany(requests)),
    fileQuery: (request) => hold(() => parts.gate.fileQuery(request)),
  };
  const indexes: IndexReader = { read: (request) => hold(() => parts.indexes.read(request)) };
  return {
    gate,
    indexes,
    async roundsOf<T>(request: () => Promise<T>): Promise<{ readonly rounds: number; readonly answer: T }> {
      let done = false;
      const answered = request().finally(() => {
        done = true;
      });
      let rounds = 0;
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const round = held;
        held = [];
        if (round.length > 0) rounds += 1;
        for (const release of round) release();
      }
      return { rounds, answer: await answered };
    },
  };
}

import { start, type StartIo, type StartResult } from './start.js';

export interface Signals {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export interface ShutdownTimes {
  readonly graceMs: number;
  readonly deadlineMs: number;
}

export const SHUTDOWN_TIMES: ShutdownTimes = { graceMs: 2000, deadlineMs: 4000 };

export async function serve(
  env: Readonly<Record<string, string | undefined>>,
  io: StartIo,
  signals: Signals,
  times: ShutdownTimes = SHUTDOWN_TIMES,
): Promise<StartResult> {
  const result = await start(env, io);
  if (result.exitCode !== 0) {
    signals.exit(result.exitCode);
    return result;
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const dropRequests = setTimeout(() => result.app.server.closeAllConnections(), times.graceMs);
    const giveUp = setTimeout(() => signals.exit(1), times.deadlineMs);
    const finish = (code: number): void => {
      clearTimeout(dropRequests);
      clearTimeout(giveUp);
      signals.exit(code);
    };
    result.app.close().then(
      () => finish(0),
      () => finish(1),
    );
  };
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
  return result;
}

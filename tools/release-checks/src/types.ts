export type CheckStatus = 'passed' | 'failed';

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** True for a clean-up that must still run after an interrupt. */
  readonly ignoreInterrupt?: boolean;
}

export interface ExecResult {
  /** Null when the program did not exit on its own (not started, timed out or interrupted). */
  readonly exitCode: number | null;
  readonly output: string;
  readonly startError?: string;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
}

export type Exec = (request: ExecRequest) => Promise<ExecResult>;

export interface CheckContext {
  readonly exec: Exec;
  readonly signal: AbortSignal;
  readonly repoRoot: string;
  readonly commit: string;
  readonly monotonicNowMs: () => number;
  /** A folder the check may write files into; it lives next to the run's logs. */
  readonly workDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  /** Everything the check printed, saved as its log. */
  readonly output: string;
  /** Figures and parts the check wants in the record. */
  readonly data?: unknown;
}

export interface Check {
  readonly id: string;
  readonly name: string;
  /** Shown in the record when the check fails before it can name a command. */
  readonly command: string;
  readonly run: (context: CheckContext) => Promise<CheckOutcome>;
}

export interface CheckResult {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly status: CheckStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly detail: string;
  readonly log: string;
  readonly data?: unknown;
}

export interface RunEnvironment {
  readonly node: string;
  readonly pnpm: string;
  readonly docker: string;
}

export interface RunRecord {
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** The full 40-character commit. */
  readonly commit: string;
  readonly result: 'PASS' | 'FAIL';
  readonly treeClean: boolean;
  readonly environment: RunEnvironment;
  readonly checks: readonly CheckResult[];
}

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
}
export interface Deps {
  readonly exec: (tool: string, args: readonly string[], options: { readonly capture?: boolean }) => ExecResult;
  readonly readFile: (path: string) => string;
  readonly listDir: (path: string) => readonly string[];
  readonly makeTempDir: () => string;
  readonly removeDir: (path: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchRuns: (url: string, token: string | undefined) => Promise<{ readonly status: number; readonly body: unknown }>;
}
export type ParsedArgs =
  | { readonly ok: true; readonly tag: string; readonly mode: 'dry-run' | 'push' | 'check-target' | 'check-ci' }
  | { readonly ok: false; readonly message: string };
export interface Target {
  readonly registry: string;
  readonly image: string;
}
export const TAG_RULE: RegExp;
export const TOKEN_PREFIX: string;
export const SCAN_BLOB: string;
export const TARGET_FILE: string;
export const PLATFORMS: string;
export function parseArgs(argv: readonly string[]): ParsedArgs;
export function tagProblem(tag: string): string | undefined;
export function versionOf(tag: string): string;
export function readTarget(readFile: (path: string) => string): { readonly target: Target } | { readonly problem: string };
export function imageReference(target: Target, tag: string): string;
export function buildCommand(archive: string): readonly [string, readonly string[]];
export function platformCheckCommand(archive: string): readonly [string, readonly string[]];
export function pushCommand(archive: string, digestFile: string, reference: string): readonly [string, readonly string[]];
export function archiveIndexDigest(readFile: (path: string) => string): string | undefined;
export function run(argv: readonly string[], deps: Deps): number;
export function checkCi(argv: readonly string[], deps: Deps): Promise<number>;
export function main(argv: readonly string[], deps: Deps): Promise<number>;

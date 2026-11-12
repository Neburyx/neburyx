export interface Exec {
  (tool: string, args: readonly string[]): { readonly status: number; readonly stdout: string };
}
export interface ParsedStep {
  readonly filters: readonly string[];
  readonly guarded: boolean;
  readonly command: string | undefined;
}
export interface BuildStep {
  readonly script: string;
  readonly selectors: readonly string[];
}
export function stepsOf(command: string): readonly string[];
export function withSharedPrebuild(scripts: Readonly<Record<string, string>>, command: string): string;
export function parseStep(step: string): ParsedStep;
export function isBuildCommand(command: string | undefined): boolean;
export function buildSteps(scripts: Readonly<Record<string, string>>): readonly BuildStep[];
export function packagesOf(step: BuildStep, resolve: (selector: string) => readonly string[]): readonly string[];
export function resolveWithPnpm(selector: string, exec?: (tool: string, args: readonly string[], options: { encoding: 'utf8' }) => { status: number | null; stdout: string; stderr: string }): readonly string[];
export function readScripts(revision: string | undefined, exec: Exec): Readonly<Record<string, string>>;

export interface Exec {
  (tool: string, args: readonly string[]): { readonly status: number; readonly stdout: string };
}
export function classify(paths: readonly string[] | undefined): { readonly image: boolean; readonly quickstart: boolean };
export function changedBetween(base: string | undefined, head: string | undefined, exec: Exec): readonly string[] | undefined;
export function run(argv: readonly string[], exec: Exec, write: (text: string) => void, report?: (text: string) => void): number;
